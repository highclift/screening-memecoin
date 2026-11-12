// AGENT 1 — SCOUT
//
// Finds coins and decides one thing only: is this one in the window the desk trades at all? Age
// between `minAgeSeconds` and `maxAgeSeconds`, market cap inside the band. Everything else — can it
// pump, is it safe, is it worth buying — belongs to the agents after it.
//
// The window is the whole point of this stage. Under 30 minutes a coin has no history to measure
// and its first candle is bots trading with bots; past 72 hours the launch crowd has gone and what
// is left is a chart, not an event. So the scout keeps watching everything (a 20-minute-old coin
// becomes eligible at 30, a $200k coin becomes eligible when it grows) but only HANDS ON what is
// inside the window.
//
// Where the coins come from:
//   PumpPortal websocket  — brand-new launches and migrations, pushed the moment they happen
//   GeckoTerminal sweep   — pages of new / trending / top-volume pools, walked round-robin
//   DexScreener refresh   — the real on-chain numbers for every coin already known
//
// Every sighting goes to data/scout.jsonl; every coin turned away at the window goes to the kill
// log with the reason. A coin is written the first time it is seen and then at most once a minute.

import { DISCOVERY_JOBS, DISCOVERY_PAGE_COUNT, isMemecoinPool } from "../discovery.js";
import { createMeter } from "../meter.js";

const LOG_REPEAT_MS = 60_000;
const RECENT_KEPT = 40;

