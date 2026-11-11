// Pure math behind the analyst's score and the executor's timing.
//
// Nothing here reads config: every number is derived from the coin's OWN data, or from a threshold
// that means something on its own. That is why the analyst has no per-coin settings — a coin is
// measured against itself, not against a number somebody guessed for it.
//
// Parts are 0..1. Unknown data returns a neutral value, never 0, so a coin is never punished for a
// field a source did not report — and never rewarded for one either.

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round = (n, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
};
const finite = (n) => Number.isFinite(n);

// Share of this hour's trades that were buys. Used where the wallet counts are not available —
// one wallet can make fifty trades, so this is the blunter of the two readings.
export function buyShare(record) {
  const buys = finite(record?.buysH1) ? record.buysH1 : null;
  const trades = finite(record?.tradesH1) && record.tradesH1 > 0
    ? record.tradesH1
    : buys !== null && finite(record?.sellsH1) ? buys + record.sellsH1 : null;
  if (buys === null || !trades) return null;
  return buys / trades;
}

// How far the coin has climbed off the lowest market cap this desk measured itself.
export function reclaimPct(record) {
  const snapshots = record?.snapshots ?? [];
  if (snapshots.length < 2 || !finite(record.marketCapUsd)) return null;
  let low = Infinity;
  for (const snapshot of snapshots) {
    if (finite(snapshot.marketCapUsd) && snapshot.marketCapUsd < low) low = snapshot.marketCapUsd;
  }
  if (!finite(low) || low <= 0) return null;
  return record.marketCapUsd / low - 1;
}

// ---------------------------------------------------------------------------------------------
// THE DESK SCORE, 0-100. What the analyst agent decides on.
//
// Six readings, each 0..1, each measured against the coin itself or against a number that means
// something on its own. Unknown data scores a neutral 0.5 and is reported as unknown, so a coin is
// never punished for a field a source did not fill in — and never rewarded for one either.
//
// Holder growth and smart money are the two that need a history, so they are the two that are
// usually unknown on a coin the desk has just met. That is worth knowing when reading a score: a
// 72 made of four measurements and two neutrals is a weaker 72 than one made of six measurements,
// which is why `known` comes back with the score.
export const DESK_WEIGHTS = {
  momentum: 0.20, // price actually moving up, before the move is over
  uniqueBuyers: 0.20, // how many DIFFERENT wallets bought this hour
  buySellRatio: 0.15, // buying pressure against selling pressure
  holderGrowth: 0.20, // is the holder count growing, measured over our own samples
  liqMcap: 0.15, // how deep the pool is for the size of the coin
  smartWallets: 0.10, // do wallets with a record of being early show up in the buyers
};

// Holders per hour, as a fraction, from the samples the desk took itself. Needs two samples at
// least `minSpanMs` apart — before that there is no rate to speak of, only a number.
export function holderGrowthPerHour(samples = [], { minSpanMs = 4 * 60_000 } = {}) {
  const points = (samples ?? []).filter((s) => finite(s?.holders) && s.holders > 0 && finite(s?.at));
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const spanMs = last.at - first.at;
  if (spanMs < minSpanMs) return null;
  return (last.holders / first.holders - 1) * (3_600_000 / spanMs);
}

