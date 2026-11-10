// The shared registry between the three bots: every coin bot 1 has screened, plus the rolling
// snapshots bot 2 and bot 3 read. One record per mint.
//
// Bot 1 writes (observe), bot 2 and bot 3 only read. The registry is bounded: when it is full the
// coins seen longest ago are dropped first, so screening hundreds of coins a minute for days cannot
// grow memory without limit. A coin bot 2 made green or bot 3 holds is pinned and never dropped.

const SNAPSHOT_MIN_GAP_MS = 1000;

// Fields where 0 is not a measurement but a missing value: both DexScreener and GeckoTerminal
// report an unknown market cap, pool size or price as 0 as often as they report null. A volume or
// trade count of 0, by contrast, is real information (a quiet hour), so those are not in here.
const ZERO_MEANS_UNKNOWN = new Set(["marketCapUsd", "liquidityUsd", "priceUsd", "priceSol"]);

function keep(target, source, keys) {
  for (const key of keys) {
    const value = source[key];
    // undefined means "this source does not know"; null means "reported as unknown". Neither may
    // overwrite a value another source already filled in.
    if (value === undefined || value === null) continue;
    if (value === 0 && ZERO_MEANS_UNKNOWN.has(key)) continue;
    target[key] = value;
  }
}

const NUMERIC_FIELDS = [
  "volumeH1Usd", "volumeH24Usd",
  "buysH1", "sellsH1", "tradesH1", "buyersH1",
  "priceChangeM5", "priceChangeH1", "priceChangeH24",
  "priceSol",
];
const TEXT_FIELDS = ["pool", "symbol", "name", "creator"];

// Market cap, liquidity and price must come from ONE source per coin. GeckoTerminal reports
// market_cap_usd falling back to FDV, DexScreener reports marketCap falling back to FDV, and for
// the same coin those two can differ by a factor of ten. Mixing them invents a crash that never
// happened — which is exactly the kind of thing bot 3 would try to trade. DexScreener wins because
// it is the source the bots poll fastest; a GeckoTerminal row only fills the gap until then.
const PRICED_FIELDS = ["marketCapUsd", "liquidityUsd", "priceUsd"];
const SOURCE_RANK = { dexscreener: 2 };
const rank = (source) => SOURCE_RANK[source] ?? 1;

export function createUniverse({ maxTokens = 20_000, maxSnapshots = 40 } = {}) {
  const tokens = new Map();

  function evictIfFull() {
    if (tokens.size <= maxTokens) return;
    const dropCount = Math.max(1, Math.floor(maxTokens * 0.05));
    const oldest = [...tokens.values()]
      .filter((record) => !record.pinned)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt)
      .slice(0, dropCount);
    for (const record of oldest) tokens.delete(record.mint);
  }

  return {
    get size() {
      return tokens.size;
    },

    get(mint) {
      return tokens.get(mint) ?? null;
    },

    values() {
      return tokens.values();
    },

    // Records one sighting of a coin. `update.mint` is required; every other field is optional,
    // because the sources know different things (a PumpPortal launch has a name and nothing else,
    // a GeckoTerminal row has volume and age, a DexScreener snapshot has prices and socials).
    observe(update, now = Date.now()) {
      const mint = typeof update.mint === "string" ? update.mint : "";
      if (!mint) return null;

      let record = tokens.get(mint);
      if (!record) {
        record = {
          mint,
          pool: "",
          symbol: "",
          name: "",
          firstSeenAt: now,
          lastSeenAt: now,
          sources: {},
          observations: 0,
          snapshots: [], // [{ at, marketCapUsd, volumeH1Usd }] — this bot's own measurements
          socials: null,
          holders: null,
          verdict: null, // set by bot 2
          pinned: false, // set by bot 2 / bot 3 for coins they still care about
          marketCapSource: "",
          // Bumped whenever the market cap starts coming from a different source. Bot 3 watches
          // this: a new yardstick means its measurements have to start again.
          marketCapEpoch: 0,
        };
        tokens.set(mint, record);
        evictIfFull();
      }

      record.lastSeenAt = now;
      record.observations += 1;
      if (update.source) record.sources[update.source] = (record.sources[update.source] ?? 0) + 1;
      keep(record, update, TEXT_FIELDS);
      keep(record, update, NUMERIC_FIELDS);

      // Priced fields only move to a source at least as trustworthy as the one in place.
      const source = update.source ?? "";
      if (!record.marketCapSource || rank(source) >= rank(record.marketCapSource)) {
        const before = record.marketCapUsd;
        keep(record, update, PRICED_FIELDS);
        if (record.marketCapUsd !== before && Number.isFinite(record.marketCapUsd)) {
          if (record.marketCapSource && record.marketCapSource !== source) {
            // A different yardstick: the history measured with the old one is not comparable.
            record.snapshots = [];
            record.marketCapEpoch += 1;
          }
          record.marketCapSource = source;
        }
      }
      if (update.socials) {
        record.socials = { ...(record.socials ?? {}), ...update.socials };
      }
      // Age is kept as a birth time, not a number of seconds, so it keeps counting up between
      // sightings. A stale listing reporting a younger age must not rejuvenate the coin, so the
      // earliest birth time any source reported wins.
      if (Number.isFinite(update.ageSeconds)) {
        const bornAt = now - update.ageSeconds * 1000;
        record.bornAt = Number.isFinite(record.bornAt) ? Math.min(record.bornAt, bornAt) : bornAt;
      }
      if (Number.isFinite(record.bornAt)) record.ageSeconds = Math.floor((now - record.bornAt) / 1000);

      if (Number.isFinite(record.marketCapUsd)) {
        const last = record.snapshots[record.snapshots.length - 1];
        if (!last || now - last.at >= SNAPSHOT_MIN_GAP_MS) {
          record.snapshots.push({
            at: now,
            marketCapUsd: record.marketCapUsd,
            volumeH1Usd: Number.isFinite(record.volumeH1Usd) ? record.volumeH1Usd : null,
          });
          if (record.snapshots.length > maxSnapshots) record.snapshots.shift();
        }
      }
      return record;
    },

    // How old the coin is right now, from the birth time a source implied.
    ageSeconds(record, now = Date.now()) {
      if (!Number.isFinite(record?.bornAt)) return null;
      return Math.floor((now - record.bornAt) / 1000);
    },

    pin(mint, pinned) {
      const record = tokens.get(mint);
      if (record) record.pinned = Boolean(pinned);
    },
  };
}
