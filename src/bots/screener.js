// BOT 1 — SCREENING
//
// Its only job is to see coins and write down what it saw. Every coin, at any age: one that
// migrated to an AMM a minute ago and one that launched a month ago and has been quiet since. It
// has no opinion about any of them — that is bot 2's job — so nothing here rejects a coin.
//
// Where the coins come from:
//   PumpPortal websocket  — brand-new launches and migrations, pushed the moment they happen
//   GeckoTerminal sweep   — pages of new / trending / top-volume pools, walked round-robin
//   DexScreener refresh   — fresh numbers for the coins bot 2 and bot 3 are still interested in
//
// This is how a month-old coin gets screened again: when it wakes up, its volume carries it back
// onto the trending and top-volume pages, so the sweep picks it up with current numbers and hands
// it to bot 2 — which is free to turn it green today after calling it red for weeks.
//
// Every coin it screens goes to data/bot1-screened.jsonl. A coin is logged the first time it is
// seen and then at most once a minute, so a few hundred coins a minute stays readable.

import { DISCOVERY_JOBS, DISCOVERY_PAGE_COUNT, isMemecoinPool } from "../discovery.js";
import { createMeter } from "../meter.js";

const LOG_REPEAT_MS = 60_000;
const RECENT_KEPT = 40;

export function createScreener({ config, universe, feed, journal, devBook, log, note, onScreened }) {
  const meter = createMeter(); // every sighting: how much work bot 1 is doing
  const newMeter = createMeter(); // coins seen for the first time
  const stats = {
    observations: 0, // every sighting, including re-sightings of the same coin
    coins: 0, // distinct coins screened since start
    launches: 0,
    migrations: 0,
    sweeps: 0,
    sweepRows: 0,
    refreshed: 0,
  };
  const sources = {}; // source name -> sightings
  const recent = []; // newest first, for the dashboard
  const lastLoggedAt = new Map();
  const priority = new Set(); // mints bot 3 wants watched closely
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

  // One sighting of one coin: into the registry, into the log, on to bot 2.
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
      journal.write({
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

    onScreened?.(record, { firstSighting, source, now });
    return record;
  }

  // ---------- PumpPortal: coins that are seconds old ----------
  function onLaunch(event) {
    const mint = typeof event.mint === "string" ? event.mint : "";
    if (!mint) return;
    stats.launches += 1;
    // The launch event is the only place the creator's wallet appears; the dev book remembers it so
    // bot 2 can recognise a wallet that launches a coin a day or rugged one before.
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
    if (record) note("candidate", `Koin migrasi ke pool AMM: ${record.symbol || record.mint.slice(0, 8)} masuk screening.`, record.mint);
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
        priceChangeH1: pool.priceChangeH1,
        priceChangeH24: pool.priceChangeH24,
      }, `gecko:${job.kind}`);
    }
  }

  // ---------- DexScreener: fresh numbers for EVERY coin we know ----------
  // Whoever is closest to a decision gets the data first — bot 3's open positions and watchlist,
  // then bot 2's green and watched coins — and then the rotation works through the whole registry,
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
      const state = record.verdict?.state;
      if (state === "green" || state === "watch") add(record.mint);
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
      const state = record.verdict?.state;
      if (state !== "green" && state !== "watch" && !priority.has(record.mint)) continue;
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
            .catch((error) => log(`[bot1] sweep error: ${error.message}`))
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
          log(`[bot1] refresh error: ${error.message}`);
        }
        if (!stopping) refreshTimer = setTimeout(refreshLoop, config.refreshIntervalMs);
      };
      discoveryTimer = setTimeout(discoveryLoop, 1000);
      refreshTimer = setTimeout(refreshLoop, 2000);
      log(`[bot1] Screening every coin, any age: ${DISCOVERY_PAGE_COUNT} GeckoTerminal pages round-robin at ${config.geckoCallsPerMinute} calls/min, evenly paced + every known coin re-checked on DexScreener at ${Math.round(refreshesPerMinute())} coins/min. Log: data/bot1-screened.jsonl`);
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
        recent: recent.slice(0, 25),
      };
    },
  };
}
