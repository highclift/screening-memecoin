// The handoff: bot 1 screens -> bot 2 judges -> bot 3 buys and sells.
// Everything here runs offline; the feed is a stub and the clock is passed in.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createUniverse } from "../src/universe.js";
import { createJournal } from "../src/journal.js";
import { createDevBook } from "../src/devbook.js";
import { createFilter } from "../src/bots/filter.js";
import { createExecutor } from "../src/bots/executor.js";
import { createScreener } from "../src/bots/screener.js";
import { freshState } from "../src/state.js";

const SOL_USD = 150;
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chain-")), name);

// A coin that is clearly pumping, with whatever market cap the test asks for.
const pumping = (marketCapUsd, extra = {}) => ({
  marketCapUsd,
  liquidityUsd: Math.round(marketCapUsd * 0.15),
  volumeH24Usd: 240_000,
  volumeH1Usd: 180_000,
  buysH1: 420,
  sellsH1: 180,
  tradesH1: 600,
  buyersH1: 150,
  priceChangeH1: 22,
  ...extra,
});

// Builds the three bots over one universe, with the journals pointed at a temp directory.
function pipeline(settings = {}) {
  const config = loadConfig({ ...settings, MODE: "paper" });
  const universe = createUniverse();
  const account = freshState(config.paperStartBalanceSol);
  const devBook = createDevBook({ filePath: null });
  const journals = {
    screener: createJournal({ filePath: tmpFile("bot1.jsonl") }),
    filter: createJournal({ filePath: tmpFile("bot2.jsonl") }),
    executor: createJournal({ filePath: tmpFile("bot3.jsonl") }),
  };
  const logs = [];
  const log = (message) => logs.push(message);
  const note = () => {};

  const executor = createExecutor({
    config,
    universe,
    journal: journals.executor,
    account,
    persist: () => {},
    solUsd: () => SOL_USD,
    isGreen: (mint) => filter.isGreen(mint),
    log,
    note,
  });
  const filter = createFilter({
    config,
    universe,
    journal: journals.filter,
    devBook,
    log,
    note,
    onGreen: (record) => executor.watch(record),
    onDropped: (mint, why) => {
      if (!executor.holds(mint)) executor.unwatch(mint, why);
    },
  });

  // Exactly what src/index.js wires onScreened to do.
  const screen = (update, now) => {
    const record = universe.observe({ source: "dexscreener", ...update }, now);
    filter.consider(record, { now });
    executor.onData(record, now);
    return record;
  };

  return { config, universe, account, devBook, journals, logs, filter, executor, screen };
}

