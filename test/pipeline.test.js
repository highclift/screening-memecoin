import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDevBook } from "../src/devbook.js";
import { devReason, gateReason, holderReason, GATE_DEFAULTS } from "../src/filters.js";
import { topHolderPct, fetchHolderStats } from "../src/holders.js";
import { createJournal } from "../src/journal.js";
import { createMeter } from "../src/meter.js";
import { loadConfig } from "../src/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "screener-"));
const MINT = "So11111111111111111111111111111111111111112";

// A coin that passes every hard gate, so each test can break exactly one thing.
const tradable = (overrides = {}) => ({
  marketCapUsd: 400_000,
  liquidityUsd: 40_000,
  tradesH1: 300,
  volumeH1Usd: 60_000,
  ...overrides,
});

test("devbook: unknown creator is unknown, not bad", () => {
  const book = createDevBook({ filePath: null });
  assert.equal(book.assess("mint-1", { maxDevRugs: 1, maxDevLaunches: 5 }).verdict, "unknown");
});

test("devbook: rejects serial launchers and rugged creators, ignores duplicate create events", () => {
  const book = createDevBook({ filePath: null });
  for (let i = 0; i < 6; i += 1) book.recordLaunch("dev-a", `mint-a${i}`);
  book.recordLaunch("dev-a", "mint-a0"); // duplicate event
  const serial = book.assess("mint-a5", { maxDevRugs: 1, maxDevLaunches: 5 });
  assert.equal(serial.verdict, "reject");
  assert.equal(serial.launches, 6);

  book.recordLaunch("dev-b", "mint-b1");
  assert.equal(book.assess("mint-b1", { maxDevRugs: 1, maxDevLaunches: 5 }).verdict, "clean");
  assert.equal(book.recordRug("mint-b1"), true);
  assert.equal(book.recordRug("mint-b1"), false, "a rug is only counted once per token");
  const rugged = book.assess("mint-b1", { maxDevRugs: 1, maxDevLaunches: 5 });
  assert.equal(rugged.verdict, "reject");
  assert.match(rugged.reason, /rugged/);
  assert.equal(book.assess("mint-b1", { maxDevRugs: 0, maxDevLaunches: 0 }).verdict, "clean", "0 disables a rule");
});

test("devbook: persists to disk and reloads", () => {
  const filePath = path.join(tmp(), "devbook.json");
  const first = createDevBook({ filePath });
  first.recordLaunch("dev-c", "mint-c1");
  first.recordMigration("mint-c1");
  first.save();
  const second = createDevBook({ filePath });
  assert.equal(second.size(), 1);
  second.recordLaunch("dev-c", "mint-c2");
  assert.equal(second.assess("mint-c2", { maxDevLaunches: 1 }).verdict, "reject"); // 2 launches > 1
});

test("gates: missing data waits instead of rejecting", () => {
  const waiting = gateReason({ marketCapUsd: 400_000 }, GATE_DEFAULTS);
  assert.equal(waiting.category, "no_data");
  assert.equal(waiting.wait, true, "a coin with no data yet must stay in the registry");
  assert.equal(gateReason({ liquidityUsd: 40_000 }, GATE_DEFAULTS).wait, true);

  // Unknown activity never rejects: only a reported number below the floor does.
  assert.equal(gateReason(tradable({ tradesH1: undefined, volumeH1Usd: undefined }), GATE_DEFAULTS), null);
});

test("gates: an untradable coin is rejected whatever else it looks like", () => {
  assert.equal(gateReason(tradable(), GATE_DEFAULTS), null);
  assert.equal(gateReason(tradable({ liquidityUsd: 900 }), GATE_DEFAULTS).category, "liquidity");
  // $5M coin behind a $20k pool: enough liquidity in absolute terms, nowhere near enough for the size.
  assert.equal(gateReason(tradable({ marketCapUsd: 5_000_000, liquidityUsd: 20_000 }), GATE_DEFAULTS).category, "liquidity_ratio");
  assert.equal(gateReason(tradable({ tradesH1: 4 }), GATE_DEFAULTS).category, "dead");
  assert.equal(gateReason(tradable({ volumeH1Usd: 100 }), GATE_DEFAULTS).category, "dead_volume");
  assert.equal(gateReason(tradable({ marketCapUsd: 5_000, liquidityUsd: 5_000 }), GATE_DEFAULTS).category, "market_cap");
  assert.equal(gateReason(tradable({ marketCapUsd: 90_000_000, liquidityUsd: 9_000_000 }), GATE_DEFAULTS).category, "market_cap");
  assert.match(gateReason(tradable({ liquidityUsd: 900 }), GATE_DEFAULTS).detail, /\$900 below \$5,000/);
});

test("gates: age is never part of the decision", () => {
  // The same numbers on a 2-minute-old coin and a 3-month-old coin get the same answer. This is
  // the whole point: bot 2 judges what a coin is doing now, not when it was born.
  assert.equal(gateReason({ ...tradable(), ageSeconds: 120 }, GATE_DEFAULTS), null);
  assert.equal(gateReason({ ...tradable(), ageSeconds: 90 * 86_400 }, GATE_DEFAULTS), null);
});

test("holder and dev gates: unknown data never rejects", () => {
  const config = { maxTopHoldersPct: 35, topHoldersCount: 5 };
  assert.equal(holderReason({ status: "pending" }, config), null);
  assert.equal(holderReason(null, config), null);
  assert.equal(holderReason({ status: "ok", topPct: 50 }, config).category, "holders");
  assert.equal(holderReason({ status: "ok", topPct: 20 }, config), null);
  assert.equal(devReason({ verdict: "reject", reason: "bad" }).detail, "bad");
  assert.equal(devReason({ verdict: "unknown" }), null);
  assert.equal(devReason({ verdict: "clean" }), null);
});

