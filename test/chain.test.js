// The handoffs: scout -> filter -> analyst -> executor <-> risk, with the logger underneath.
// Everything here runs offline; the feed, RugCheck and the clock are all stubbed.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { createUniverse } from "../src/universe.js";
import { createJournal } from "../src/journal.js";
import { createDevBook } from "../src/devbook.js";
import { createSmartWallets } from "../src/smartwallets.js";
import { createLogger } from "../src/agents/logger.js";
import { createFilter } from "../src/agents/filter.js";
import { createAnalyst } from "../src/agents/analyst.js";
import { createRisk } from "../src/agents/risk.js";
import { createExecutor } from "../src/agents/executor.js";
import { windowReason } from "../src/agents/scout.js";
import { freshState } from "../src/state.js";

const SOL_USD = 150;
const START = 1_700_000_000_000;
const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "desk-")), name);

// A coin that is trading well, at whatever market cap the test asks for.
const healthy = (marketCapUsd, extra = {}) => ({
  marketCapUsd,
  liquidityUsd: Math.round(marketCapUsd * 0.15),
  volumeH24Usd: 240_000,
  volumeH1Usd: 180_000,
  buysH1: 420,
  sellsH1: 180,
  tradesH1: 600,
  buyersH1: 150,
  sellersH1: 90,
  priceChangeH1: 22,
  ...extra,
});

// A RugCheck report with nothing wrong with it. Tests override one field at a time.
const cleanReport = (overrides = {}) => ({
  mintAuthority: null,
  freezeAuthority: null,
  lpLockedPct: 100,
  lpLockedUsd: 50_000,
  marketType: "pump_fun_amm",
  marketCount: 1,
  totalLiquidityUsd: 60_000,
  creator: "Dev111",
  creatorPct: 0.5,
  creatorTokens: null,
  insiderNetworks: 0,
  insiderWallets: 0,
  insiderPct: 0,
  insiderEverPct: 0,
  flaggedHolderPct: 0,
  totalHolders: 900,
  rugged: false,
  riskScore: 1,
  launchpad: "pump_fun",
  detectedAt: START,
  ...overrides,
});

// Builds the six agents over one universe, with the journals in a temp directory.
function desk(settings = {}, { report = cleanReport(), reportError = null, buyers = null } = {}) {
  const config = loadConfig({ ...settings, MODE: "paper" });
  const universe = createUniverse();
  const account = freshState(config.paperStartBalanceSol);
  const devBook = createDevBook({ filePath: null });
  const smartWallets = createSmartWallets({ filePath: null });
  const journals = {
    scout: createJournal({ filePath: tmpFile("scout.jsonl") }),
    kills: createJournal({ filePath: tmpFile("kills.jsonl") }),
    trades: createJournal({ filePath: tmpFile("trades.jsonl") }),
  };
  const logs = [];
  const logger = createLogger({ journals, log: (line) => logs.push(line), note: () => {} });

  const rugcheckCalls = [];
  const rugcheck = {
    ready: () => true,
    used: () => rugcheckCalls.length,
    stats: () => ({ calls: rugcheckCalls.length }),
    async report(mint) {
      rugcheckCalls.push(mint);
      if (reportError) throw Object.assign(new Error(reportError), { notFound: true });
      return report;
    },
  };
  const feed = { buyers: async () => (buyers ? new Set(buyers) : null) };

  const risk = createRisk({ config, account, logger, persist: () => {} });
  const executor = createExecutor({
    config,
    universe,
    account,
    risk,
    logger,
    persist: () => {},
    solUsd: () => SOL_USD,
    isCandidate: (mint) => analyst.passes(mint),
    onRug: (mint) => devBook.recordRug(mint),
  });
  const analyst = createAnalyst({
    config,
    universe,
    feed,
    smartWallets,
    logger,
    onPassed: (record) => executor.watch(record),
    onDropped: (mint, why) => {
      if (!executor.holds(mint)) executor.unwatch(mint, why);
    },
  });
  const filter = createFilter({
    config,
    universe,
    devBook,
    rugcheck,
    logger,
    onPassed: (record, meta) => analyst.consider(record, meta),
    onKilled: (mint, why) => {
      analyst.withdraw(mint, why);
      if (!executor.holds(mint)) executor.unwatch(mint, why);
    },
  });

  // Exactly what the scout's handoff does in src/index.js, with the window check in front of it —
  // including the exemption for coins the executor is already acting on.
  const see = (update, now = START) => {
    const record = universe.observe({ source: "dexscreener", ageSeconds: 7200, ...update }, now);
    const held = executor.priorityMints().includes(record.mint);
    const outside = held ? null : windowReason(record, config.window, universe.ageSeconds(record, now));
    if (outside) {
      if (!outside.wait) logger.kill("scout", record, outside, now);
      return record;
    }
    filter.consider(record, { now });
    executor.onData(record, now);
    return record;
  };

  return { config, universe, account, devBook, smartWallets, journals, logs, logger, risk, filter, analyst, executor, see, rugcheckCalls };
}