const linesOf = (journal) => {
  journal.flush();
  return fs.readFileSync(journal.filePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

// Steps a coin up until bot 3 buys it (or gives up). How big a bounce it waits for is its own
// business — the caller only insists that it does eventually buy.
function climbUntilEntry(p, mint, from, startAt) {
  let marketCapUsd = from;
  let now = startAt;
  for (let step = 0; step < 8 && !p.executor.status().openPositions; step += 1) {
    marketCapUsd = Math.round(marketCapUsd * 1.03);
    now = feed(p, mint, [marketCapUsd], now);
  }
  return { now, marketCapUsd };
}

test("a coin walks the whole chain: screened, judged green, watched by bot 3", () => {
  const p = pipeline();
  const now = 1_700_000_000_000;
  const record = p.screen({ mint: "AAA", symbol: "AAA", ageSeconds: 7200, ...pumping(400_000) }, now);

  assert.equal(record.verdict.state, "green", JSON.stringify(record.verdict));
  assert.ok(p.filter.isGreen("AAA"));
  assert.deepEqual(p.executor.priorityMints(), ["AAA"], "bot 3 asks bot 1 to poll what it is watching");
  assert.equal(p.executor.status().watchingCount, 1);
  assert.equal(p.executor.status().watching[0].waitingFor, "measure", "it will not buy a coin it has not measured");
  assert.equal(record.pinned, true, "a coin bot 2 likes is never evicted from the registry");
});

test("the jeanphil case: a month-old coin is red while it sleeps and green the hour it wakes up", () => {
  const p = pipeline();
  const month = 30 * 86_400;
  let now = 1_700_000_000_000;

  const asleep = {
    mint: "JEAN", symbol: "JEANPHIL", ageSeconds: month,
    marketCapUsd: 450_000, liquidityUsd: 60_000,
    volumeH24Usd: 240_000, volumeH1Usd: 9_000,
    buysH1: 20, sellsH1: 22, tradesH1: 42, buyersH1: 12, priceChangeH1: -2,
  };

  // Screened over and over for a month, turned down every time. Never dropped, never blacklisted.
  for (let i = 0; i < 20; i += 1) {
    now += 60_000;
    const record = p.screen(asleep, now);
    assert.equal(record.verdict.state, "red");
    assert.equal(record.verdict.category, "low_score");
  }
  assert.equal(p.filter.isGreen("JEAN"), false);

  // Then its volume jumps off its own baseline: the same rules now say green.
  now += 60_000;
  const awake = p.screen({ ...asleep, volumeH1Usd: 180_000, buysH1: 420, sellsH1: 180, tradesH1: 600, buyersH1: 150, priceChangeH1: 22 }, now);
  assert.equal(awake.verdict.state, "green");
  assert.ok(awake.verdict.surgeRatio > 10, `surge ${awake.verdict.surgeRatio}`);
  assert.equal(awake.verdict.lead, "surge");
  assert.ok(p.filter.isGreen("JEAN"));

  // And it is handed to bot 3 like any other coin — age played no part in any of this.
  assert.ok(p.executor.priorityMints().includes("JEAN"));
  assert.ok(p.logs.some((line) => line.includes("GREEN JEANPHIL")));

  const verdicts = linesOf(p.journals.filter);
  const last = verdicts[verdicts.length - 1];
  assert.equal(last.state, "green");
  assert.equal(last.type, "verdict", "a state change is logged as a change, not as a routine recheck");
  assert.ok(last.ageSeconds >= month, "the log says how old the coin was");
  assert.ok(last.surgeRatio > 10, "and what made it green");
  // The month of red answers is logged once as a change, then only as occasional rechecks, so the
  // file stays readable while still showing the coin going through.
  assert.equal(verdicts.filter((row) => row.type === "verdict").length, 2);
  assert.ok(verdicts.length < 10, `20 screenings produced ${verdicts.length} log lines`);
});

test("bot 2 keeps judging: a coin that stops pumping loses green and bot 3 drops it", () => {
  const p = pipeline();
  let now = 1_700_000_000_000;
  p.screen({ mint: "BBB", symbol: "BBB", ageSeconds: 7200, ...pumping(400_000) }, now);
  assert.ok(p.filter.isGreen("BBB"));

  now += 20_000; // past the rescore interval
  const record = p.screen({ mint: "BBB", volumeH1Usd: 3_000, buysH1: 10, sellsH1: 30, tradesH1: 40, buyersH1: 4, priceChangeH1: -30 }, now);
  assert.equal(record.verdict.state, "red");
  assert.equal(p.filter.isGreen("BBB"), false);
  assert.equal(p.executor.status().watchingCount, 0, "bot 3 does not buy what bot 2 took back");
});

test("bot 2 rejects an untradable coin before scoring it, and a rugged dev outright", () => {
  const p = pipeline();
  const now = 1_700_000_000_000;

  const thin = p.screen({ mint: "THIN", ...pumping(400_000), liquidityUsd: 900 }, now);
  assert.equal(thin.verdict.state, "red");
  assert.equal(thin.verdict.category, "liquidity");
  assert.equal(thin.verdict.score, undefined, "no score is computed for a coin that cannot be traded");

  const nodata = p.screen({ mint: "NEW1", ageSeconds: 5 }, now);
  assert.equal(nodata.verdict.state, "wait");
  assert.equal(nodata.verdict.category, "no_data");

  p.devBook.recordLaunch("dev-rug", "RUG1");
  p.devBook.recordRug("RUG1");
  const rugged = p.screen({ mint: "RUG1", ...pumping(400_000) }, now);
  assert.equal(rugged.verdict.state, "red");
  assert.equal(rugged.verdict.category, "dev_history");
});

// 11 samples over 50s: enough for bot 3 to measure the coin. Drifting up, so no dip yet.
const CLIMB = [100_000, 101_500, 103_000, 102_000, 104_000, 106_000, 105_000, 107_000, 109_000, 108_000, 110_000];

function feed(p, mint, series, startAt) {
  let now = startAt;
  for (const marketCapUsd of series) {
    p.screen({ mint, symbol: mint, ageSeconds: 7200, ...pumping(marketCapUsd) }, now);
    now += 5000;
  }
  return now;
}

// The whole run: climb (so bot 3 can measure the coin), deep dip, then a recovery.
function walkToEntry(p, mint, startAt = 1_700_000_000_000) {
  let now = feed(p, mint, CLIMB, startAt);
  now = feed(p, mint, [96_000, 92_000, 88_000], now);
  assert.equal(p.executor.status().openPositions, 0, "a falling coin is not bought");
  return climbUntilEntry(p, mint, 88_000, now);
}

test("bot 3 measures first, then buys the dip-and-bounce and sets stops from that coin's own swing", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  const now = feed(p, "CCC", CLIMB, 1_700_000_000_000);
  assert.equal(p.executor.status().openPositions, 0, "a coin that only goes up is never bought");
  assert.equal(p.executor.status().watching[0].waitingFor, "dip");
  assert.ok(p.executor.status().watching[0].volPct > 0, "it has measured how much this coin moves");

  const dipped = feed(p, "CCC", [96_000, 92_000, 88_000], now);
  assert.equal(p.executor.status().openPositions, 0);
  assert.equal(p.executor.status().watching[0].waitingFor, "bounce", "the dip registered; now it wants buyers back");

  climbUntilEntry(p, "CCC", 88_000, dipped);
  const status = p.executor.status();
  assert.equal(status.openPositions, 1, "the bounce is the trigger");
  const position = status.positions[0];
  assert.ok(position.stopPct > 0 && position.stopPct <= 0.3);
  assert.ok(position.trailPct > 0 && position.trailPct < position.stopPct, "the trail is tighter than the hard stop");
  assert.equal(p.account.balanceSol, p.config.paperStartBalanceSol - p.config.buyAmountSol);
  assert.equal(p.account.daily.entries, 1);

  const entries = linesOf(p.journals.executor).filter((row) => row.type === "entry");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].trigger, "dip-and-bounce");
  assert.ok(entries[0].levels.volPct > 0, "the log records the levels it chose and why");
  assert.ok(entries[0].dipFromPeakPct > 0 && entries[0].reboundPct > 0);
});