test("holders: skips the largest account (pool) by default and counts the next N", () => {
  const accounts = [
    { uiAmountString: "300000000" }, // pool vault
    { uiAmountString: "50000000" },
    { uiAmountString: "40000000" },
    { uiAmountString: "30000000" },
    { uiAmountString: "20000000" },
    { uiAmountString: "10000000" },
    { uiAmountString: "5000000" },
  ];
  const supply = 1_000_000_000;
  assert.equal(topHolderPct(accounts, supply, { topCount: 5 }), 15); // 50+40+30+20+10 = 150M
  assert.equal(topHolderPct(accounts, supply, { topCount: 5, skipLargest: false }), 44);
  assert.equal(topHolderPct([], supply), 0);
  assert.equal(topHolderPct(accounts, 0), null);
});

test("holders: fetchHolderStats validates input and never leaks the RPC url in errors", async () => {
  const url = "https://rpc.example.com/?api-key=SECRET123";
  await assert.rejects(() => fetchHolderStats("not a mint; drop table", url), /invalid mint/);
  await assert.rejects(() => fetchHolderStats(MINT, ""), /no RPC url/);

  const failing = async () => new Response("denied", { status: 403 });
  await assert.rejects(() => fetchHolderStats(MINT, url, { fetchImpl: failing }), (error) => {
    assert.ok(!error.message.includes("SECRET123"));
    assert.match(error.message, /HTTP 403/);
    return true;
  });

  const limited = async () => new Response("slow down", { status: 429 });
  await assert.rejects(() => fetchHolderStats(MINT, url, { fetchImpl: limited }), (error) => error.rateLimited === true);

  const rpcError = async () => new Response(JSON.stringify({ error: { message: "Invalid param" } }));
  await assert.rejects(() => fetchHolderStats(MINT, url, { fetchImpl: rpcError }), /Invalid param/);
});

test("holders: fetchHolderStats parses getTokenLargestAccounts + getTokenSupply", async () => {
  const fetchImpl = async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === "getTokenLargestAccounts"
      ? { value: [{ uiAmountString: "400000000" }, { uiAmountString: "100000000" }, { uiAmountString: "50000000" }] }
      : { value: { uiAmountString: "1000000000" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };
  const stats = await fetchHolderStats(MINT, "https://rpc.example.com", { topCount: 5, fetchImpl });
  assert.equal(stats.topPct, 15); // skips the 400M pool, then 100M + 50M
  assert.equal(stats.largestPct, 40);
  assert.equal(stats.accounts, 3);
});

test("journal: buffers, appends JSONL, and rotates past maxBytes", () => {
  const filePath = path.join(tmp(), "journal.jsonl");
  const journal = createJournal({ filePath, maxBytes: 200 });
  journal.write({ type: "verdict", state: "red", mint: "m1" });
  journal.write({ type: "entry", mint: "m2", score: 0.7 });
  journal.flush();
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].state, "red");
  assert.ok(lines[0].t);

  for (let i = 0; i < 10; i += 1) journal.write({ type: "filler", note: "x".repeat(50) });
  journal.flush(); // file is over 200 bytes -> rotates before this append
  journal.write({ type: "after" });
  journal.flush();
  assert.ok(fs.existsSync(`${filePath}.1`));
  assert.match(fs.readFileSync(filePath, "utf8"), /"after"/);
  journal.stop();
});

test("meter: counts only the last minute", () => {
  const meter = createMeter();
  const start = 1_000_000;
  meter.hit(120, start);
  assert.equal(meter.perMinute(start + 1000), 120);
  assert.equal(meter.perMinute(start + 61_000), 0, "a minute later those hits no longer count");
});

test("config: money limits and safety floors have safe defaults and are validated", () => {
  const c = loadConfig({});
  assert.equal(c.mode, "paper");
  assert.equal(c.solanaRpcUrl, "");
  assert.equal(c.topHoldersSkipLargest, true);
  assert.equal(c.greenScore, 0.58);
  assert.equal(c.gates.minLiquidityUsd, GATE_DEFAULTS.minLiquidityUsd);
  // There are no entry/exit settings any more: bot 3 derives those per coin.
  for (const gone of ["pullbackPct", "bouncePct", "takeProfitPct", "stopLossPct", "maxHoldSeconds", "minScore", "lanes"]) {
    assert.equal(c[gone], undefined, `${gone} must not come back as a setting`);
  }

  assert.throws(() => loadConfig({ MODE: "live" }), /paper/);
  assert.throws(() => loadConfig({ SOLANA_RPC_URL: "ftp://nope" }), /SOLANA_RPC_URL/);
  assert.throws(() => loadConfig({ TOP_HOLDERS_SKIP_LARGEST: "maybe" }), /true or false/);
  assert.throws(() => loadConfig({ BUY_AMOUNT_SOL: "5", PAPER_START_BALANCE_SOL: "1" }), /BUY_AMOUNT_SOL/);
  assert.throws(() => loadConfig({ MIN_MARKET_CAP_USD: "100000", MAX_MARKET_CAP_USD: "50000" }), /MIN_MARKET_CAP_USD/);
  assert.throws(() => loadConfig({ WATCH_SCORE: "0.9", GREEN_SCORE: "0.5" }), /WATCH_SCORE/);
  assert.equal(loadConfig({ GREEN_SCORE: "0.7" }).greenScore, 0.7);
});
