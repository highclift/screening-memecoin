import test from "node:test";
import assert from "node:assert/strict";
import { createUniverse } from "../src/universe.js";

test("observe: each source fills in what it knows and never wipes what it does not", () => {
  const u = createUniverse();
  const now = 1_700_000_000_000;

  // A launch event: a name and nothing else.
  u.observe({ mint: "AAA", symbol: "AAA", name: "Coin A", source: "launch" }, now);
  // A sweep row: the numbers, no socials.
  u.observe({ mint: "AAA", marketCapUsd: 400_000, liquidityUsd: 40_000, buyersH1: 60, source: "gecko:top" }, now + 2000);
  // A DexScreener refresh that happens not to report a buyer count.
  const record = u.observe({ mint: "AAA", marketCapUsd: 420_000, buyersH1: null, buysH1: undefined, source: "dexscreener" }, now + 4000);

  assert.equal(record.symbol, "AAA");
  assert.equal(record.name, "Coin A");
  assert.equal(record.marketCapUsd, 420_000, "a newer number wins");
  assert.equal(record.liquidityUsd, 40_000, "a source that is silent about a field leaves it alone");
  assert.equal(record.buyersH1, 60, "null means 'this source does not know', not 'zero'");
  assert.equal(record.observations, 3);
  assert.deepEqual(record.sources, { launch: 1, "gecko:top": 1, dexscreener: 1 });
  assert.equal(u.size, 1);
});

test("observe: snapshots are the bot's own price history, rate limited and capped", () => {
  const u = createUniverse({ maxSnapshots: 5 });
  const now = 1_700_000_000_000;
  u.observe({ mint: "BBB", marketCapUsd: 100 }, now);
  u.observe({ mint: "BBB", marketCapUsd: 101 }, now + 200); // too soon to be a separate sample
  let record = u.observe({ mint: "BBB", marketCapUsd: 102 }, now + 1500);
  assert.equal(record.snapshots.length, 2);
  assert.deepEqual(record.snapshots.map((s) => s.marketCapUsd), [100, 102]);

  for (let i = 0; i < 10; i += 1) record = u.observe({ mint: "BBB", marketCapUsd: 200 + i }, now + 3000 + i * 1500);
  assert.equal(record.snapshots.length, 5, "capped: only the recent history is kept");
  assert.equal(record.snapshots[4].marketCapUsd, 209);

  const noPrice = u.observe({ mint: "CCC", liquidityUsd: 1000 }, now);
  assert.equal(noPrice.snapshots.length, 0, "no market cap, no snapshot");
});

test("age: moves forward with the clock and never goes backwards", () => {
  const u = createUniverse();
  const now = 1_700_000_000_000;
  const record = u.observe({ mint: "DDD", ageSeconds: 3600 }, now);
  assert.equal(u.ageSeconds(record, now), 3600);
  assert.equal(u.ageSeconds(record, now + 600_000), 4200, "ten minutes later the coin is ten minutes older");

  // A stale listing must not make a coin look younger than it is.
  u.observe({ mint: "DDD", ageSeconds: 60 }, now + 600_000);
  assert.ok(u.ageSeconds(record, now + 600_000) >= 3600);
  assert.equal(u.ageSeconds(u.observe({ mint: "EEE" }, now), now), null, "unknown age stays unknown");
});

test("eviction: the registry is bounded, but never drops a coin the other bots care about", () => {
  const u = createUniverse({ maxTokens: 100 });
  const now = 1_700_000_000_000;
  u.observe({ mint: "KEEP", marketCapUsd: 1 }, now);
  u.pin("KEEP", true);

  for (let i = 0; i < 200; i += 1) u.observe({ mint: `coin-${i}` }, now + i);
  assert.ok(u.size <= 100, `size ${u.size}`);
  assert.ok(u.get("KEEP"), "a pinned coin survives: bot 2 greenlit it or bot 3 holds it");
  assert.ok(u.get("coin-199"), "the coin seen most recently is still there");
  assert.equal(u.get("coin-0"), null, "the coin seen longest ago made room");

  u.pin("KEEP", false);
  for (let i = 200; i < 400; i += 1) u.observe({ mint: `coin-${i}` }, now + i);
  assert.equal(u.get("KEEP"), null, "once nobody needs it, it is evictable like anything else");
});

test("market cap comes from one source at a time, because the two disagree", () => {
  const u = createUniverse();
  const now = 1_700_000_000_000;

  // GeckoTerminal fills the gap first (it reports market_cap_usd, else FDV).
  let record = u.observe({ mint: "FFF", marketCapUsd: 800_000, liquidityUsd: 50_000, source: "gecko:top" }, now);
  assert.equal(record.marketCapUsd, 800_000);
  assert.equal(record.marketCapSource, "gecko:top");

  // DexScreener reports the same coin far lower (one is FDV, the other circulating). Its number
  // wins, and the history measured against the old yardstick is thrown away rather than read as a
  // 90% crash.
  record = u.observe({ mint: "FFF", marketCapUsd: 80_000, liquidityUsd: 50_000, source: "dexscreener" }, now + 2000);
  assert.equal(record.marketCapUsd, 80_000);
  assert.equal(record.marketCapSource, "dexscreener");
  assert.equal(record.marketCapEpoch, 1, "bot 3 is told to start measuring again");
  assert.equal(record.snapshots.length, 1, "the old snapshots were measured differently");

  // From now on a GeckoTerminal row cannot pull the market cap back to its own definition.
  record = u.observe({ mint: "FFF", marketCapUsd: 800_000, volumeH1Usd: 1234, source: "gecko:pool" }, now + 4000);
  assert.equal(record.marketCapUsd, 80_000, "the trusted source stays in charge");
  assert.equal(record.volumeH1Usd, 1234, "everything else from that row is still used");
  assert.equal(record.marketCapEpoch, 1);
});

test("a market cap of zero is missing data, not a worthless coin", () => {
  const u = createUniverse();
  const now = 1_700_000_000_000;
  const record = u.observe({ mint: "ZZZ", marketCapUsd: 500_000, liquidityUsd: 40_000, source: "dexscreener" }, now);
  u.observe({ mint: "ZZZ", marketCapUsd: 0, liquidityUsd: 0, volumeH1Usd: 0, source: "gecko:top" }, now + 2000);
  assert.equal(record.marketCapUsd, 500_000, "both APIs report an unknown market cap as 0 as often as null");
  assert.equal(record.liquidityUsd, 40_000);
  assert.equal(record.volumeH1Usd, 0, "but a volume of zero is real: that is a quiet hour");
});

test("observe: a sighting with no mint is ignored", () => {
  const u = createUniverse();
  assert.equal(u.observe({ symbol: "NOPE" }), null);
  assert.equal(u.observe({ mint: 42 }), null);
  assert.equal(u.size, 0);
});
