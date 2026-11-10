// Discovery of tokens that are ALREADY trading (1 hour .. 30 days old) for the young / veteran lanes.
// Source: GeckoTerminal public API (no key, 30 calls/minute for everything that uses it, so every call
// goes through a shared budget). It lists what GeckoTerminal ranks (trending / top pools), not every
// token in existence: pools nobody trades never show up, which is fine for this purpose.

import { laneForAge } from "./lanes.js";

const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

// Pools whose base token is one of these are not memecoins; they are skipped.
export const EXCLUDED_BASE_MINTS = new Set([
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// Worked through round-robin, one call per discovery tick.
export const DISCOVERY_JOBS = [
  { kind: "trending", page: 1 },
  { kind: "top", page: 1 },
  { kind: "trending", page: 2 },
  { kind: "top", page: 2 },
  { kind: "top", page: 3 },
  { kind: "trending", page: 3 },
  { kind: "top", page: 4 },
  { kind: "top", page: 5 },
];

// Sliding-window limiter shared by every GeckoTerminal call (discovery, refresh, unique-buyer checks).
export function createBudget(callsPerMinute, now = () => Date.now()) {
  const stamps = [];
  const prune = () => {
    const t = now();
    while (stamps.length && t - stamps[0] >= 60_000) stamps.shift();
  };
  return {
    tryTake() {
      prune();
      if (stamps.length >= callsPerMinute) return false;
      stamps.push(now());
      return true;
    },
    used() {
      prune();
      return stamps.length;
    },
  };
}

async function getJson(url, fetchImpl, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (res.status === 429) {
      const error = new Error("GeckoTerminal rate limited (429)");
      error.rateLimited = true;
      throw error;
    }
    if (!res.ok) throw new Error(`GeckoTerminal HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchGeckoPools(job, fetchImpl = fetch) {
  const path = job.kind === "trending" ? "trending_pools" : job.kind === "new" ? "new_pools" : "pools";
  const data = await getJson(`${GECKO}/${path}?page=${job.page ?? 1}`, fetchImpl);
  return Array.isArray(data?.data) ? data.data : [];
}

// Up to 30 pool addresses per call.
export async function fetchGeckoPoolsMulti(addresses, fetchImpl = fetch) {
  if (!addresses.length) return [];
  const data = await getJson(`${GECKO}/pools/multi/${addresses.slice(0, 30).join(",")}`, fetchImpl);
  return Array.isArray(data?.data) ? data.data : [];
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mintFromId(id) {
  return typeof id === "string" && id.startsWith("solana_") ? id.slice("solana_".length) : "";
}

// Turns one GeckoTerminal pool object into the fields the bot uses. Missing data becomes null
// (unknown) instead of 0, so unknown never looks like "bad". Returns null for unusable rows.
export function parseGeckoPool(row, nowMs = Date.now()) {
  const a = row?.attributes;
  if (!a || typeof a !== "object") return null;
  const mint = mintFromId(row.relationships?.base_token?.data?.id);
  const quoteMint = mintFromId(row.relationships?.quote_token?.data?.id);
  const createdAtMs = a.pool_created_at ? Date.parse(a.pool_created_at) : Number.NaN;
  const h1 = a.transactions?.h1 ?? {};
  const buys = num(h1.buys);
  const sells = num(h1.sells);
  return {
    pool: typeof a.address === "string" ? a.address : "",
    mint,
    quoteMint,
    name: typeof a.name === "string" ? a.name : "",
    symbol: typeof a.name === "string" ? a.name.split(" / ")[0].slice(0, 24) : "",
    ageSeconds: Number.isFinite(createdAtMs) ? Math.max(0, Math.floor((nowMs - createdAtMs) / 1000)) : null,
    liquidityUsd: num(a.reserve_in_usd),
    // market_cap_usd is null for unverified tokens; FDV is the usual stand-in.
    marketCapUsd: num(a.market_cap_usd) ?? num(a.fdv_usd),
    volumeH1Usd: num(a.volume_usd?.h1),
    volumeH24Usd: num(a.volume_usd?.h24),
    priceChangeH1: num(a.price_change_percentage?.h1),
    priceChangeH24: num(a.price_change_percentage?.h24),
    buysH1: buys,
    tradesH1: buys !== null && sells !== null ? buys + sells : null,
    buyersH1: num(h1.buyers),
  };
}

// Decides what to do with a discovered pool. Returns { lane, reject? } or null when the pool is not
// relevant to any lane at all (wrong quote token, wrong age, not a memecoin).
//   reject = { category, detail } means "looked at it and said no" (counted, then put on cooldown).
export function assessPool(pool, lanes) {
  if (!pool?.mint || !pool.pool) return null;
  if (pool.quoteMint !== SOL_MINT || EXCLUDED_BASE_MINTS.has(pool.mint)) return null;
  const laneId = laneForAge(pool.ageSeconds);
  if (!laneId || !lanes[laneId]?.enabled) return null;
  const cfg = lanes[laneId].cfg;

  if (pool.marketCapUsd !== null && (pool.marketCapUsd < cfg.minMarketCapUsd || pool.marketCapUsd > cfg.maxMarketCapUsd)) {
    return { lane: laneId, reject: { category: "market_cap", detail: `market cap $${Math.round(pool.marketCapUsd).toLocaleString("en-US")} outside the ${laneId} range` } };
  }
  if (pool.liquidityUsd !== null && cfg.minLiquidityUsd > 0 && pool.liquidityUsd < cfg.minLiquidityUsd) {
    return { lane: laneId, reject: { category: "liquidity", detail: `liquidity $${Math.round(pool.liquidityUsd).toLocaleString("en-US")} below $${Math.round(cfg.minLiquidityUsd).toLocaleString("en-US")}` } };
  }
  if (pool.volumeH1Usd !== null && cfg.minVolumeH1Usd > 0 && pool.volumeH1Usd < cfg.minVolumeH1Usd) {
    return { lane: laneId, reject: { category: "volume", detail: `1h volume $${Math.round(pool.volumeH1Usd).toLocaleString("en-US")} below $${Math.round(cfg.minVolumeH1Usd).toLocaleString("en-US")}` } };
  }
  return { lane: laneId };
}
