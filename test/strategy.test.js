import test from "node:test";
import assert from "node:assert/strict";
import { SUPPLY, priceFromEvent, updateLevels, shouldEnter } from "../src/strategy.js";

const config = {
  pullbackPct: 0.2,
  bouncePct: 0.05,
  minTrades: 1,
  minBuys: 1,
  minUniqueBuyers: 1,
  minMarketCapUsd: 0,
  maxMarketCapUsd: 1_000_000,
};

function candidate() {
  return {
    trades: 30,
    buys: 20,
    buyers: new Set(["a", "b", "c"]),
    peakMarketCapUsd: null,
    lowMarketCapUsd: null,
    pulledBack: false,
  };
}

function feed(c, values) {
  for (const value of values) updateLevels(c, value, config);
}

test("priceFromEvent prefers marketCapSol", () => {
  assert.equal(priceFromEvent({ marketCapSol: 55.5, solAmount: 1, tokenAmount: 1 }), 55.5);
});

test("priceFromEvent fallback is in the same unit as marketCapSol (market cap in SOL)", () => {
  // 1 SOL buys 10,000,000 tokens -> 1e-7 SOL per token -> 100 SOL market cap at 1B supply
  const price = priceFromEvent({ solAmount: 1, tokenAmount: 10_000_000 });
  assert.ok(Math.abs(price - 100) < 1e-9);
  assert.equal(SUPPLY, 1_000_000_000);
});

test("priceFromEvent returns null without usable data", () => {
  assert.equal(priceFromEvent({}), null);
  assert.equal(priceFromEvent({ solAmount: 0, tokenAmount: 5 }), null);
});

test("regression: a low from before the peak must not satisfy the rebound", () => {
  const c = candidate();
  // 50k -> 100k peak -> 80k (20% pullback). The old code measured the bounce from 50k.
  feed(c, [50_000, 100_000, 80_000]);
  assert.equal(c.pulledBack, true);
  assert.equal(c.lowMarketCapUsd, 80_000);
  assert.equal(shouldEnter(c, 80_000, config), false, "no rebound yet: must not enter on the pullback tick");
});

test("enters only after bouncing off the post-pullback low", () => {
  const c = candidate();
  feed(c, [50_000, 100_000, 80_000, 70_000]);
  assert.equal(c.lowMarketCapUsd, 70_000);
  assert.equal(shouldEnter(c, 72_000, config), false); // +2.9%
  assert.equal(shouldEnter(c, 73_500, config), true); // +5%
});

test("a new high resets the pullback and waits for a fresh drop", () => {
  const c = candidate();
  feed(c, [100_000, 80_000]);
  assert.equal(c.pulledBack, true);
  feed(c, [110_000]);
  assert.equal(c.pulledBack, false);
  assert.equal(c.peakMarketCapUsd, 110_000);
  assert.equal(shouldEnter(c, 110_000, config), false);
  feed(c, [88_000]); // exactly 20% below the new peak
  assert.equal(c.pulledBack, true);
  assert.equal(c.lowMarketCapUsd, 88_000);
});

test("ignores non-finite market caps and tolerates a null starting peak", () => {
  const c = candidate();
  updateLevels(c, null, config);
  updateLevels(c, Number.NaN, config);
  assert.equal(c.peakMarketCapUsd, null);
  updateLevels(c, 60_000, config);
  assert.equal(c.peakMarketCapUsd, 60_000);
  assert.equal(c.lowMarketCapUsd, 60_000);
});

test("shouldEnter respects activity thresholds and the market-cap range", () => {
  const c = candidate();
  feed(c, [100_000, 70_000]);
  assert.equal(shouldEnter({ ...c, trades: 0 }, 75_000, { ...config, minTrades: 5 }), false);
  assert.equal(shouldEnter(c, 75_000, { ...config, maxMarketCapUsd: 50_000 }), false);
  assert.equal(shouldEnter(c, 75_000, config), true);
});