test("bot 3 exits on its own trailing stop, and the trade lands in the account", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  const { now, marketCapUsd } = walkToEntry(p, "DDD");
  assert.equal(p.executor.status().openPositions, 1, "needs a position before it can exit one");
  const position = p.executor.status().positions[0];

  // Up a little (so the peak moves), then down through the trail measured from that peak.
  const peak = Math.round(marketCapUsd * 1.05);
  let clock = feed(p, "DDD", [peak], now);
  feed(p, "DDD", [Math.round(peak * (1 - position.trailPct - 0.02))], clock);

  const status = p.executor.status();
  assert.equal(status.openPositions, 0, "it got out by itself");
  assert.equal(status.closedTrades.length, 1);
  const trade = status.closedTrades[0];
  assert.ok(["trail", "trail-locked", "stop-loss"].includes(trade.reason), `exit reason ${trade.reason}`);
  assert.ok(Math.abs(p.account.balanceSol - (p.config.paperStartBalanceSol + trade.pnlSol)) < 1e-9);
  assert.equal(status.wins + status.losses, 1);

  const exits = linesOf(p.journals.executor).filter((row) => row.type === "exit");
  assert.equal(exits.length, 1);
  assert.ok(exits[0].heldSeconds >= 0);
  assert.ok(exits[0].levels.trailPct > 0, "the exit log says which levels it was using");
});

