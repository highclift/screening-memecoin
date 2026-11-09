// Free market-data source for migrated Pump.fun tokens (no PumpPortal trade subscription needed).
//  - DexScreener : price + buy/sell counts, up to 30 tokens per request (bulk polling)
//  - GeckoTerminal: recent trades of ONE pool, used only to count unique buyers (lazy, rate limited)
// Pump.fun tokens have a fixed 1,000,000,000 supply. Prices are kept in SOL
// for paper accounting; USD market caps are used for display and screening.

import { parseDexInfo } from "./social.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const SUPPLY = 1_000_000_000;
const DEX_URL = "https://api.dexscreener.com/tokens/v1/solana/";
const GECKO_URL = "https://api.geckoterminal.com/api/v2/networks/solana/pools/";

async function getJson(url, timeoutMs = 8000, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (res.status === 429) {
      const err = new Error("rate limited (429)");
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Returns Map<mint, {price, marketCapUsd, solUsd, trades, buys, sells, pool, liquidityUsd}>.
// `price` is market cap in SOL, matching PumpPortal's price unit.
export async function fetchDexSnapshots(mints, fetchImpl = fetch) {
  const out = new Map();
  if (!mints.length) return out;
  const data = await getJson(DEX_URL + mints.join(","), 8000, fetchImpl);
  const pairs = Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : [];
  for (const pair of pairs) {
    const mint = pair?.baseToken?.address;
    if (!mint || !mints.includes(mint)) continue;
    const quote = pair?.quoteToken;
    if (quote?.address !== SOL_MINT && quote?.symbol !== "SOL" && quote?.symbol !== "WSOL") continue;
    const priceNative = Number(pair.priceNative);
    if (!Number.isFinite(priceNative) || priceNative <= 0) continue;
    const priceUsd = Number(pair.priceUsd);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    const solUsd = priceUsd / priceNative;
    const liquidityUsd = Number(pair?.liquidity?.usd) || 0;
    const previous = out.get(mint);
    if (previous && previous.liquidityUsd >= liquidityUsd) continue; // keep the deepest pool
    const m5 = pair?.txns?.m5 ?? {};
    const buys = Number(m5.buys) || 0;
    const sells = Number(m5.sells) || 0;
    out.set(mint, {
      price: priceNative * SUPPLY,
      marketCapUsd: priceUsd * SUPPLY,
      solUsd,
      buys,
      sells,
      trades: buys + sells,
      pool: pair.pairAddress ?? "",
      liquidityUsd,
      socials: parseDexInfo(pair.info),
    });
  }
  return out;
}

// Resolve SOL/USD from the deepest liquid SOL pair returned for the wrapped SOL mint.
export async function fetchSolUsdPrice(fetchImpl = fetch) {
  const data = await getJson(DEX_URL + SOL_MINT, 8000, fetchImpl);
  const pairs = Array.isArray(data) ? data : Array.isArray(data?.pairs) ? data.pairs : [];
  let best = null;
  for (const pair of pairs) {
    const base = pair?.baseToken?.address;
    const quote = pair?.quoteToken;
    const priceUsd = Number(pair?.priceUsd);
    const priceNative = Number(pair?.priceNative);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    let solUsd = null;
    if (base === SOL_MINT) solUsd = priceUsd;
    else if ((quote?.address === SOL_MINT || quote?.symbol === "SOL" || quote?.symbol === "WSOL")
      && Number.isFinite(priceNative) && priceNative > 0) {
      solUsd = priceUsd / priceNative;
    }
    if (!Number.isFinite(solUsd) || solUsd <= 0) continue;

    const liquidityUsd = Number(pair?.liquidity?.usd) || 0;
    if (!best || liquidityUsd > best.liquidityUsd) best = { solUsd, liquidityUsd };
  }
  if (!best) throw new Error("DexScreener did not return a usable SOL/USD pair.");
  return best.solUsd;
}

// Returns a Set of distinct wallet addresses that bought in this pool recently.
export async function fetchUniqueBuyers(poolAddress, sinceMs = 0, fetchImpl = fetch) {
  const data = await getJson(`${GECKO_URL}${poolAddress}/trades`, 8000, fetchImpl);
  const buyers = new Set();
  for (const row of data?.data ?? []) {
    const a = row?.attributes;
    if (!a || a.kind !== "buy" || !a.tx_from_address) continue;
    const ts = a.block_timestamp ? Date.parse(a.block_timestamp) : Number.NaN;
    if (sinceMs && Number.isFinite(ts) && ts < sinceMs) continue;
    buyers.add(a.tx_from_address);
  }
  return buyers;
}
