import test from "node:test";
import assert from "node:assert/strict";
import { deriveLevels, hourlyBaselineUsd, pumpScore, PUMP_WEIGHTS, reclaimPct, roundTripCostPct, surgeRatio, turnover, volatilityPct, buyShare } from "../src/signals.js";

// The coin from the brief: launched a month ago, quiet ever since.
const asleep = {
  ageSeconds: 30 * 86_400,
  marketCapUsd: 450_000,
  liquidityUsd: 60_000,
  volumeH24Usd: 240_000, // ~$10k in a normal hour
  volumeH1Usd: 9_000,
  buysH1: 20,
  sellsH1: 22,
  tradesH1: 42,
  buyersH1: 12,
  priceChangeH1: -2,
  snapshots: [],
};

// The same coin, the hour it wakes up: 18x its normal volume.
const waking = { ...asleep, volumeH1Usd: 180_000, buysH1: 420, sellsH1: 180, tradesH1: 600, buyersH1: 150, priceChangeH1: 22 };

test("baseline: a normal hour is measured over the hours the coin has existed", () => {
  assert.equal(hourlyBaselineUsd(asleep), 10_000);
  // A two-hour-old coin is not compared against a full day it never had.
  assert.equal(hourlyBaselineUsd({ volumeH24Usd: 20_000 }, 2 * 3600), 10_000);
  // Under an hour old, one hour is the floor, so the ratio cannot be inflated by a tiny divisor.
  assert.equal(hourlyBaselineUsd({ volumeH24Usd: 5_000 }, 300), 5_000);
  assert.equal(hourlyBaselineUsd({ volumeH24Usd: 0 }), null, "no volume data is unknown, not zero");
});

test("surge: a month-old coin waking up is what the signal is for", () => {
  assert.ok(surgeRatio(asleep) < 1.2, `asleep ratio ${surgeRatio(asleep)}`);
  assert.ok(surgeRatio(waking) > 10, `waking ratio ${surgeRatio(waking)}`);
  assert.equal(surgeRatio({ volumeH1Usd: 1000 }), null, "no 24h volume means unknown");
});

test("turnover: a brand-new coin with no history is judged on money through the pool", () => {
  assert.equal(turnover({ volumeH1Usd: 90_000, liquidityUsd: 30_000 }), 3);
  assert.equal(turnover({ volumeH1Usd: 90_000, liquidityUsd: 0 }), null);

  // A 10-minute-old coin has no baseline at all, but heavy turnover still scores.
  const fresh = {
    ageSeconds: 600, marketCapUsd: 90_000, liquidityUsd: 25_000,
    volumeH1Usd: 75_000, volumeH24Usd: 75_000, buysH1: 300, sellsH1: 120, tradesH1: 420, buyersH1: 90,
    priceChangeH1: 30, snapshots: [],
  };
  assert.ok(pumpScore(fresh, fresh.ageSeconds).score > 0.58, `fresh score ${pumpScore(fresh).score}`);
});

test("pump score: says which volume measure it used, so the log can phrase it honestly", () => {
  // An old coin has a normal hour to be compared against.
  assert.equal(pumpScore(waking, waking.ageSeconds).surgeFrom, "baseline");

  // A coin minutes old does not, so turnover through its pool is what counts instead.
  const fresh = {
    ageSeconds: 600, marketCapUsd: 90_000, liquidityUsd: 25_000,
    volumeH1Usd: 75_000, volumeH24Usd: 75_000, buysH1: 300, sellsH1: 120, tradesH1: 420, buyersH1: 90,
    priceChangeH1: 30, snapshots: [],
  };
  const scored = pumpScore(fresh, fresh.ageSeconds);
  assert.equal(scored.surgeFrom, "turnover");
  assert.ok(scored.surgeRatio <= 1.1, "its 'normal hour' is meaningless at this age");
  assert.equal(scored.turnover, 3);
  assert.equal(pumpScore({}).surgeFrom, null, "no volume data, nothing to claim");
});

test("pump score: the same coin asleep is red and awake is green, on identical rules", () => {
  const quiet = pumpScore(asleep, asleep.ageSeconds);
  const alive = pumpScore(waking, waking.ageSeconds);
  assert.ok(quiet.score < 0.4, `asleep score ${quiet.score}`);
  assert.ok(alive.score > 0.58, `waking score ${alive.score}`);
  assert.equal(alive.lead, "surge", "the reason it went green should be the volume waking up");
  assert.ok(alive.surgeRatio > 10);
});

