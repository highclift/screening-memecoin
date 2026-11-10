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
  const p = pipeline();
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
  const p = pipeline();
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
  const p = pipeline();
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
