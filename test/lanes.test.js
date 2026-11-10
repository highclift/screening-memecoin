import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { buildLanes, laneForAge, LANE_IDS } from "../src/lanes.js";
import { buyerCount } from "../src/strategy.js";

test("laneForAge assigns pools to the right age band (boundaries included)", () => {
  assert.equal(laneForAge(10 * 60), null); // under 1h belongs to the fresh lane, not discovery
  assert.equal(laneForAge(3599), null);
  assert.equal(laneForAge(3600), "young");
  assert.equal(laneForAge(86_399), "young");
  assert.equal(laneForAge(86_400), "veteran");
  assert.equal(laneForAge(29 * 86_400), "veteran");
  assert.equal(laneForAge(30 * 86_400), null); // older than 30 days is ignored
  assert.equal(laneForAge(null), null);
  assert.equal(laneForAge(Number.NaN), null);
});

test("defaults: all three lanes on, each with its own thresholds", () => {
  const c = loadConfig({});
  assert.deepEqual(Object.keys(c.lanes), LANE_IDS);
  for (const id of LANE_IDS) assert.equal(c.lanes[id].enabled, true, id);
  assert.equal(c.lanes.fresh.cfg.minTrades, 25);
  assert.equal(c.lanes.young.cfg.minTrades, 150);
  assert.equal(c.lanes.veteran.cfg.minMarketCapUsd, 250_000);
  assert.equal(c.lanes.young.cfg.activityWindow, "h1");
  assert.equal(c.lanes.fresh.cfg.activityWindow, "m5");
  assert.equal(c.lanes.young.cfg.useReportedMarketCap, true);
  assert.equal(c.lanes.fresh.cfg.useReportedMarketCap, false);
  assert.equal(c.lanes.young.cfg.socialMode, "any");
  // lanes inherit shared settings from the base config
  assert.equal(c.lanes.veteran.cfg.paperFeeBps, c.paperFeeBps);
  assert.equal(c.lanes.young.cfg.solanaRpcUrl, c.solanaRpcUrl);
});

test("the fresh lane follows the base (dashboard) settings", () => {
  const c = loadConfig({ MIN_TRADES: "30", MIN_BUYS: "20", MIN_UNIQUE_BUYERS: "10", MAX_MARKET_CAP_USD: "200000" });
  assert.equal(c.lanes.fresh.cfg.minTrades, 30);
  assert.equal(c.lanes.fresh.cfg.maxMarketCapUsd, 200_000);
  assert.equal(c.lanes.young.cfg.minTrades, 150); // unaffected
});

test("per-lane env overrides and the LANES switch", () => {
  const c = loadConfig({ YOUNG_MIN_TRADES: "300", YOUNG_MIN_BUYS: "100", VETERAN_STOP_LOSS_PCT: "0.2", VETERAN_SOCIAL_MODE: "twitter", LANES: "fresh,veteran" });
  assert.equal(c.lanes.young.cfg.minTrades, 300);
  assert.equal(c.lanes.young.enabled, false);
  assert.equal(c.lanes.veteran.enabled, true);
  assert.equal(c.lanes.veteran.cfg.stopLossPct, 0.2);
  assert.equal(c.lanes.veteran.cfg.socialMode, "twitter");
});

test("age lanes are switched off outside the free data mode", () => {
  const c = loadConfig({ TRADE_SOURCE: "pumpportal", PUMPPORTAL_API_KEY: "k" });
  assert.equal(c.lanes.fresh.enabled, true);
  assert.equal(c.lanes.young.enabled, false);
  assert.equal(c.lanes.young.requested, true); // asked for, but not possible: the log says why
});

test("lane config is validated", () => {
  assert.throws(() => loadConfig({ LANES: "fresh,ancient" }), /unknown lane 'ancient'/);
  assert.throws(() => loadConfig({ YOUNG_MIN_MARKET_CAP_USD: "900000000", YOUNG_MAX_MARKET_CAP_USD: "1000" }), /YOUNG_MIN_MARKET_CAP_USD/);
  assert.throws(() => loadConfig({ VETERAN_MIN_BUYS: "999" }), /VETERAN_MIN_TRADES/);
  assert.throws(() => loadConfig({ YOUNG_BUY_AMOUNT_SOL: "5" }), /YOUNG_BUY_AMOUNT_SOL/);
  assert.throws(() => loadConfig({ YOUNG_SOCIAL_MODE: "maybe" }), /YOUNG_SOCIAL_MODE/);
  assert.throws(() => loadConfig({ YOUNG_PULLBACK_PCT: "5" }), /YOUNG_PULLBACK_PCT/);
});

test("buildLanes does not mutate or alias the base config", () => {
  const base = { ...loadConfig({}) };
  delete base.lanes;
  const lanes = buildLanes({}, base);
  lanes.fresh.cfg.minTrades = 999;
  assert.notEqual(base.minTrades, 999);
  assert.equal(lanes.fresh.cfg.lanes, undefined);
});

test("buyerCount prefers the GeckoTerminal count when present", () => {
  assert.equal(buyerCount({ buyers: new Set(["a", "b"]) }), 2);
  assert.equal(buyerCount({ buyers: new Set(["a"]), buyersOverride: 42 }), 42);
  assert.equal(buyerCount({ buyers: new Set(["a"]), buyersOverride: null }), 1);
  assert.equal(buyerCount({ buyers: new Set(["a"]), buyersOverride: 0 }), 0);
});