const linesOf = (journal) => {
  journal.flush();
  if (!fs.existsSync(journal.filePath)) return [];
  return fs.readFileSync(journal.filePath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const killsOf = (p) => linesOf(p.journals.kills);
const tradesOf = (p) => linesOf(p.journals.trades);

// Market caps over time. 11 samples 5s apart is enough for the executor to measure the coin.
const CLIMB = [400_000, 406_000, 412_000, 408_000, 416_000, 424_000, 420_000, 428_000, 436_000, 432_000, 440_000];

// The safety check is a call, so its answer lands on a later turn. Wherever a coin has to get PAST
// the filter, the test has to let that answer arrive — the live desk gets it for free, because it
// re-judges every coin every RESCORE_INTERVAL_MS for as long as the scout keeps seeing it.
const settle = () => new Promise(setImmediate);

async function feed(p, mint, series, startAt, extra = {}) {
  let now = startAt;
  for (const marketCapUsd of series) {
    p.see({ mint, symbol: mint, ...healthy(marketCapUsd, extra) }, now);
    await settle();
    now += 5000;
  }
  return now;
}

// One coin, seen twice far enough apart to be re-judged with the safety answer in hand.
async function admit(p, update, now = START) {
  p.see(update, now);
  await settle();
  return p.see(update, now + 20_000);
}

test("the window is the scout's whole job: only what is inside it is handed on", async () => {
  const p = desk();

  // Too new to have a history, and past the point where the launch crowd has gone.
  p.see({ mint: "YOUNG", symbol: "YOUNG", ageSeconds: 600, ...healthy(400_000) });
  p.see({ mint: "OLD", symbol: "OLD", ageSeconds: 10 * 86_400, ...healthy(400_000) });
  // Inside the age window but outside the size band.
  p.see({ mint: "TINY", symbol: "TINY", ...healthy(80_000) });
  p.see({ mint: "HUGE", symbol: "HUGE", ...healthy(60_000_000) });

  assert.equal(p.filter.status().judged, 0, "nothing reached the filter");
  const kills = killsOf(p);
  assert.deepEqual(kills.map((k) => k.category), ["too_young", "too_old", "mcap_low", "mcap_high"]);
  assert.ok(kills.every((k) => k.stage === "scout"));
  assert.match(kills[0].detail, /10m old, the desk starts at 30m/);

  // And one inside the window goes all the way through.
  await admit(p, { mint: "GOOD", symbol: "GOOD", ...healthy(400_000) });
  assert.ok(p.filter.status().judged >= 1);
  assert.equal(p.universe.get("GOOD").filter.state, "pass");
});

test("a coin walks the whole chain: scouted, filtered, scored, watched by the executor", async () => {
  const p = desk();
  const record = await admit(p, { mint: "AAA", symbol: "AAA", ...healthy(400_000) });

  assert.equal(record.filter.state, "pass", JSON.stringify(record.filter));
  assert.ok(record.analysis.score >= 70, `scored ${record.analysis.score}`);
  assert.equal(p.analyst.passes("AAA"), true);
  assert.equal(p.executor.status().watchingCount, 1);
  assert.equal(p.executor.status().watching[0].waitingFor, "measure", "it will not buy a coin it has not measured");
  assert.equal(record.pinned, true, "a coin the desk wants is never evicted from the registry");
  assert.ok(p.logs.some((line) => line.includes("[analyst] AAA scores")));
});

test("the filter kills what the spec says it must, and says which rule did it", async () => {
  const cases = [
    ["mint_authority", { mintAuthority: "Dev111" }],
    ["freeze_authority", { freezeAuthority: "Dev111" }],
    ["lp_unlocked", { lpLockedPct: 42 }],
    ["dev_holding", { creatorPct: 7.5 }],
    ["bundled", { insiderPct: 18, insiderWallets: 9, insiderNetworks: 2 }],
    ["rugged", { rugged: true }],
  ];
  for (const [category, overrides] of cases) {
    const p = desk({}, { report: cleanReport(overrides) });
    const record = await admit(p, { mint: "BAD", symbol: "BAD", ...healthy(400_000) });
    assert.equal(record.filter.state, "kill", `${category} should kill`);
    assert.equal(record.filter.category, category);
    assert.equal(p.analyst.status().scored, 0, "a killed coin never reaches the analyst");
    assert.equal(killsOf(p)[0].stage, "filter");
  }

  // The local ones, which cost no call at all — so they kill on the very first sighting.
  const thin = desk().see({ mint: "THIN", symbol: "THIN", ...healthy(400_000, { liquidityUsd: 9_000 }) });
  assert.equal(thin.filter.category, "liquidity");
  const late = desk().see({ mint: "LATE", symbol: "LATE", ...healthy(400_000, { priceChangeH1: 140 }) });
  assert.equal(late.filter.category, "pumped_already");
});

test("a safety check that could not be made is a wait, never a pass", async () => {
  // The rule that matters most: unknown is not clean. A coin RugCheck has not indexed waits in
  // place and is looked at again, rather than going through unchecked.
  const p = desk({}, { reportError: "not indexed yet" });
  const record = await admit(p, { mint: "UNK", symbol: "UNK", ...healthy(400_000) });
  assert.equal(record.filter.state, "wait");
  assert.equal(record.filter.category, "safety_pending");
  assert.equal(p.analyst.status().scored, 0);
  assert.equal(p.executor.status().watchingCount, 0);
});

test("the analyst only passes 70+, and says what the score was made of", async () => {
  // A coin that is safe but dull: no momentum, few buyers, sellers taking over.
  const p = desk();
  const dull = await admit(p, {
    mint: "DULL",
    symbol: "DULL",
    ...healthy(400_000, { priceChangeH1: 1, buyersH1: 12, sellersH1: 11, buysH1: 60, sellsH1: 58, tradesH1: 118 }),
  });
  assert.equal(dull.filter.state, "pass", "nothing unsafe about it");
  assert.ok(dull.analysis.score < 70, `dull coin scored ${dull.analysis.score}`);
  assert.equal(p.analyst.passes("DULL"), false);

  const kill = killsOf(p).find((k) => k.stage === "analyst");
  assert.ok(kill, "the analyst's refusal is logged like any other kill");
  assert.equal(kill.category, "below_score");
  assert.match(kill.detail, /scored \d+, needs 70/);
  assert.ok(kill.parts.momentum !== undefined, "with the parts, so the weights can be argued with later");
});

test("risk sizes the trade at 8% of the balance and shrinks with the account", () => {
  const p = desk({ PAPER_START_BALANCE_SOL: "2" });
  assert.equal(p.risk.sizeSol(), 0.16);
  p.account.balanceSol = 0.5;
  assert.equal(p.risk.sizeSol(), 0.04, "8% of what is left, not 8% of what it started with");

  const tight = desk({ POSITION_PCT: "0.25", PAPER_START_BALANCE_SOL: "1" });
  assert.equal(tight.risk.sizeSol(), 0.25);
});

test("risk: the stop is fixed before entry, and nothing trails until +12%", () => {
  const p = desk({ PAPER_FEE_BPS: "0", PAPER_SLIPPAGE_BPS: "0" });
  const levels = p.risk.levelsFor(0.02);
  assert.equal(levels.stopPct, 0.06);
  assert.equal(levels.trailAfterPct, 0.12);

  const position = { openedAt: START, lastHighAt: START, entryMarketCapUsd: 100_000, peakMarketCapUsd: 100_000, levels, armed: false };
  const at = (mcap, peak = position.peakMarketCapUsd) => {
    position.peakMarketCapUsd = Math.max(peak, mcap);
    return p.risk.exitReason(position, mcap, START + 1000);
  };

  assert.equal(at(96_000), null, "-4% is inside the stop");
  assert.equal(at(94_000), "stop-loss", "-6% is the stop");

  // Up 13%: the trail arms. From there the floor never goes below break-even.
  const armedPos = { ...position, peakMarketCapUsd: 113_000, armed: true };
  assert.equal(p.risk.exitReason(armedPos, 112_000, START + 1000), null, "still near the peak");
  assert.equal(p.risk.exitReason(armedPos, 103_000, START + 1000), "trail", "8% off the peak, and still in profit");
  // A trade that was up 13% and came all the way back is closed at break-even, not at a loss.
  assert.equal(p.risk.exitReason(armedPos, 99_000, START + 1000), "stop-loss");
});

test("risk refuses entries on money limits, and the refusal is logged once per reason", () => {
  const p = desk({ MAX_OPEN_POSITIONS: "1" });
  p.account.positions.HELD = { mint: "HELD" };

  const record = { mint: "WANT", symbol: "WANT" };
  assert.match(p.risk.blockReason(record), /1 posisi terbuka/);
  p.risk.blockReason(record);
  p.risk.blockReason(record);
  const kills = killsOf(p).filter((k) => k.stage === "risk");
  assert.equal(kills.length, 1, "the same limit on every tick is one line, not a thousand");
  assert.equal(kills[0].category, "money_limit");

  delete p.account.positions.HELD;
  assert.equal(p.risk.blockReason(record), "", "and it lifts when the position closes");
});

test("the executor measures first, then buys, and the stop it entered with is the spec's", async () => {
  const p = desk({ ENTRY_MODE: "breakout" });
  let now = await feed(p, "CCC", CLIMB.slice(0, 4), START);
  assert.equal(p.executor.status().openPositions, 0, "not until it has been measured");

  now = await feed(p, "CCC", CLIMB.slice(4), now);
  const status = p.executor.status();
  assert.equal(status.openPositions, 1, JSON.stringify(status.watching[0]));
  const position = status.positions[0];
  assert.equal(position.stopPct, 0.06);
  assert.ok(Math.abs(position.costSol - 0.08) < 1e-9, `sized at ${position.costSol} SOL`);
  assert.ok(p.logs.some((line) => line.includes("[executor] BUY CCC")));

  // And it exits on the flat stop.
  await feed(p, "CCC", [Math.round(status.positions[0].entryMarketCapUsd * 0.9)], now);
  assert.equal(p.executor.status().openPositions, 0);
  const exit = tradesOf(p).filter((row) => row.type === "exit").pop();
  assert.equal(exit.reason, "stop-loss");
});

test("a coin that stops clearing the filter is taken off the executor's watchlist", async () => {
  const p = desk();
  await admit(p, { mint: "DDD", symbol: "DDD", ...healthy(400_000) });
  assert.equal(p.executor.status().watchingCount, 1);

  // The dev starts selling into it: the same coin, now failing a hard check.
  p.universe.get("DDD").rugcheck = { status: "ok", at: START + 20_000, ...cleanReport({ creatorPct: 40 }) };
  p.see({ mint: "DDD", ...healthy(400_000) }, START + 40_000);
  assert.equal(p.universe.get("DDD").filter.category, "dev_holding");
  assert.equal(p.analyst.passes("DDD"), false);
  assert.equal(p.executor.status().watchingCount, 0, "and the executor stops waiting for it");
});

test("the smart-wallet registry learns from what happened next, and knows nothing on night one", () => {
  const p = desk({}, { buyers: ["walletA", "walletB"] });
  assert.equal(p.smartWallets.crowdScore(["walletA"]), null, "no record yet, so no opinion");
  assert.equal(p.smartWallets.score("walletA"), 0.5);

  p.smartWallets.sample("EEE", ["walletA", "walletB"], 400_000, START);
  assert.equal(p.smartWallets.settle("EEE", 500_000, START + 60_000), null, "too early to judge");

  const settled = p.smartWallets.settle("EEE", 700_000, START + 31 * 60_000);
  assert.deepEqual({ won: settled.won, wallets: settled.wallets }, { won: true, wallets: 2 });
  assert.ok(p.smartWallets.score("walletA") > 0.5, "the wallets that were early get credit");

  // One right answer is not a record: the score is pulled back towards neutral until there are a
  // few of them.
  assert.ok(p.smartWallets.score("walletA") < 0.65, "but not much credit, on one sample");
});

test("every kill is written down with the stage that made it", async () => {
  const p = desk();
  p.see({ mint: "YOUNG", symbol: "YOUNG", ageSeconds: 300, ...healthy(400_000) });
  p.see({ mint: "THIN", symbol: "THIN", ...healthy(400_000, { liquidityUsd: 1_000 }) });
  await admit(p, { mint: "DULL", symbol: "DULL", ...healthy(400_000, { priceChangeH1: 0, buyersH1: 60, sellersH1: 55 }) });

  // The file carries the passes too, so the funnel adds up; the kills are what must explain
  // themselves.
  const kills = killsOf(p).filter((row) => row.type === "kill");
  const stages = kills.map((k) => k.stage);
  assert.ok(stages.includes("scout") && stages.includes("filter") && stages.includes("analyst"));
  for (const kill of kills) {
    assert.ok(kill.category && kill.detail, "a kill with no reason is useless in the morning");
    assert.ok(kill.mint, "and it has to say which coin");
  }
  assert.equal(p.logger.status().kills, kills.length);
  assert.ok(p.logger.status().byStage.filter >= 1);
});

test("a coin that collapses while held is banned, whoever made it", async () => {
  const p = desk({ ENTRY_MODE: "breakout" });
  const now = await feed(p, "RUGME", CLIMB, START);
  assert.equal(p.executor.status().openPositions, 1);
  const entry = p.executor.status().positions[0].entryMarketCapUsd;

  // The pool is drained between two polls.
  await feed(p, "RUGME", [Math.round(entry * 0.05)], now);
  assert.equal(p.executor.status().openPositions, 0, "it got out at whatever price was left");
  assert.equal(p.devBook.isBanned("RUGME"), true);

  // Even looking healthy again, the filter will not have it.
  const retry = p.see({ mint: "RUGME", ...healthy(400_000) }, now + 60_000);
  assert.equal(retry.filter.state, "kill");
  assert.equal(retry.filter.category, "rugged");
});
