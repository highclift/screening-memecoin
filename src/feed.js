// The one place that talks to the outside world, so the three bots never fight over a rate limit.
//
//   PumpPortal websocket : brand-new launches and AMM migrations, pushed, free, no key needed
//   GeckoTerminal        : pages of pools at any age (bot 1's sweep) — 30 calls/minute, shared
//   DexScreener          : market cap / liquidity / volume / buys / socials, 30 coins per call
//
// Every GeckoTerminal call passes through one budget and one backoff, whichever bot asked for it.
// DexScreener has no key and a far higher limit, so it is only backed off when it says 429.

import WebSocket from "ws";
import { createBudget, fetchGeckoPools, fetchGeckoPoolsMulti, parseGeckoPool } from "./discovery.js";
import { fetchDexSnapshots, fetchSolUsdPrice } from "./pricefeed.js";

const WS_BASE = process.env.PUMPPORTAL_WS_URL || "wss://pumpportal.fun/api/data";

export function createFeed({ config, log, onLaunch, onMigration, onConnectionChange }) {
  const budget = createBudget(config.geckoCallsPerMinute);
  let socket = null;
  let reconnectTimer = null;
  let solUsdTimer = null;
  let reconnectDelayMs = 1000;
  let stopping = false;
  let solUsdPrice = null;
  let geckoBackoffUntil = 0;
  let dexBackoffUntil = 0;
  let lastErrorLogAt = 0;

  const url = config.apiKey ? `${WS_BASE}?api-key=${encodeURIComponent(config.apiKey)}` : WS_BASE;

  // One error line per 15s per feed: a rate limit or an outage would otherwise bury the bot logs.
  function errorLog(message) {
    const now = Date.now();
    if (now - lastErrorLogAt < 15_000) return;
    lastErrorLogAt = now;
    log(message);
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

    // One page of GeckoTerminal pools, already parsed. Returns [] when the budget is spent or the
    // API is backing us off — the caller just tries again on its next tick.
    async sweep(job, now = Date.now()) {
      if (Date.now() < geckoBackoffUntil || !budget.tryTake()) return [];
      try {
        const rows = await fetchGeckoPools(job);
        return rows.map((row) => parseGeckoPool(row, now)).filter(Boolean);
      } catch (error) {
        if (error.rateLimited) geckoBackoffUntil = Date.now() + 60_000;
        errorLog(`[feed] GeckoTerminal ${job.kind} page ${job.page} failed: ${error.message}`);
        return [];
      }
    },

    // Up to 30 known pools in one call, used to keep a coin's 1h buyer count current.
    async pools(addresses, now = Date.now()) {
      if (!addresses.length || Date.now() < geckoBackoffUntil || !budget.tryTake()) return [];
      try {
        const rows = await fetchGeckoPoolsMulti(addresses);
        return rows.map((row) => parseGeckoPool(row, now)).filter(Boolean);
      } catch (error) {
        if (error.rateLimited) geckoBackoffUntil = Date.now() + 60_000;
        errorLog(`[feed] GeckoTerminal pool refresh failed: ${error.message}`);
        return [];
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
