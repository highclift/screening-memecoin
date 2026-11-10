// Scores a candidate that already passed the hard filters. Every feature is scaled to 0..1 and
// unknown data counts as a neutral 0.5, so missing data neither helps nor hurts.
//
// The weights and scales are hand-picked starting points, NOT validated against outcomes. Use the
// journal (data/journal.jsonl) to see which features actually separate winners from losers and
// tune them (or MIN_SCORE) from that evidence.

export const WEIGHTS = {
  buyRatio: 0.20,     // share of observed trades that are buys
  buyerBreadth: 0.20, // distinct buyers vs. twice the required minimum
  rebound: 0.15,      // strength of the bounce off the post-pullback low
  liquidity: 0.15,    // pool liquidity relative to market cap
  holders: 0.15,      // top-holder concentration (lower is better)
  dev: 0.15,          // creator history (clean = 1)
};

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round = (n) => Math.round(n * 1000) / 1000;

export function scoreCandidate(candidate, config, { dev = null, holders = null } = {}) {
  const parts = {};

  parts.buyRatio = candidate.trades > 0 ? clamp01((candidate.buys / candidate.trades - 0.5) / 0.3) : 0;
  parts.buyerBreadth = clamp01(candidate.buyers.size / (config.minUniqueBuyers * 2));

  const rebound = candidate.lowMarketCapUsd > 0 ? candidate.currentMarketCapUsd / candidate.lowMarketCapUsd - 1 : 0;
  parts.rebound = Number.isFinite(rebound) ? clamp01(rebound / (config.bouncePct * 3)) : 0;

  parts.liquidity = Number.isFinite(candidate.liquidityUsd) && candidate.currentMarketCapUsd > 0
    ? clamp01(candidate.liquidityUsd / candidate.currentMarketCapUsd / 0.12)
    : 0.5;

  parts.holders = holders?.status === "ok" && Number.isFinite(holders.topPct) && config.maxTopHoldersPct > 0
    ? clamp01(1 - holders.topPct / config.maxTopHoldersPct)
    : 0.5;

  parts.dev = dev?.verdict === "clean" ? 1 : 0.5;

  let score = 0;
  for (const [name, weight] of Object.entries(WEIGHTS)) score += weight * parts[name];
  return {
    score: round(score),
    parts: Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, round(value)])),
  };
}