test("pump score: weights sum to 1, scores stay in range, unknowns are neutral", () => {
  assert.ok(Math.abs(Object.values(PUMP_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  for (const record of [asleep, waking, {}, { snapshots: [] }]) {
    const { score } = pumpScore(record);
    assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
  }
  const unknown = pumpScore({}).parts;
  assert.equal(unknown.buyPressure, 0.5);
  assert.equal(unknown.breadth, 0.5);
  assert.equal(unknown.depth, 0.5);
  assert.equal(unknown.momentum, 0.5);
  assert.equal(unknown.surge, 0.3, "volume is the one field the bot will not assume");
});

test("buy share and reclaim read the bot's own measurements", () => {
  assert.equal(buyShare({ buysH1: 60, tradesH1: 100 }), 0.6);
  assert.equal(buyShare({ buysH1: 60, sellsH1: 40 }), 0.6, "trades can be derived from buys + sells");
  assert.equal(buyShare({ sellsH1: 40 }), null);

  const record = {
    marketCapUsd: 110_000,
    snapshots: [{ at: 1, marketCapUsd: 150_000 }, { at: 2, marketCapUsd: 100_000 }, { at: 3, marketCapUsd: 110_000 }],
  };
  assert.ok(Math.abs(reclaimPct(record) - 0.1) < 1e-9, "10% up off the low we saw");
  assert.equal(reclaimPct({ marketCapUsd: 1, snapshots: [] }), null);
});

test("volatility: refuses to guess without enough measurements", () => {
  const now = 1_000_000;
  assert.equal(volatilityPct([], { now }), null);
  assert.equal(volatilityPct([{ at: now - 1000, marketCapUsd: 100 }], { now }), null, "one sample is not a measurement");

  // Five samples inside ten seconds still span too little time to call it a minute's movement.
  const bunched = Array.from({ length: 5 }, (_, i) => ({ at: now - 10_000 + i * 2000, marketCapUsd: 100 }));
  assert.equal(volatilityPct(bunched, { now }), null);
});

test("volatility: a jumpy coin measures higher than a steady one", () => {
  const now = 1_000_000;
  const series = (steps) => steps.map((marketCapUsd, i) => ({ at: now - (steps.length - i) * 6000, marketCapUsd }));
  const steady = volatilityPct(series([100, 100.5, 100, 100.4, 100.1, 100.6, 100.2]), { now });
  const jumpy = volatilityPct(series([100, 108, 97, 112, 95, 115, 92]), { now });
  assert.ok(steady !== null && jumpy !== null);
  assert.ok(jumpy > steady * 3, `jumpy ${jumpy} vs steady ${steady}`);
  assert.ok(steady >= 0.005 && jumpy <= 0.25, "clamped to a sane range");
});

test("levels: a jumpy coin gets wider stops and less patience than a steady one", () => {
  const jumpy = deriveLevels(0.08);
  const steady = deriveLevels(0.01);
  assert.ok(jumpy.stopPct > steady.stopPct);
  assert.ok(jumpy.trailPct > steady.trailPct);
  assert.ok(jumpy.dipPct > steady.dipPct);
  assert.ok(jumpy.stallMs < steady.stallMs, "a fast coin that stops making highs is done sooner");

  // Clamps: no coin gets an absurd stop in either direction, however it was measured.
  const wild = deriveLevels(5);
  const flat = deriveLevels(0.0001);
  assert.equal(wild.stopPct, 0.3);
  assert.equal(flat.stopPct, 0.08);
  assert.equal(deriveLevels(null).volPct, 0.03, "no measurement falls back to a middling coin");
  assert.ok(flat.tightTrailPct <= flat.trailPct, "the locked trail is never looser than the normal one");
});

test("levels: a flat stop and a trailing profit, with no fixed profit target", () => {
  const levels = deriveLevels(0.04, roundTripCostPct({ paperFeeBps: 100, paperSlippageBps: 200 }));
  // There is no takeProfitPct and there must never be one: a fixed target caps a winner exactly
  // when it is working. The trail is what ends a winning trade.
  assert.equal(levels.takeProfitPct, undefined);
  assert.ok(levels.trailPct > 0 && levels.tightTrailPct > 0);

  // The tightened trail must still be loose enough for the coin's own movement, or a runner gets
  // stopped out on an ordinary wiggle.
  assert.ok(levels.tightTrailPct >= 0.04 * 1.5 || levels.tightTrailPct >= levels.costPct);
  assert.ok(levels.tightTrailPct <= levels.trailPct);

  // The flat floor only ever ratchets upward, to entry plus what the round trip costs.
  assert.equal(levels.breakEvenPct, levels.costPct);
  assert.ok(levels.lockPct > levels.breakEvenPct, "break-even arms only after a real run");
  assert.ok(levels.maxTotalHoldMs > levels.maxHoldMs);
});

test("levels: no stop is ever tighter than a round trip costs", () => {
  // With the default 100 bps fee + 200 bps slippage per side, a round trip costs 6% of the price.
  const cost = roundTripCostPct({ paperFeeBps: 100, paperSlippageBps: 200 });
  assert.ok(Math.abs(cost - 0.06) < 1e-9);
  assert.equal(roundTripCostPct({}), 0);

  // A steady coin would otherwise get a 6% trailing stop, which fires inside the spread and books
  // a loss the price never made.
  const steady = deriveLevels(0.01, cost);
  assert.ok(steady.trailPct >= cost * 1.5, `trail ${steady.trailPct} vs cost ${cost}`);
  assert.ok(steady.stopPct >= cost * 1.5, `stop ${steady.stopPct}`);
  assert.ok(steady.tightTrailPct >= cost, `tight trail ${steady.tightTrailPct}`);
  assert.ok(steady.lockPct >= cost * 2, "profit is only locked once it is worth more than the costs");
  assert.equal(steady.costPct, 0.06, "the position records what it was costed against");

  // A coin that swings more than the spread keeps its own, wider levels.
  const jumpy = deriveLevels(0.09, cost);
  assert.ok(jumpy.trailPct > steady.trailPct);
  assert.equal(deriveLevels(0.01, 0).trailPct, 0.06, "with no costs the floor is the plain one");
});