export function deskScore(record, { smartCrowd = null } = {}) {
  const parts = {};
  const known = {};
  const set = (name, value) => {
    known[name] = value !== null;
    parts[name] = value === null ? 0.5 : clamp01(value);
  };

  // 1. Momentum. The top of the range is deliberately short of the filter's +80% kill: by the time
  //    a coin has doubled in an hour the move being scored is one somebody else already had.
  const changeH1 = finite(record?.priceChangeH1) ? record.priceChangeH1 : null;
  const reclaim = reclaimPct(record);
  const fromChange = changeH1 === null ? null : (changeH1 + 5) / 45; // -5% = 0, +40% = 1
  const fromReclaim = reclaim === null ? null : reclaim / 0.2; // +20% off our own low = 1
  set("momentum", fromChange === null && fromReclaim === null ? null : Math.max(fromChange ?? 0, fromReclaim ?? 0));

  // 2. Different wallets, not trades. 100 distinct buyers in an hour is a crowd at this size.
  const buyers = finite(record?.buyersH1) ? record.buyersH1 : null;
  set("uniqueBuyers", buyers === null ? null : buyers / 100);

  // 3. Buying against selling, counted in wallets when both are known (a sharper reading than the
  //    trade split: one wallet can make fifty trades) and in trades when they are not.
  const sellers = finite(record?.sellersH1) ? record.sellersH1 : null;
  const share = buyShare(record);
  const walletRatio = buyers !== null && sellers !== null && buyers + sellers > 0
    ? buyers / (buyers + sellers)
    : null;
  const ratio = walletRatio ?? share;
  set("buySellRatio", ratio === null ? null : (ratio - 0.45) / 0.25); // 45% = 0, 70%+ = 1

  // 4. Holder growth, from the desk's own samples. +10% an hour = 1.
  const growth = holderGrowthPerHour(record?.holderCounts);
  set("holderGrowth", growth === null ? null : growth / 0.1);

  // 5. Depth for the size of the coin.
  const depth = finite(record?.liquidityUsd) && finite(record?.marketCapUsd) && record.marketCapUsd > 0
    ? record.liquidityUsd / record.marketCapUsd
    : null;
  set("liqMcap", depth === null ? null : (depth - 0.02) / 0.08); // 2% = 0, 10%+ = 1

  // 6. Smart money. Already 0..1 from the registry, which returns null until it knows any of the
  //    wallets buying — on night one that is every coin, and a neutral 0.5 is the honest answer.
  set("smartWallets", smartCrowd === null || !finite(smartCrowd?.score) ? null : smartCrowd.score);

  let total = 0;
  for (const [name, weight] of Object.entries(DESK_WEIGHTS)) total += weight * parts[name];

  let lead = "momentum";
  let best = -1;
  for (const [name, weight] of Object.entries(DESK_WEIGHTS)) {
    if (known[name] && parts[name] * weight > best) {
      best = parts[name] * weight;
      lead = name;
    }
  }

  return {
    score: Math.round(total * 100),
    lead,
    measured: Object.values(known).filter(Boolean).length,
    of: Object.keys(DESK_WEIGHTS).length,
    known,
    parts: Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, round(value)])),
    holderGrowthPerHour: growth === null ? null : round(growth, 3),
    smartKnown: smartCrowd?.known ?? 0,
  };
}

// The typical one-minute move of this coin, measured from the snapshots the bot took itself.
// Returned as a fraction (0.04 = this coin usually moves 4% a minute). null when there is not
// enough measured history yet — bot 3 refuses to enter a coin it has not measured.
export function volatilityPct(snapshots = [], { windowMs = 300_000, now = Date.now(), minSamples = 5, minSpanMs = 30_000 } = {}) {
  const points = snapshots.filter((s) => finite(s?.marketCapUsd) && s.marketCapUsd > 0 && now - s.at <= windowMs);
  if (points.length < minSamples) return null;
  if (points[points.length - 1].at - points[0].at < minSpanMs) return null;

  let steps = 0;
  let sumAbs = 0;
  let sumDt = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dt = points[i].at - points[i - 1].at;
    if (dt <= 0) continue;
    sumAbs += Math.abs(points[i].marketCapUsd / points[i - 1].marketCapUsd - 1);
    sumDt += dt;
    steps += 1;
  }
  if (!steps) return null;
  const meanStep = sumAbs / steps;
  const meanDt = sumDt / steps;
  // A price walks, so a move over one minute is about sqrt(minute / sample gap) times a sample move.
  return clamp(meanStep * Math.sqrt(60_000 / meanDt), 0.005, 0.25);
}

// What one round trip costs in price terms, from the simulated fee and slippage per side.
export function roundTripCostPct({ paperFeeBps = 0, paperSlippageBps = 0 } = {}) {
  return (2 * (paperFeeBps + paperSlippageBps)) / 10_000;
}

export const __test = { clamp01, clamp, round };
