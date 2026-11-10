// Pure math behind bot 2's verdict and bot 3's timing.
//
// Nothing here reads config: every number is derived from the coin's OWN data. That is why bot 2
// and bot 3 have no strategy settings to tune — a coin is measured against its own history, not
// against a threshold somebody guessed.
//
// Signals are 0..1. Unknown data returns a neutral value, never 0, so a coin is never punished for
// a field a source did not report.

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round = (n, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
};
const finite = (n) => Number.isFinite(n);

// How much this coin trades in a NORMAL hour. For a coin younger than a day its 24h volume covers
// only the hours it has existed, so the average is taken over those hours.
export function hourlyBaselineUsd(record, ageSeconds = record?.ageSeconds) {
  if (!finite(record?.volumeH24Usd) || record.volumeH24Usd <= 0) return null;
  const hours = finite(ageSeconds) ? clamp(ageSeconds / 3600, 1, 24) : 24;
  return record.volumeH24Usd / hours;
}

// THE re-pump signal: this hour's volume against a normal hour for this coin. A coin that launched
// a month ago and has been quiet since sits at ~1 for weeks, then jumps the hour it wakes up.
export function surgeRatio(record, ageSeconds = record?.ageSeconds) {
  const baseline = hourlyBaselineUsd(record, ageSeconds);
  if (!baseline || !finite(record?.volumeH1Usd)) return null;
  return record.volumeH1Usd / baseline;
}

// How many times the pool's own liquidity changed hands this hour. This is what tells you a BRAND
// NEW coin is hot: it has no history to compare against, but real money is moving through it.
export function turnover(record) {
  if (!finite(record?.volumeH1Usd) || !finite(record?.liquidityUsd) || record.liquidityUsd <= 0) return null;
  return record.volumeH1Usd / record.liquidityUsd;
}

// Share of this hour's trades that were buys.
export function buyShare(record) {
  const buys = finite(record?.buysH1) ? record.buysH1 : null;
  const trades = finite(record?.tradesH1) && record.tradesH1 > 0
    ? record.tradesH1
    : buys !== null && finite(record?.sellsH1) ? buys + record.sellsH1 : null;
  if (buys === null || !trades) return null;
  return buys / trades;
}

// How far the coin has climbed off the lowest market cap this bot measured itself.
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

export const PUMP_WEIGHTS = {
  surge: 0.30,       // volume waking up — the signal that works on new and month-old coins alike
  buyPressure: 0.20, // buys outnumbering sells this hour
  breadth: 0.20,     // how many different wallets are buying (one whale is not a pump)
  momentum: 0.15,    // price actually moving up
  depth: 0.15,       // liquidity deep enough that the move is not one trade bouncing off the walls
};

// Scores a coin's chance of pumping (or pumping AGAIN). Returns the score, every part, and the
// strongest part, which is what the bot 2 log line quotes as its reason.
export function pumpScore(record, ageSeconds = record?.ageSeconds) {
  const parts = {};

  // Surge: the better of "loud compared to its own history" and "loud compared to its own pool".
  // Which of the two won is reported, because they mean different things to a reader: the first is
  // a coin waking up, the second is a coin with no history worth comparing against.
  const ratio = surgeRatio(record, ageSeconds);
  const turns = turnover(record);
  const fromRatio = ratio === null ? null : clamp01((ratio - 1) / 4); // 1x = 0, 5x+ = 1
  const fromTurnover = turns === null ? null : clamp01(turns / 3); // 3x the pool in an hour = 1
  let surgeFrom = null;
  if (fromRatio === null && fromTurnover === null) {
    parts.surge = 0.3; // no volume data at all: cannot confirm a surge, so lean low rather than neutral
  } else if ((fromRatio ?? 0) >= (fromTurnover ?? 0)) {
    parts.surge = fromRatio ?? 0;
    surgeFrom = "baseline";
  } else {
    parts.surge = fromTurnover ?? 0;
    surgeFrom = "turnover";
  }

  const share = buyShare(record);
  parts.buyPressure = share === null ? 0.5 : clamp01((share - 0.45) / 0.25); // 45% = 0, 70%+ = 1

  const buyers = finite(record?.buyersH1) ? record.buyersH1 : null;
  parts.breadth = buyers === null ? 0.5 : clamp01(buyers / 60);

  const changeH1 = finite(record?.priceChangeH1) ? record.priceChangeH1 : null;
  const reclaim = reclaimPct(record);
  const fromChange = changeH1 === null ? null : clamp01((changeH1 + 5) / 25); // -5% = 0, +20%+ = 1
  const fromReclaim = reclaim === null ? null : clamp01(reclaim / 0.15); // +15% off our low = 1
  parts.momentum = fromChange === null && fromReclaim === null
    ? 0.5
    : Math.max(fromChange ?? 0, fromReclaim ?? 0);

  const depthRatio = finite(record?.liquidityUsd) && finite(record?.marketCapUsd) && record.marketCapUsd > 0
    ? record.liquidityUsd / record.marketCapUsd
    : null;
  parts.depth = depthRatio === null ? 0.5 : clamp01(depthRatio / 0.1); // 10% of market cap = 1

  let score = 0;
  for (const [name, weight] of Object.entries(PUMP_WEIGHTS)) score += weight * parts[name];

  let lead = "surge";
  let best = -1;
  for (const [name, weight] of Object.entries(PUMP_WEIGHTS)) {
    if (parts[name] * weight > best) {
      best = parts[name] * weight;
      lead = name;
    }
  }

  return {
    score: round(score),
    lead,
    surgeFrom,
    surgeRatio: ratio === null ? null : round(ratio, 2),
    turnover: turns === null ? null : round(turns, 2),
    parts: Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, round(value)])),
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

// Everything bot 3 needs to time one trade, derived from that coin's own volatility. A coin that
// swings 10% a minute gets wide stops and little patience; a steady one gets tight stops and time.
//
// `costPct` is what a round trip costs (fee + slippage, both sides). No stop may sit inside that:
// a trailing stop tighter than the spread fires on noise and books a loss the price never made.
export function deriveLevels(volPct, costPct = 0) {
  const v = finite(volPct) && volPct > 0 ? volPct : 0.03;
  const cost = finite(costPct) && costPct > 0 ? costPct : 0;
  return {
    volPct: round(v, 4),
    costPct: round(cost, 4),
    dipPct: round(clamp(v * 1.2, 0.04, 0.35), 4), // pullback that has to happen before we look at it
    bouncePct: round(clamp(v * 0.6, 0.015, 0.12), 4), // reclaim off the low that confirms buyers returned
    stopPct: round(clamp(v * 2.5, Math.max(0.08, cost * 1.5), 0.3), 4), // hard stop below entry
    trailPct: round(clamp(v * 2.0, Math.max(0.06, cost * 1.5), 0.25), 4), // trailing stop under the peak
    tightTrailPct: round(clamp(v * 1.0, Math.max(0.04, cost), 0.15), 4), // the trail once profit is locked
    lockPct: round(clamp(v * 3.0, Math.max(0.1, cost * 2), 0.6), 4), // profit that switches to the tight trail
    stallMs: Math.round(clamp(120_000 * (0.03 / v), 60_000, 600_000)), // no new high for this long = over
    maxHoldMs: 45 * 60_000,
  };
}

// What one round trip costs in price terms, from the simulated fee and slippage per side.
export function roundTripCostPct({ paperFeeBps = 0, paperSlippageBps = 0 } = {}) {
  return (2 * (paperFeeBps + paperSlippageBps)) / 10_000;
}

export const __test = { clamp01, clamp, round };