test("bot 3 will not trade a dip that is only two sources disagreeing", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  let now = 1_700_000_000_000;
  // Measured and climbing on GeckoTerminal's numbers, which report FDV for this coin: ~$850k.
  for (const marketCapUsd of CLIMB) {
    p.screen({ mint: "FDV1", symbol: "FDV1", ageSeconds: 7200, ...pumping(marketCapUsd * 8), source: "gecko:top" }, now);
    now += 5000;
  }
  assert.equal(p.executor.status().watching[0].waitingFor, "dip");

  // DexScreener then reports the same coin at $120k — circulating rather than fully diluted. That
  // is a different definition, not an 86% crash, and the old peak would make the next tick up look
  // like a textbook bounce.
  p.screen({ mint: "FDV1", ...pumping(120_000), source: "dexscreener" }, now);
  now += 5000;
  p.screen({ mint: "FDV1", ...pumping(126_000), source: "dexscreener" }, now);

  const status = p.executor.status();
  assert.equal(status.openPositions, 0, "it did not buy the imaginary bounce");
  assert.equal(status.watching[0].waitingFor, "measure", "it starts measuring again on the new yardstick");
  assert.equal(status.watching[0].peakMarketCapUsd, 120_000, "and forgets the peak it measured differently");
});

// Drives a coin that is already held to a given market cap, repeatedly, and returns the trade if
// bot 3 closed it.
function pushTo(p, mint, series, startAt) {
  let now = startAt;
  for (const marketCapUsd of series) {
    p.screen({ mint, symbol: mint, ageSeconds: 7200, ...pumping(marketCapUsd) }, now);
    now += 5000;
  }
  return { now, trade: p.executor.status().closedTrades[0] ?? null };
}

test("bot 3 lets a winner run instead of taking a fixed profit", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  const { now, marketCapUsd } = walkToEntry(p, "RUNNER");
  assert.equal(p.executor.status().openPositions, 1);
  const { stopPct, trailPct } = p.executor.status().positions[0];

  // Up and up. An old-style take-profit target would have sold somewhere in here.
  let clock = now;
  let price = marketCapUsd;
  for (let step = 0; step < 12; step += 1) {
    price = Math.round(price * 1.08);
    clock = pushTo(p, "RUNNER", [price], clock).now;
  }
  const status = p.executor.status();
  assert.equal(status.openPositions, 1, `sold early at +${((price / marketCapUsd - 1) * 100).toFixed(0)}%`);
  assert.ok(price / marketCapUsd > 2, "the coin more than doubled and bot 3 is still holding");
  assert.ok(stopPct > 0 && trailPct > 0);

  // Only when it finally gives back more than the trail does it sell — and it keeps the gain.
  const peak = price;
  pushTo(p, "RUNNER", [Math.round(peak * 0.7)], clock);
  const closed = p.executor.status().closedTrades[0];
  assert.ok(closed, "the trail ended the trade");
  assert.equal(closed.reason, "trail-locked");
  assert.ok(closed.pnlSol > 0, `a doubled coin should close green, got ${closed.pnlSol}`);
});

test("bot 3 will not let a trade that was well up turn into a loss", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  const { now, marketCapUsd } = walkToEntry(p, "GIVEBACK");
  const entry = linesOf(p.journals.executor).find((row) => row.type === "entry");
  assert.ok(entry.levels.lockPct > 0 && entry.levels.breakEvenPct >= 0, "the trade recorded its levels");

  // Up past the lock threshold, so the flat floor ratchets to break-even...
  const high = Math.round(marketCapUsd * 1.35);
  let clock = pushTo(p, "GIVEBACK", [high], now).now;
  assert.equal(p.executor.status().openPositions, 1);

  // ...then all the way back down. It must not ride it to the original stop.
  pushTo(p, "GIVEBACK", [Math.round(marketCapUsd * 1.0)], clock);
  const closed = p.executor.status().closedTrades[0];
  assert.ok(closed, "it closed rather than giving everything back");
  assert.ok(["break-even", "trail-locked"].includes(closed.reason), `closed as ${closed.reason}`);
  assert.ok(closed.exitMarketCapUsd >= marketCapUsd * 0.95, "it got out near where it went in");
});

