// RugCheck's public API (api.rugcheck.xyz) — the only source here for the four things the DEX
// feeds do not report, and which are exactly the things a rug is built out of:
//
//   LP burned or locked  — if the pool's LP tokens are still in somebody's wallet, that somebody
//                          can withdraw the liquidity you are planning to sell into. This is the
//                          rug: not a price falling, a pool that stops existing.
//   creator's holding    — what the dev kept for himself, as a share of supply.
//   insider networks     — groups of wallets that have moved the token BETWEEN each other. This is
//                          the graph a bubble map draws, and it is the one thing the funding graph
//                          in holders.js cannot see (it reads who paid a wallet's first fee, which
//                          is out of reach for a wallet with thousands of transactions).
//   holder count         — how many wallets hold it at all, which no DEX endpoint reports.
//
// Free, no key, and rate limited to 15 calls a minute (the response says so in x-rate-limit-limit),
// so every call goes through a budget and is only ever spent on a coin that has passed every
// cheaper check. A coin we could not look up is never treated as clean — the filter waits instead.

import { createBudget } from "./discovery.js";

const RUGCHECK = "https://api.rugcheck.xyz/v1/tokens";

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

// Everything the filter agent asks about one coin, in one call.
//
// `lpLockedPct` is taken from the DEEPEST market rather than averaged across all of them. A coin
// trades in several pools at once and the numbers differ wildly per pool (a pump.fun AMM pool at
// 100% beside four dust Meteora pools at 0%); the pool that matters is the one a position would
// actually be sold into, and that is the deepest one.
export function parseReport(report) {
  if (!report || typeof report !== "object") return null;

  const supply = num(report.token?.supply);
  const pctOfSupply = (raw) => {
    const amount = num(raw);
    return amount !== null && supply > 0 ? (amount / supply) * 100 : null;
  };

  const markets = Array.isArray(report.markets) ? report.markets : [];
  const deepest = markets
    .filter((market) => market?.lp)
    .sort((a, b) => (num(b.lp.quoteUSD) ?? 0) - (num(a.lp.quoteUSD) ?? 0))[0] ?? null;

  // Wallets that have passed the token between themselves. `currentHolding` is what the network
  // still has, which is what can be dumped; `tokenAmount` is what it has ever held, which says how
  // much has already been sold into the market.
  const networks = Array.isArray(report.insiderNetworks) ? report.insiderNetworks : [];
  const insiderHolding = networks.reduce((total, net) => total + (num(net.currentHolding) ?? 0), 0);
  const insiderEverHeld = networks.reduce((total, net) => total + (num(net.tokenAmount) ?? 0), 0);
  const insiderWallets = networks.reduce((total, net) => total + (num(net.activeAccounts) ?? num(net.size) ?? 0), 0);

  // The per-holder flag is a second, independent reading of the same idea: how much of the top of
  // the holder list RugCheck believes is insider supply.
  const topHolders = Array.isArray(report.topHolders) ? report.topHolders : [];
  const flaggedPct = topHolders.filter((holder) => holder?.insider)
    .reduce((total, holder) => total + (num(holder.pct) ?? 0), 0);

  return {
    // Authorities. The API reports a revoked authority as null, same as the RPC does.
    mintAuthority: report.token?.mintAuthority ?? report.mintAuthority ?? null,
    freezeAuthority: report.token?.freezeAuthority ?? report.freezeAuthority ?? null,

    lpLockedPct: deepest ? num(deepest.lp.lpLockedPct) : null,
    lpLockedUsd: deepest ? num(deepest.lp.lpLockedUSD) : null,
    marketType: deepest?.marketType ?? null,
    marketCount: markets.length,
    totalLiquidityUsd: num(report.totalMarketLiquidity),

    creator: typeof report.creator === "string" ? report.creator : null,
    creatorPct: pctOfSupply(report.creatorBalance),
    // Other coins by the same creator, when the API knows of any. null is "it did not say".
    creatorTokens: Array.isArray(report.creatorTokens) ? report.creatorTokens.length : null,

    insiderNetworks: networks.length,
    insiderWallets,
    insiderPct: pctOfSupply(insiderHolding),
    insiderEverPct: pctOfSupply(insiderEverHeld),
    flaggedHolderPct: topHolders.length ? flaggedPct : null,

    totalHolders: num(report.totalHolders),
    rugged: report.rugged === true,
    riskScore: num(report.score_normalised),
    launchpad: report.launchpad?.platform ?? null,
    detectedAt: typeof report.detectedAt === "string" ? Date.parse(report.detectedAt) || null : null,
  };
}

export function createRugcheck({ callsPerMinute = 12, fetchImpl = fetch, timeoutMs = 10_000, now = () => Date.now() } = {}) {
  // One below the documented 15, and spaced out: the limit is per minute but a burst still earns a
  // 429, and a 429 here means a coin goes unchecked at the moment it mattered.
  const budget = createBudget(callsPerMinute, now, { minIntervalMs: 2000 });
  const stats = { calls: 0, ok: 0, errors: 0, rateLimited: 0 };

  return {
    ready: () => budget.ready(),
    used: () => budget.used(),
    stats: () => ({ ...stats, rate: budget.rate() }),

    // Returns the parsed report, or throws. Callers treat a throw as "unknown", never as "clean".
    async report(mint) {
      if (!budget.tryTake()) {
        const error = new Error("rugcheck budget spent");
        error.paced = true;
        throw error;
      }
      stats.calls += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${RUGCHECK}/${mint}/report`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        if (res.status === 429) {
          stats.rateLimited += 1;
          const error = new Error("rugcheck rate limited (429)");
          error.rateLimited = true;
          throw error;
        }
        // 404 means RugCheck has never indexed this token. That is common for a coin minutes old
        // and is not an error worth retrying hard.
        if (res.status === 404) {
          const error = new Error("rugcheck has not indexed this token yet");
          error.notFound = true;
          throw error;
        }
        if (!res.ok) throw new Error(`rugcheck HTTP ${res.status}`);
        const parsed = parseReport(await res.json());
        if (!parsed) throw new Error("rugcheck returned no usable report");
        stats.ok += 1;
        return parsed;
      } catch (error) {
        if (!error.rateLimited) stats.errors += 1;
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
