// The one place that talks to the outside world, so the three bots never fight over a rate limit.
//
//   PumpPortal websocket : brand-new launches and AMM migrations, pushed, free, no key needed
//   GeckoTerminal        : pages of pools at any age (bot 1's sweep) — 30 calls/minute, shared
//   DexScreener          : market cap / liquidity / volume / buys / socials, 30 coins per call
//
// Every GeckoTerminal call passes through one budget and one backoff, whichever bot asked for it.
// DexScreener has no key and a far higher limit, so it is only backed off when it says 429.

import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { createBudget, fetchGeckoPools, fetchGeckoPoolsMulti, parseGeckoPool } from "./discovery.js";
import { fetchDexSnapshots, fetchSolUsdPrice, fetchUniqueBuyers } from "./pricefeed.js";

const WS_BASE = process.env.PUMPPORTAL_WS_URL || "wss://pumpportal.fun/api/data";
const COLD_START_RATE = 8; // what to try before anything is known about this network

// The rate GeckoTerminal actually allowed last time, remembered so a restart does not have to
// rediscover it by getting refused all over again.
function loadFeedState(filePath) {
  if (!filePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveFeedState(filePath, state) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, "utf8");
  } catch {
    // Remembering the rate is a convenience, never a reason to stop trading.
  }
}