test("a locked trade that gaps through the floor is reported as the loss it was", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  const { now, marketCapUsd } = walkToEntry(p, "GAPPY");
  // Well up, so the break-even floor arms...
  let clock = pushTo(p, "GAPPY", [Math.round(marketCapUsd * 1.4)], now).now;
  assert.equal(p.executor.status().openPositions, 1);
  // ...then one tick straight through it to below entry. Polling is every couple of seconds, so
  // this happens; the label must not claim break-even on a losing exit.
  pushTo(p, "GAPPY", [Math.round(marketCapUsd * 0.8)], clock);
  const closed = p.executor.status().closedTrades[0];
  assert.ok(closed);
  assert.ok(closed.pnlSol < 0, "it was a loss");
  assert.notEqual(closed.reason, "break-even", "a losing exit must not be filed as break-even");
});

test("bot 3 still cuts a trade that never worked", () => {
  const p = pipeline({ ENTRY_MODE: "dip" });
  const { now, marketCapUsd } = walkToEntry(p, "DUD");
  const { stopPct } = p.executor.status().positions[0];
  // Straight down from entry, past the flat stop.
  pushTo(p, "DUD", [Math.round(marketCapUsd * (1 - stopPct - 0.03))], now);
  const closed = p.executor.status().closedTrades[0];
  assert.ok(closed);
  assert.ok(["stop-loss", "trail"].includes(closed.reason), `closed as ${closed.reason}`);
  assert.ok(closed.pnlSol < 0);
});

test("bot 3 buys a coin that climbs without ever dipping", () => {
  // The case that made this mode exist: a steady climber never pulls back 1.2x its own move, so
  // dip-only would watch the whole run go past.
  const p = pipeline({ ENTRY_MODE: "both" });
  feed(p, "CLIMBER", CLIMB, 1_700_000_000_000);
  const status = p.executor.status();
  assert.equal(status.openPositions, 1, "a coin that only goes up is still bought");

  const entry = linesOf(p.journals.executor).find((row) => row.type === "entry");
  assert.equal(entry.trigger, "breakout", "and the journal says which trigger fired");
  assert.equal(entry.dipFromPeakPct, 0);
  assert.ok(entry.levels.stopPct > 0, "it still sized its stop from the coin's own movement");
});

test("dip-only mode still refuses the climber, breakout-only still refuses the retrace", () => {
  const dipOnly = pipeline({ ENTRY_MODE: "dip" });
  feed(dipOnly, "CLIMBER", CLIMB, 1_700_000_000_000);
  assert.equal(dipOnly.executor.status().openPositions, 0);
  assert.equal(dipOnly.executor.status().watching[0].waitingFor, "dip");

  // Breakout-only: a coin falling back from its high is not bought, however far it bounces.
  const breakoutOnly = pipeline({ ENTRY_MODE: "breakout" });
  const now = feed(breakoutOnly, "FADER", CLIMB, 1_700_000_000_000);
  assert.equal(breakoutOnly.executor.status().openPositions, 1, "it bought the first new high");
  // Now a second coin that only ever falls: no new high, no entry.
  feed(breakoutOnly, "FALLER", [100_000, 99_000, 97_000, 96_000, 94_000, 93_000, 92_000, 91_000, 90_000, 89_000, 88_000], now);
  const waiting = breakoutOnly.executor.status().watching.find((c) => c.mint === "FALLER");
  assert.ok(waiting, "still watching it");
  assert.ok(["high", "measure"].includes(waiting.waitingFor), `waiting for ${waiting.waitingFor}`);
});