const usd = (value) => `$${Math.round(value).toLocaleString("en-US")}`;
const hours = (seconds) => (seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`);

// Is this coin inside the window the desk trades? Returns null when it is, or the reason it is not.
// Missing data is never a reason: a coin whose age or market cap has not been filled in yet is
// simply not handed on this round, and the scout looks again next time it is refreshed.
export function windowReason(record, { minAgeSeconds, maxAgeSeconds, minMarketCapUsd, maxMarketCapUsd }, ageSeconds) {
  const age = Number.isFinite(ageSeconds) ? ageSeconds : null;
  if (age === null) return { category: "no_age", detail: "age not known yet", wait: true };
  if (age < minAgeSeconds) {
    return { category: "too_young", detail: `${hours(age)} old, the desk starts at ${hours(minAgeSeconds)}` };
  }
  if (age > maxAgeSeconds) {
    return { category: "too_old", detail: `${hours(age)} old, past the ${hours(maxAgeSeconds)} window` };
  }

  const mcap = Number.isFinite(record?.marketCapUsd) ? record.marketCapUsd : null;
  if (mcap === null) return { category: "no_mcap", detail: "market cap not known yet", wait: true };
  if (mcap < minMarketCapUsd) return { category: "mcap_low", detail: `${usd(mcap)} below ${usd(minMarketCapUsd)}` };
  if (mcap > maxMarketCapUsd) return { category: "mcap_high", detail: `${usd(mcap)} above ${usd(maxMarketCapUsd)}` };
  return null;
}

export function createScout({ config, universe, feed, logger, devBook, log, note, onScouted }) {
  const meter = createMeter(); // every sighting: how much work bot 1 is doing
  const newMeter = createMeter(); // coins seen for the first time
  const stats = {
    observations: 0, // every sighting, including re-sightings of the same coin
    coins: 0, // distinct coins screened since start
    inWindow: 0, // sightings handed on to the filter
    launches: 0,
    migrations: 0,
    sweeps: 0,
    sweepRows: 0,
    refreshed: 0,
  };
  const windowMisses = {}; // why coins were turned away: category -> count
  const sources = {}; // source name -> sightings
  const recent = []; // newest first, for the dashboard
  const lastLoggedAt = new Map();
  const priority = new Set(); // mints the executor is acting on right now
  let jobIndex = 0;
  let discoveryTimer = null;
  let refreshTimer = null;
  let stopping = false;

  // Coins the DexScreener rotation gets through in a minute, at the configured tick.
  const refreshesPerMinute = () =>
    (config.refreshBatchSize * config.refreshCallsPerTick * 60_000) / config.refreshIntervalMs;

  function remember(record, source) {
    recent.unshift({
      mint: record.mint,
      symbol: record.symbol,
      source,
      ageSeconds: universe.ageSeconds(record),
      marketCapUsd: record.marketCapUsd ?? null,
      liquidityUsd: record.liquidityUsd ?? null,
      volumeH1Usd: record.volumeH1Usd ?? null,
      at: Date.now(),
    });
    if (recent.length > RECENT_KEPT) recent.length = RECENT_KEPT;
  }

  // One sighting of one coin: into the registry, into the log, and — only if it is inside the
  // window — on to the filter.
  function screen(update, source) {
    const now = Date.now();
    const record = universe.observe({ ...update, source }, now);
    if (!record) return null;

    stats.observations += 1;
    sources[source] = (sources[source] ?? 0) + 1;
    meter.hit(1, now);

    const firstSighting = record.observations === 1;
    if (firstSighting) {
      stats.coins += 1;
      newMeter.hit(1, now);
    }

    const loggedAt = lastLoggedAt.get(record.mint) ?? 0;
    if (firstSighting || now - loggedAt >= LOG_REPEAT_MS) {
      lastLoggedAt.set(record.mint, now);
      if (lastLoggedAt.size > config.maxUniverseTokens) {
        // Trim the oldest log stamps; worst case a coin gets logged twice in a minute.
        for (const key of [...lastLoggedAt.keys()].slice(0, 1000)) lastLoggedAt.delete(key);
      }
      logger.sighting({
        type: firstSighting ? "new" : "seen",
        mint: record.mint,
        symbol: record.symbol,
        source,
        ageSeconds: universe.ageSeconds(record, now),
        marketCapUsd: record.marketCapUsd ?? null,
        liquidityUsd: record.liquidityUsd ?? null,
        volumeH1Usd: record.volumeH1Usd ?? null,
        volumeH24Usd: record.volumeH24Usd ?? null,
        buysH1: record.buysH1 ?? null,
        sellsH1: record.sellsH1 ?? null,
        buyersH1: record.buyersH1 ?? null,
        priceChangeH1: record.priceChangeH1 ?? null,
      });
      if (firstSighting) remember(record, source);
    }

    // The handoff. A coin outside the window stays in the registry and keeps being refreshed — it
    // may walk into the window later — but it is not passed on, and the reason is logged.
    //
    // Except for coins the executor is already acting on. The window says what the desk may START
    // trading, never what it may keep watching: a position that collapses falls straight out of the
    // market-cap band, and if that stopped the data reaching the executor the stop would never fire
    // and the rug would be held to the time limit. Which is the exact coin that must be sold first.
    const held = priority.has(record.mint);
    const outside = held ? null : windowReason(record, config.window, universe.ageSeconds(record, now));
    if (outside) {
      windowMisses[outside.category] = (windowMisses[outside.category] ?? 0) + 1;
      if (!outside.wait) logger.kill("scout", record, outside, now);
      return record;
    }

    stats.inWindow += 1;
    onScouted?.(record, { firstSighting, source, now });
    return record;
  }

  // ---------- PumpPortal: coins that are seconds old ----------
  function onLaunch(event) {
    const mint = typeof event.mint === "string" ? event.mint : "";
    if (!mint) return;
    stats.launches += 1;
    // The launch event is the only place the creator's wallet appears; the dev book remembers it so
    // the filter can recognise a wallet that launched a coin a day or rugged one before.
    const creator = typeof event.traderPublicKey === "string" ? event.traderPublicKey : "";
    if (creator) devBook.recordLaunch(creator, mint);
    screen({
      mint,
      name: typeof event.name === "string" ? event.name.slice(0, 80) : undefined,
      symbol: typeof event.symbol === "string" ? event.symbol.slice(0, 24) : undefined,
      ageSeconds: 0,
      creator: creator || undefined,
    }, "launch");
  }

  function onMigration(event) {
    const mint = typeof event.mint === "string" ? event.mint : "";
    if (!mint) return;
    stats.migrations += 1;
    devBook.recordMigration(mint);
    const record = screen({
      mint,
      pool: String(event.pool ?? event.poolAddress ?? event.newPool ?? event.new_pool ?? "") || undefined,
      name: typeof event.name === "string" ? event.name.slice(0, 80) : undefined,
      symbol: typeof event.symbol === "string" ? event.symbol.slice(0, 24) : undefined,
    }, "migration");
    if (record) note("candidate", `Migrated to an AMM pool: ${record.symbol || record.mint.slice(0, 8)} enters screening.`, record.mint);
  }

  // ---------- GeckoTerminal: every pool, any age ----------
  // One page per call, paced by the shared budget rather than by the tick. The page is only taken
  // off the rotation once a call is actually going out, so a paced-out tick costs nothing.
  async function sweepOnce() {
    const job = DISCOVERY_JOBS[jobIndex % DISCOVERY_JOBS.length];
    jobIndex += 1;
    const pools = await feed.sweep(job);
    if (!pools.length) return;
    stats.sweeps += 1;
    stats.sweepRows += pools.length;
    for (const pool of pools) {
      if (!isMemecoinPool(pool)) continue;
      screen({
        mint: pool.mint,
        pool: pool.pool,
        symbol: pool.symbol || undefined,
        name: pool.name || undefined,
        ageSeconds: pool.ageSeconds,
        marketCapUsd: pool.marketCapUsd,
        liquidityUsd: pool.liquidityUsd,
        volumeH1Usd: pool.volumeH1Usd,
        volumeH24Usd: pool.volumeH24Usd,
        buysH1: pool.buysH1,
        sellsH1: pool.tradesH1 !== null && pool.buysH1 !== null ? pool.tradesH1 - pool.buysH1 : null,
        tradesH1: pool.tradesH1,
        buyersH1: pool.buyersH1,
        sellersH1: pool.sellersH1,
        priceChangeH1: pool.priceChangeH1,
        priceChangeH24: pool.priceChangeH24,
      }, `gecko:${job.kind}`);
    }
  }

  // ---------- DexScreener: fresh numbers for EVERY coin we know ----------
  // Whoever is closest to a decision gets the data first — the executor's open positions and
  // watchlist, then everything the filter passed — and then the rotation works through the registry,
  // oldest refresh first.
  //
  // The rotation covering everything is the point. A coin that went quiet is exactly the coin that
  // might wake up, so dropping it from the rotation (as this used to, after 30 minutes idle) meant
  // only GeckoTerminal's rate-limited trending page could ever re-surface it. DexScreener costs one
  // call per 30 coins and has never rate limited us, so there is no reason to forget anybody.
  function refreshTargets(limit) {
    const wanted = [];
    const seen = new Set();
    const add = (mint) => {
      if (!mint || seen.has(mint) || mint.startsWith("DEMO-") || wanted.length >= limit) return;
      seen.add(mint);
      wanted.push(mint);
    };

    for (const mint of priority) add(mint);
    for (const record of universe.values()) {
      if (record.filter?.state === "pass") add(record.mint);
    }
    if (wanted.length >= limit) return wanted;

    // Everything else, least recently refreshed first.
    const rest = [];
    for (const record of universe.values()) {
      if (!seen.has(record.mint)) rest.push(record);
    }
    rest.sort((a, b) => (a.lastRefreshAt ?? 0) - (b.lastRefreshAt ?? 0));
    for (const record of rest) add(record.mint);
    return wanted;
  }

  async function refreshOnce() {
    const perCall = config.refreshBatchSize;
    const mints = refreshTargets(perCall * config.refreshCallsPerTick);
    if (!mints.length) return;
    // Sequential, not parallel: the same burst lesson as GeckoTerminal, and sequential is still
    // thousands of coins a minute.
    for (let i = 0; i < mints.length; i += perCall) {
      await applySnapshots(mints.slice(i, i + perCall));
    }
  }

  async function applySnapshots(mints) {
    const snapshots = await feed.snapshots(mints);
    const now = Date.now();
    // Mark everything asked for, not just what came back: a coin DexScreener does not know about
    // must not be retried on every single tick forever.
    for (const mint of mints) {
      const record = universe.get(mint);
      if (record) record.lastRefreshAt = now;
    }
    for (const [mint, snap] of snapshots) {
      stats.refreshed += 1;
      const buys = Number.isFinite(snap.buysH1) ? snap.buysH1 : null;
      screen({
        mint,
        pool: snap.pool || undefined,
        liquidityUsd: snap.liquidityUsd > 0 ? snap.liquidityUsd : null,
        marketCapUsd: snap.reportedMarketCapUsd,
        priceUsd: snap.solUsd > 0 && snap.reportedMarketCapUsd ? snap.reportedMarketCapUsd / snap.solUsd : null,
        volumeH1Usd: snap.volumeH1 > 0 ? snap.volumeH1 : null,
        volumeH24Usd: snap.volumeH24 > 0 ? snap.volumeH24 : null,
        buysH1: buys,
        sellsH1: buys !== null && Number.isFinite(snap.tradesH1) ? snap.tradesH1 - buys : null,
        tradesH1: snap.tradesH1,
        priceChangeM5: snap.priceChangeM5,
        priceChangeH1: snap.priceChangeH1,
        priceChangeH24: snap.priceChangeH24,
        ageSeconds: snap.pairCreatedAt ? Math.max(0, Math.floor((now - snap.pairCreatedAt) / 1000)) : null,
        socials: snap.socials ?? undefined,
      }, "dexscreener");
    }
  }

  // GeckoTerminal reports the 1h unique buyer count, which DexScreener does not. Bot 2 leans on it
  // for breadth, so the coins close to a decision get their pools refreshed from there too.
  async function refreshBuyers() {
    const targets = [];
    for (const record of universe.values()) {
      if (!record.pool) continue;
      if (record.filter?.state !== "pass" && !priority.has(record.mint)) continue;
      targets.push(record);
    }
    if (!targets.length) return;
    targets.sort((a, b) => (a.lastBuyerCheckAt ?? 0) - (b.lastBuyerCheckAt ?? 0));
    const batch = targets.slice(0, 30);
    const now = Date.now();
    for (const record of batch) record.lastBuyerCheckAt = now;
    const pools = await feed.pools(batch.map((record) => record.pool), now);
    const byPool = new Map(pools.map((pool) => [pool.pool, pool]));
    for (const record of batch) {
      const pool = byPool.get(record.pool);
      if (!pool) continue;
      screen({
        mint: record.mint,
        pool: pool.pool,
        ageSeconds: pool.ageSeconds,
        marketCapUsd: pool.marketCapUsd,
        liquidityUsd: pool.liquidityUsd,
        volumeH1Usd: pool.volumeH1Usd,
        volumeH24Usd: pool.volumeH24Usd,
        buysH1: pool.buysH1,
        tradesH1: pool.tradesH1,
        buyersH1: pool.buyersH1,
        sellersH1: pool.sellersH1,
        priceChangeH1: pool.priceChangeH1,
      }, "gecko:pool");
    }
  }

  return {
    onLaunch,
    onMigration,

    // Bot 3 tells bot 1 which coins it is about to act on, so those get polled every tick.
    prioritize(mints) {
      priority.clear();
      for (const mint of mints) priority.add(mint);
    },

    start() {
      // The tick only asks "may I?"; the budget answers, and it spaces the calls evenly. A call can
      // take several seconds, so the next one is allowed to start while the last is still in the
      // air — up to maxSweepsInFlight, which is the only thing this loop itself limits.
      let sweepsInFlight = 0;
      const discoveryLoop = () => {
        if (stopping) return;
        if (sweepsInFlight < config.maxSweepsInFlight && feed.canSweep()) {
          sweepsInFlight += 1;
          sweepOnce()
            .catch((error) => log(`[scout] sweep error: ${error.message}`))
            .finally(() => {
              sweepsInFlight -= 1;
            });
        }
        discoveryTimer = setTimeout(discoveryLoop, config.discoveryTickMs);
      };
      let buyerTurn = 0;
      const refreshLoop = async () => {
        if (stopping) return;
        try {
          await refreshOnce();
          buyerTurn += 1;
          // One GeckoTerminal call every tenth tick (~3 a minute): buyer counts move slowly, and
          // every call here is one the sweep does not get to make.
          if (buyerTurn % 10 === 0) await refreshBuyers();
        } catch (error) {
          log(`[scout] refresh error: ${error.message}`);
        }
        if (!stopping) refreshTimer = setTimeout(refreshLoop, config.refreshIntervalMs);
      };
      discoveryTimer = setTimeout(discoveryLoop, 1000);
      refreshTimer = setTimeout(refreshLoop, 2000);
      const w = config.window;
      log(`[scout] Window: ${Math.round(w.minAgeSeconds / 60)}m-${Math.round(w.maxAgeSeconds / 3600)}h old, ${usd(w.minMarketCapUsd)}-${usd(w.maxMarketCapUsd)} market cap. Watching wider than that: ${DISCOVERY_PAGE_COUNT} GeckoTerminal pages round-robin at ${config.geckoCallsPerMinute} calls/min + every known coin re-checked on DexScreener at ${Math.round(refreshesPerMinute())} coins/min. Log: data/scout.jsonl`);
    },

    stop() {
      stopping = true;
      clearTimeout(discoveryTimer);
      clearTimeout(refreshTimer);
    },

    status() {
      return {
        ...stats,
        perMinute: meter.perMinute(), // sightings a minute (a coin looked at twice counts twice)
        newPerMinute: newMeter.perMinute(), // coins seen for the first time, a minute
        universeSize: universe.size,
        // How long it takes the rotation to come back round to any given coin: the honest answer
        // to "how fast would we notice an old coin waking up?".
        recheckSeconds: Math.round(universe.size / Math.max(1, refreshesPerMinute()) * 60),
        geckoCallsLastMinute: feed.geckoCallsUsed(),
        geckoRate: feed.geckoRate?.() ?? null, // the rate the feed settled on, not the ceiling
        geckoPausedForMs: feed.geckoPausedForMs?.() ?? 0,
        sources: { ...sources },
        windowMisses: { ...windowMisses },
        window: { ...config.window },
        recent: recent.slice(0, 25),
      };
    },
  };
}
