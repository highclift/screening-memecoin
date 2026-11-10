import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDevBook } from "../src/devbook.js";
import { liquidityReason, holderReason, devReason } from "../src/filters.js";
import { scoreCandidate, WEIGHTS } from "../src/analyst.js";
import { topHolderPct, fetchHolderStats } from "../src/holders.js";
import { createJournal } from "../src/journal.js";
import { loadConfig } from "../src/config.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "screener-"));
const MINT = "So11111111111111111111111111111111111111112";

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

test("filters: unknown data never rejects", () => {
  const config = { minLiquidityUsd: 5000, maxTopHoldersPct: 35, topHoldersCount: 5 };
  assert.equal(liquidityReason({ liquidityUsd: null }, config), null);
  assert.equal(liquidityReason({ liquidityUsd: 1200 }, config) !== null, true);
  assert.equal(liquidityReason({ liquidityUsd: 9000 }, config), null);
  assert.equal(liquidityReason({ liquidityUsd: 1 }, { ...config, minLiquidityUsd: 0 }), null);
  assert.equal(holderReason({ status: "pending" }, config), null);
  assert.equal(holderReason({ status: "ok", topPct: 50 }, config) !== null, true);
  assert.equal(holderReason({ status: "ok", topPct: 20 }, config), null);
  assert.equal(devReason({ verdict: "reject", reason: "bad" }), "bad");
  assert.equal(devReason({ verdict: "unknown" }), null);
});

test("analyst: weights sum to 1 and scores stay in 0..1", () => {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);

  const config = { minUniqueBuyers: 8, bouncePct: 0.05, maxTopHoldersPct: 35 };
  const strong = {
    trades: 100, buys: 90, buyers: new Set(Array.from({ length: 30 }, (_, i) => `w${i}`)),
    lowMarketCapUsd: 50_000, currentMarketCapUsd: 60_000, liquidityUsd: 20_000,
  };
  const weak = {
    trades: 100, buys: 45, buyers: new Set(["a"]),
    lowMarketCapUsd: 50_000, currentMarketCapUsd: 50_000, liquidityUsd: 100,
  };
  const good = scoreCandidate(strong, config, { dev: { verdict: "clean" }, holders: { status: "ok", topPct: 5 } });
  const bad = scoreCandidate(weak, config, { dev: { verdict: "unknown" }, holders: { status: "ok", topPct: 34 } });
  assert.ok(good.score > 0.9 && good.score <= 1, `good=${good.score}`);
  assert.ok(bad.score < 0.3, `bad=${bad.score}`);
  assert.ok(good.score > bad.score);
});

test("analyst: missing data is neutral (0.5), not zero", () => {
  const config = { minUniqueBuyers: 8, bouncePct: 0.05, maxTopHoldersPct: 35 };
  const c = { trades: 0, buys: 0, buyers: new Set(), lowMarketCapUsd: null, currentMarketCapUsd: null, liquidityUsd: null };
  const { parts } = scoreCandidate(c, config, {});
  assert.equal(parts.liquidity, 0.5);
  assert.equal(parts.holders, 0.5);
  assert.equal(parts.dev, 0.5);
  assert.equal(parts.rebound, 0);
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
  journal.write({ type: "reject", category: "social", mint: "m1" });
  journal.write({ type: "entry", mint: "m2", score: 0.7 });
  journal.flush();
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].category, "social");
  assert.ok(lines[0].t);

  for (let i = 0; i < 10; i += 1) journal.write({ type: "filler", note: "x".repeat(50) });
  journal.flush(); // file is over 200 bytes -> rotates before this append
  journal.write({ type: "after" });
  journal.flush();
  assert.ok(fs.existsSync(`${filePath}.1`));
  assert.match(fs.readFileSync(filePath, "utf8"), /"after"/);
  journal.stop();
});

test("config: new settings have safe defaults and are validated", () => {
  const c = loadConfig({});
  assert.equal(c.minScore, 0.5);
  assert.equal(c.solanaRpcUrl, "");
  assert.equal(c.metadataHosts, undefined);
  assert.equal(c.topHoldersSkipLargest, true);
  assert.equal(c.mode, "paper");

  assert.throws(() => loadConfig({ MIN_SCORE: "2" }), /MIN_SCORE/);
  assert.throws(() => loadConfig({ SOLANA_RPC_URL: "ftp://nope" }), /SOLANA_RPC_URL/);
  assert.throws(() => loadConfig({ TOP_HOLDERS_SKIP_LARGEST: "maybe" }), /true or false/);
  assert.throws(() => loadConfig({ MODE: "live" }), /paper/);
  assert.deepEqual(loadConfig({ METADATA_HOSTS: "a.com, b.com" }).metadataHosts, ["a.com", "b.com"]);
  assert.equal(loadConfig({ TOP_HOLDERS_SKIP_LARGEST: "false" }).topHoldersSkipLargest, false);
});