test("a breakout entry still refuses a vertical candle and a seller-dominated coin", () => {
  // Same fill guards as the dip entry: bot 2 judged the coin, these are about the price paid.
  // Drifting down from the first sample, so no new high is set and nothing is bought while it
  // measures...
  const spiky = pipeline({ ENTRY_MODE: "breakout" });
  let now = feed(spiky, "SPIKE", [120_000, 118_000, 116_000, 115_000, 113_000, 112_000, 110_000, 109_000, 108_000, 107_000, 106_000], 1_700_000_000_000);
  assert.equal(spiky.executor.status().openPositions, 0);

  // ...then one vertical candle straight past the old high. That is a terrible fill, so it waits
  // for the next measurement instead of buying the spike.
  feed(spiky, "SPIKE", [260_000], now);
  assert.equal(spiky.executor.status().openPositions, 0, "it did not buy the vertical candle");
  assert.equal(spiky.executor.status().watching[0].waitingFor, "spike");

  const sellers = pipeline({ ENTRY_MODE: "breakout" });
  let clock = 1_700_000_000_000;
  for (const marketCapUsd of CLIMB) {
    // Green on volume, but sellers dominate the hour: the fill guard blocks it.
    sellers.screen({
      mint: "SELLY", symbol: "SELLY", ageSeconds: 7200,
      ...pumping(marketCapUsd), buysH1: 150, sellsH1: 450, tradesH1: 600,
    }, clock);
    clock += 5000;
  }
  assert.equal(sellers.executor.status().openPositions, 0, "not bought while sellers dominate");
  assert.equal(sellers.executor.status().watching[0].waitingFor, "buyers");
});

test("bot 3 holds off when a money limit says no, and keeps watching the coin", () => {
  const p = pipeline({ MAX_ENTRIES_PER_DAY: "1", PAPER_START_BALANCE_SOL: "1", BUY_AMOUNT_SOL: "0.01" });
  p.account.daily.entries = 1; // the day's one entry is already spent
  walkToEntry(p, "EEE");
  const status = p.executor.status();
  assert.equal(status.openPositions, 0);
  assert.match(status.blockedReason, /entry per hari/);
  assert.equal(status.watchingCount, 1, "the coin is still watched in case the limit frees up");
  assert.equal(p.account.balanceSol, 1, "nothing was spent");
});

test("bot 1 screens launches and migrations and logs every coin it sees", () => {
  const p = pipeline();
  const filePath = tmpFile("bot1-feed.jsonl");
  const journal = createJournal({ filePath });
  const stubFeed = {
    canSweep: () => true,
    sweep: async () => [],
    pools: async () => [],
    snapshots: async () => new Map(),
    solUsd: () => SOL_USD,
    geckoCallsUsed: () => 0,
  };
  const screener = createScreener({
    config: p.config,
    universe: p.universe,
    feed: stubFeed,
    journal,
    devBook: p.devBook,
    log: () => {},
    note: () => {},
    onScreened: (record, meta) => {
      p.filter.consider(record, meta);
      p.executor.onData(record, meta.now);
    },
  });

  screener.onLaunch({ mint: "LAU1", name: "Launchy", symbol: "LAU", traderPublicKey: "dev-x" });
  screener.onMigration({ mint: "MIG1", symbol: "MIG", pool: "pool-1" });
  screener.onLaunch({ mint: "LAU1", symbol: "LAU", traderPublicKey: "dev-x" }); // seen again

  const status = screener.status();
  assert.equal(status.coins, 2, "two distinct coins");
  assert.equal(status.observations, 3);
  assert.equal(status.launches, 2);
  assert.equal(status.migrations, 1);
  assert.ok(status.perMinute >= 3);
  assert.equal(p.devBook.assess("LAU1", { maxDevLaunches: 5 }).verdict, "clean", "the creator was remembered");

  const lines = linesOf(journal, filePath);
  assert.equal(lines.filter((row) => row.type === "new").length, 2, "every new coin is logged");
  assert.equal(lines[0].mint, "LAU1");
  assert.equal(lines[0].source, "launch");
  journal.stop();
});

