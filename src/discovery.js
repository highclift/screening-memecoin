// Where bot 1 finds coins that are already trading — at ANY age, from minutes to months old.
//
// Source: GeckoTerminal public API (no key, 30 calls/minute shared by everything that uses it, so
// every call goes through the budget below). One call returns one page of 20 pools; the job list is
// worked through round-robin, so a full sweep sees a few hundred distinct pools and then starts
// again with fresh numbers. It lists what GeckoTerminal ranks (new, trending, top by volume), not
// every token in existence: pools nobody trades at all never show up, which is fine — a coin with
// no trades is not about to pump.

const GECKO = "https://api.geckoterminal.com/api/v2/networks/solana";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

// Pools whose base token is one of these are not memecoins; they are skipped.
export const EXCLUDED_BASE_MINTS = new Set([
  SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

// Worked through round-robin, one call per discovery tick. "new" catches coins minutes old,
// "trending" catches whatever the market is looking at right now, and "top" walks ten pages of the
// highest-volume pools on Solana, which is where a month-old coin that woke up turns up again.
export const DISCOVERY_JOBS = [
  { kind: "new", page: 1 },
  { kind: "trending", page: 1 },
  { kind: "top", page: 1 },
  { kind: "new", page: 2 },
  { kind: "trending", page: 2 },
  { kind: "top", page: 2 },
  { kind: "trending", page: 3 },
  { kind: "top", page: 3 },
  { kind: "trending", page: 4 },
  { kind: "top", page: 4 },
  { kind: "trending", page: 5 },
  { kind: "top", page: 5 },
  { kind: "top", page: 6 },
  { kind: "top", page: 7 },
  { kind: "top", page: 8 },
  { kind: "top", page: 9 },
  { kind: "top", page: 10 },
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

// Is this row a Solana memecoin paired against SOL? That is the only thing bot 1 decides — it has
// no opinion on age, size or quality, which is bot 2's job. Everything else is screened and logged.
export function isMemecoinPool(pool) {
  if (!pool?.mint || !pool.pool) return false;
  if (pool.quoteMint !== SOL_MINT) return false;
  return !EXCLUDED_BASE_MINTS.has(pool.mint);
}