export function createFeed({
  config,
  log,
  onLaunch,
  onMigration,
  onConnectionChange,
  stateFile = path.resolve("data", "feed-state.json"),
}) {
  const remembered = loadFeedState(stateFile);
  const clampRate = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(config.geckoCallsPerMinute, Math.max(config.geckoMinCallsPerMinute, Math.round(n)));
  };
  // Start where the last run ended up, else conservatively.
  let geckoRateCeiling = clampRate(remembered.geckoSafeRate, Math.min(config.geckoCallsPerMinute, COLD_START_RATE));
  const startRate = clampRate(remembered.geckoRate, geckoRateCeiling);

  // Evenly paced: one call every 60s/rate, never a burst.
  const budget = createBudget(startRate, () => Date.now(), {
    minIntervalMs: Math.ceil(60_000 / startRate),
  });
  let socket = null;
  let reconnectTimer = null;
  let solUsdTimer = null;
  let reconnectDelayMs = 1000;
  let stopping = false;
  let solUsdPrice = null;
  let geckoBackoffUntil = 0;
  let geckoPauses = 0; // consecutive pauses, so a stubborn limit backs off further each time
  let lastGecko429At = -Infinity;
  let lastSpeedUpAt = 0;
  let dexBackoffUntil = 0;
  let lastErrorLogAt = 0;

  const url = config.apiKey ? `${WS_BASE}?api-key=${encodeURIComponent(config.apiKey)}` : WS_BASE;

  // One error line per 15s per feed: an outage would otherwise bury the bot logs.
  function errorLog(message) {
    const now = Date.now();
    if (now - lastErrorLogAt < 15_000) return;
    lastErrorLogAt = now;
    log(message);
  }

  // Being rate limited is not an error, it is a speed limit — and not the documented one: what a
  // given IP actually gets is lower and varies. So the feed finds the limit instead of assuming it,
  // halving its rate every time it is refused and creeping back up while it is not. Several calls
  // can be in flight when a 429 lands, so one episode is announced once and the calls still in the
  // air only extend the pause.
  function rememberRate() {
    saveFeedState(stateFile, { geckoRate: budget.rate(), geckoSafeRate: geckoRateCeiling, at: new Date().toISOString() });
  }

  function geckoRateLimited() {
    const now = Date.now();
    if (now < geckoBackoffUntil) return; // already paused by the call before this one
    geckoPauses += 1;
    lastGecko429At = now;
    const pauseMs = Math.min(30_000 * geckoPauses, 180_000);
    geckoBackoffUntil = now + pauseMs;
    // The rate that just got refused is now known to be too fast: never creep back up to it.
    geckoRateCeiling = Math.max(config.geckoMinCallsPerMinute, budget.rate() - 1);
    budget.setRate(Math.max(config.geckoMinCallsPerMinute, Math.floor(budget.rate() / 2)));
    rememberRate();
    log(`[feed] GeckoTerminal rate limited; pausing coin discovery for ${Math.round(pauseMs / 1000)}s and slowing to ${budget.rate()} calls/min (DexScreener and the launch feed keep running).`);
  }

  function geckoWorked() {
    geckoPauses = 0;
    // Creep back up after a quiet spell, one call a minute at a time, and never past the rate that
    // was refused last time.
    const now = Date.now();
    if (now - lastGecko429At < 120_000 || now - lastSpeedUpAt < 180_000) return;
    lastSpeedUpAt = now;
    if (budget.rate() >= geckoRateCeiling) return;
    budget.setRate(budget.rate() + 1);
    rememberRate();
    if (budget.rate() >= geckoRateCeiling) {
      log(`[feed] GeckoTerminal back at full speed (${budget.rate()} calls/min).`);
    }
  }

  function handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    const txType = String(event.txType ?? "").toLowerCase();
    if (txType === "create") {
      onLaunch?.(event);
    } else if (
      txType === "migrate" || txType === "migration"
      || (typeof event.mint === "string"
        && Boolean(event.pool ?? event.poolAddress ?? event.newPool ?? event.new_pool)
        && txType !== "buy" && txType !== "sell")
    ) {
      onMigration?.(event);
    } else if (txType !== "buy" && txType !== "sell") {
      const payload = (config.apiKey ? JSON.stringify(event).replaceAll(config.apiKey, "[API KEY REDACTED]") : JSON.stringify(event)).slice(0, 300);
      errorLog(`[feed] PumpPortal response: ${payload}`);
    }
  }

  function connect() {
    if (stopping) return;
    socket = new WebSocket(url);
    socket.on("open", () => {
      reconnectDelayMs = 1000;
      try {
        socket.send(JSON.stringify({ method: "subscribeNewToken" }));
        socket.send(JSON.stringify({ method: "subscribeMigration" }));
      } catch (error) {
        log(`[feed] Could not subscribe: ${error.message}`);
      }
      onConnectionChange?.(true);
      log("[feed] PumpPortal connected: new launches and AMM migrations are streaming in.");
    });
    socket.on("message", handleMessage);
    socket.on("error", (error) => errorLog(`[feed] ${error.message}`));
    socket.on("close", () => {
      onConnectionChange?.(false);
      if (stopping) return;
      log(`[feed] PumpPortal disconnected; reconnecting in ${reconnectDelayMs / 1000}s.`);
      reconnectTimer = setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    });
  }

  async function refreshSolUsd() {
    if (stopping) return;
    try {
      solUsdPrice = await fetchSolUsdPrice();
    } catch (error) {
      errorLog(`[feed] SOL/USD refresh failed: ${error.message}`);
    }
    if (!stopping) solUsdTimer = setTimeout(refreshSolUsd, 60_000);
  }

  return {
    start() {
      connect();
      refreshSolUsd();
    },

    stop() {
      stopping = true;
      clearTimeout(reconnectTimer);
      clearTimeout(solUsdTimer);
      socket?.close();
    },

    solUsd() {
      return solUsdPrice;
    },

    geckoCallsUsed() {
      return budget.used();
    },

    // The rate the feed has settled on, which is not necessarily the configured ceiling.
    geckoRate() {
      return budget.rate();
    },

    geckoPausedForMs() {
      return Math.max(0, geckoBackoffUntil - Date.now());
    },

    // May a GeckoTerminal call go out right now? Callers check this before deciding which page to
    // ask for, so a paced-out tick does not burn a page from the rotation.
    canSweep() {
      return Date.now() >= geckoBackoffUntil && budget.ready();
    },

    // One page of GeckoTerminal pools, already parsed. Returns [] when the budget is spent or the
    // API is backing us off — the caller just tries again on its next tick.
    async sweep(job, now = Date.now()) {
      if (Date.now() < geckoBackoffUntil || !budget.tryTake()) return [];
      try {
        const rows = await fetchGeckoPools(job);
        geckoWorked();
        return rows.map((row) => parseGeckoPool(row, now)).filter(Boolean);
      } catch (error) {
        if (error.rateLimited) geckoRateLimited();
        else errorLog(`[feed] GeckoTerminal ${job.kind} page ${job.page} failed: ${error.message}`);
        return [];
      }
    },

    // Up to 30 known pools in one call, used to keep a coin's 1h buyer count current.
    async pools(addresses, now = Date.now()) {
      if (!addresses.length || Date.now() < geckoBackoffUntil || !budget.tryTake()) return [];
      try {
        const rows = await fetchGeckoPoolsMulti(addresses);
        geckoWorked();
        return rows.map((row) => parseGeckoPool(row, now)).filter(Boolean);
      } catch (error) {
        if (error.rateLimited) geckoRateLimited();
        else errorLog(`[feed] GeckoTerminal pool refresh failed: ${error.message}`);
        return [];
      }
    },

    // The wallet addresses that bought in one pool recently. One call for one pool, so it is only
    // worth spending on a coin the analyst is actually scoring — it is what the smart-wallet
    // registry learns from, and the only place the desk sees WHO is buying rather than how many.
    async buyers(poolAddress, sinceMs = 0) {
      if (!poolAddress || Date.now() < geckoBackoffUntil || !budget.tryTake()) return null;
      try {
        const result = await fetchUniqueBuyers(poolAddress, sinceMs);
        geckoWorked();
        return result;
      } catch (error) {
        if (error.rateLimited) geckoRateLimited();
        else errorLog(`[feed] GeckoTerminal trades for ${poolAddress.slice(0, 8)} failed: ${error.message}`);
        return null;
      }
    },

    // Up to 30 mints in one DexScreener call. Returns Map<mint, snapshot>.
    async snapshots(mints) {
      if (!mints.length || Date.now() < dexBackoffUntil) return new Map();
      try {
        const result = await fetchDexSnapshots(mints);
        for (const snap of result.values()) {
          if (Number.isFinite(snap.solUsd) && snap.solUsd > 0) solUsdPrice = snap.solUsd;
        }
        return result;
      } catch (error) {
        if (error.rateLimited) dexBackoffUntil = Date.now() + 15_000;
        errorLog(`[feed] DexScreener poll failed: ${error.message}`);
        return new Map();
      }
    },
  };
}