test("bot 1 keeps re-checking coins that went quiet — that is how a revival is caught", async () => {
  const p = pipeline();
  const now = 1_700_000_000_000;
  // A coin met two hours ago that has done nothing since. The old rotation dropped anything idle
  // for 30 minutes, which meant the one coin most likely to wake up was the one we stopped looking
  // at.
  p.universe.observe({ mint: "SLEEPY", symbol: "SLEEPY", marketCapUsd: 300_000, source: "gecko:top" }, now - 2 * 3_600_000);
  for (let i = 0; i < 5; i += 1) {
    p.universe.observe({ mint: `other-${i}`, marketCapUsd: 100_000, source: "gecko:top" }, now);
  }

  const asked = [];
  const journal = createJournal({ filePath: tmpFile("bot1-recheck.jsonl") });
  const screener = createScreener({
    config: { ...p.config, refreshCallsPerTick: 1, refreshBatchSize: 30 },
    universe: p.universe,
    feed: {
      canSweep: () => false, // GeckoTerminal paused: the re-check must not depend on it
      sweep: async () => [],
      pools: async () => [],
      snapshots: async (mints) => {
        asked.push(...mints);
        return new Map();
      },
      solUsd: () => SOL_USD,
      geckoCallsUsed: () => 0,
    },
    journal,
    devBook: p.devBook,
    log: () => {},
    note: () => {},
    onScreened: () => {},
  });

  screener.start();
  await new Promise((resolve) => setTimeout(resolve, 2300));
  screener.stop();
  journal.stop();

  assert.ok(asked.includes("SLEEPY"), "a coin idle for two hours is still in the rotation");
  assert.equal(new Set(asked).size, 6, "and so is everything else we know about");
  // How long a full pass takes, which with six coins and 900 refreshes a minute rounds to nothing.
  const { recheckSeconds } = screener.status();
  assert.ok(Number.isFinite(recheckSeconds) && recheckSeconds >= 0, `recheckSeconds was ${recheckSeconds}`);
  assert.ok(recheckSeconds < 5, "a tiny registry is re-checked almost immediately");
});

test("bot 1 screens a sweep page without judging any of it", async () => {
  const p = pipeline();
  const filePath = tmpFile("bot1-sweep.jsonl");
  const journal = createJournal({ filePath });
  const SOL = "So11111111111111111111111111111111111111112";
  const rows = [
    // A month-old coin and a brand-new one come back from the same page and are treated the same.
    { pool: "p1", mint: "OLD1", quoteMint: SOL, symbol: "OLD", ageSeconds: 45 * 86_400, marketCapUsd: 800_000, liquidityUsd: 90_000, volumeH1Usd: 150_000, volumeH24Usd: 400_000, buysH1: 300, tradesH1: 400, buyersH1: 120, priceChangeH1: 12 },
    { pool: "p2", mint: "NEW2", quoteMint: SOL, symbol: "NEW", ageSeconds: 300, marketCapUsd: 60_000, liquidityUsd: 12_000, volumeH1Usd: 30_000, volumeH24Usd: 30_000, buysH1: 150, tradesH1: 200, buyersH1: 70, priceChangeH1: 40 },
    { pool: "p3", mint: SOL, quoteMint: SOL, symbol: "SOL", ageSeconds: 1000 }, // not a memecoin
  ];
  const screener = createScreener({
    config: { ...p.config, discoveryTickMs: 10_000, refreshIntervalMs: 10_000 },
    universe: p.universe,
    feed: {
      canSweep: () => true,
      sweep: async () => rows,
      pools: async () => [],
      snapshots: async () => new Map(),
      solUsd: () => SOL_USD,
      geckoCallsUsed: () => 1,
    },
    journal,
    devBook: p.devBook,
    log: () => {},
    note: () => {},
    onScreened: (record, meta) => p.filter.consider(record, meta),
  });

  screener.start();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  screener.stop();

  const status = screener.status();
  assert.equal(status.coins, 2, "the SOL pool is not a memecoin and is skipped");
  assert.ok(p.universe.get("OLD1"), "a 45-day-old coin is screened like any other");
  assert.ok(p.universe.get("NEW2"));
  assert.equal(p.universe.get(SOL), null);
  assert.equal(status.sources["gecko:new"] > 0, true);
  journal.stop();
});
