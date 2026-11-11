import test from "node:test";
import assert from "node:assert/strict";
import { DESK_WEIGHTS, buyShare, deskScore, holderGrowthPerHour, reclaimPct, roundTripCostPct, volatilityPct } from "../src/signals.js";

// A coin inside the desk's window, trading well.
const lively = {
  ageSeconds: 7200,
  marketCapUsd: 450_000,
  liquidityUsd: 60_000,
  volumeH24Usd: 240_000,
  volumeH1Usd: 90_000,
  buysH1: 300,
  sellsH1: 120,
  tradesH1: 420,
  buyersH1: 90,
  sellersH1: 45,
  priceChangeH1: 18,
};

test("desk score: the weights sum to 1 and the score stays in range", () => {
  assert.ok(Math.abs(Object.values(DESK_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  for (const record of [lively, {}, { snapshots: [] }, { marketCapUsd: 0 }]) {
    const { score } = deskScore(record);
    assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`);
  }
});

test("desk score: a coin going nowhere does not reach the pass mark on depth alone", () => {
  // The failure mode worth guarding: liquidity and a neutral unknown are both free, so a coin with
  // a deep pool and nothing else happening must still land well under 70.
  const dead = deskScore({ marketCapUsd: 500_000, liquidityUsd: 100_000, priceChangeH1: 0, buyersH1: 2, sellersH1: 9 });
  assert.ok(dead.score < 70, `a quiet coin scored ${dead.score}`);
  assert.ok(deskScore(lively).score > dead.score, "and a lively one beats it");
});

test("desk score: wallets beat trades when both are known", () => {
  // One wallet can make fifty trades, so the buy/sell split is the blunter reading. When the
  // distinct counts are there they decide instead — this pair has a healthy trade split and a
  // crowd that is actually leaving.
  const byTrades = deskScore({ buysH1: 90, sellsH1: 10, tradesH1: 100 }).parts.buySellRatio;
  const byWallets = deskScore({ buysH1: 90, sellsH1: 10, tradesH1: 100, buyersH1: 5, sellersH1: 30 }).parts.buySellRatio;
  assert.ok(byTrades > 0.9, `trades-only read ${byTrades}`);
  assert.equal(byWallets, 0, "five wallets buying against thirty selling is not buying pressure");
});

test("holder growth: a rate, not a number, and only when there is a span to measure it over", () => {
  assert.equal(holderGrowthPerHour([]), null);
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 100 }]), null, "one sample is not a rate");
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 100 }, { at: 60_000, holders: 150 }]), null, "a minute apart is noise");
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 100 }, { at: 3_600_000, holders: 150 }]), 0.5);
  // Half an hour of +25% is +50% an hour.
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 200 }, { at: 1_800_000, holders: 250 }]), 0.5);
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 0 }, { at: 3_600_000, holders: 50 }]), null, "zero holders is unknown, not a start");
});

test("buy share and reclaim read the desk's own measurements", () => {
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

test("round-trip cost: what the simulated fills take out before the trade does anything", () => {
  // The default 100 bps fee + 200 bps slippage per side costs 6% of the price per round trip, which
  // is far above a real Solana AMM swap at this size and is the single biggest influence on the
  // measured PnL. The risk agent floors the trail at 1.5x this, or the stop fires inside the spread.
  const cost = roundTripCostPct({ paperFeeBps: 100, paperSlippageBps: 200 });
  assert.ok(Math.abs(cost - 0.06) < 1e-9);
  assert.equal(roundTripCostPct({}), 0);
  assert.ok(Math.abs(roundTripCostPct({ paperFeeBps: 30, paperSlippageBps: 70 }) - 0.02) < 1e-9);
});
