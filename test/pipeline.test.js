import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDevBook } from "../src/devbook.js";
import { devReason, gateReason, holderReason, GATE_DEFAULTS } from "../src/filters.js";
import { topHolderPct, fetchHolderStats, fetchSafetyReport, isFreshWallet } from "../src/holders.js";
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

test("devbook: a coin that rugged stays banned across a restart", () => {
  const filePath = path.join(tmp(), "devbook.json");
  const first = createDevBook({ filePath });
  // No launch event for this one: the bot met it through a pool listing, like most rugs.
  assert.equal(first.creatorOf("ghost-mint"), null);
  assert.equal(first.recordRug("ghost-mint"), true, "a rug counts even with no known creator");
  assert.equal(first.recordRug("ghost-mint"), false, "only once");
  assert.equal(first.isBanned("ghost-mint"), true);
  first.save();

  const second = createDevBook({ filePath });
  assert.equal(second.isBanned("ghost-mint"), true, "a restart must not forget which coins collapsed");
  assert.equal(second.bannedCount(), 1);
  assert.equal(second.isBanned("some-other-mint"), false);
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

test("safety: a fresh wallet is one with almost no history, or a history that is all recent", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const hoursAgo = (h) => ({ blockTime: Math.floor(now / 1000) - h * 3600 });
  const opts = { limit: 50, maxTx: 8, maxAgeHours: 24, now };

  assert.equal(isFreshWallet([], opts), true, "no history at all");
  assert.equal(isFreshWallet([hoursAgo(1), hoursAgo(2)], opts), true, "two transactions, both today");
  // Few transactions is enough on its own: a wallet that has done nothing is not a real holder.
  assert.equal(isFreshWallet(Array.from({ length: 5 }, () => hoursAgo(900)), opts), true);
  // A long-lived wallet with a real history is not fresh.
  assert.equal(isFreshWallet(Array.from({ length: 20 }, (_, i) => hoursAgo(i === 19 ? 900 : 1)), opts), false);
  // A full page where even the oldest is from today: brand new and very busy — a sniper.
  assert.equal(isFreshWallet(Array.from({ length: 50 }, () => hoursAgo(2)), opts), true);
  // A full page spanning months: an ordinary active wallet.
  assert.equal(isFreshWallet(Array.from({ length: 50 }, (_, i) => hoursAgo(i * 40)), opts), false);
  assert.equal(isFreshWallet(null, opts), null, "unknown stays unknown");
});

test("safety: the rules refuse a coin the creator still controls", () => {
  const config = {
    maxTopHoldersPct: 35, topHoldersCount: 5,
    requireMintRevoked: true, requireFreezeRevoked: true, maxFreshHoldersPct: 60,
  };
  const ok = { status: "ok", topPct: 20, mintAuthority: null, freezeAuthority: null, freshPct: 0, freshHolders: 0, checkedHolders: 5 };
  assert.equal(holderReason(ok, config), null);

  assert.equal(holderReason({ ...ok, mintAuthority: "Dev111" }, config).category, "mint_authority");
  assert.equal(holderReason({ ...ok, freezeAuthority: "Dev111" }, config).category, "freeze_authority");
  assert.equal(holderReason({ ...ok, topPct: 61 }, config).category, "holders");
  assert.equal(holderReason({ ...ok, freshHolders: 4, checkedHolders: 5, freshPct: 80 }, config).category, "fresh_wallets");

  // Switched off, or not enough data, means no opinion — never a rejection.
  assert.equal(holderReason({ ...ok, mintAuthority: "Dev111" }, { ...config, requireMintRevoked: false }), null);
  assert.equal(holderReason({ ...ok, freshHolders: 1, checkedHolders: 1, freshPct: 100 }, config), null, "one holder is not a pattern");
  assert.equal(holderReason({ status: "pending" }, config), null);
  assert.equal(holderReason({ ...ok, topPct: null, freshPct: null }, config), null);
});

test("safety: the full report reads authorities, concentration and holder wallets off the chain", async () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getAccountInfo") {
      return reply({ value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: "Frz1" } } } } });
    }
    if (method === "getTokenSupply") return reply({ value: { uiAmountString: "1000000000" } });
    if (method === "getTokenLargestAccounts") {
      return reply({ value: [
        { address: "poolVault", uiAmountString: "700000000" }, // skipped: the pool
        { address: "tokenAcc1", uiAmountString: "150000000" },
        { address: "tokenAcc2", uiAmountString: "50000000" },
      ] });
    }
    if (method === "getMultipleAccounts") {
      // First call: token account -> owner. Second call: owner -> what kind of account it is.
      if (params[0][0]?.startsWith("tokenAcc") || params[0][0] === "poolVault") {
        return reply({ value: params[0].map((address) => ({
          data: { parsed: { info: { owner: address === "poolVault" ? "poolAuthority" : `wallet${address.slice(-1)}` } } },
        })) });
      }
      return reply({ value: params[0].map((owner) => ({
        // The pool's authority is a program account; the rest are ordinary wallets.
        owner: owner === "poolAuthority" ? "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" : "11111111111111111111111111111111",
      })) });
    }
    if (method === "getSignaturesForAddress") {
      // wallet1 is brand new, wallet2 has years of history.
      return reply(params[0] === "wallet1"
        ? [{ blockTime: Math.floor(now / 1000) - 600 }]
        : Array.from({ length: 50 }, (_, i) => ({ blockTime: Math.floor(now / 1000) - i * 200_000 })));
    }
    throw new Error(`unexpected method ${method}`);
  };

  const report = await fetchSafetyReport(MINT, "https://rpc.example.com/?api-key=SECRET", {
    topCount: 5, fetchImpl, now,
  });
  assert.equal(report.mintAuthority, null, "mint authority was revoked");
  assert.equal(report.freezeAuthority, "Frz1", "freeze authority is still live");
  assert.equal(report.topPct, 20, "150M + 50M of 1B; the pool vault is not a holder");
  assert.equal(report.checkedHolders, 2);
  assert.equal(report.freshHolders, 1);
  assert.equal(report.freshPct, 50);
  assert.deepEqual(report.holders.map((h) => h.owner), ["wallet1", "wallet2"]);
  assert.ok(calls.includes("getAccountInfo") && calls.includes("getMultipleAccounts"));
  assert.equal(calls.filter((m) => m === "getSignaturesForAddress").length, 2, "one call per holder, no more");
});

test("safety: a whale holding nearly everything is not mistaken for the pool", async () => {
  // The blind spot this replaced: the old rule skipped the largest account on the assumption that
  // it was the pool vault. When the largest account is a PERSON holding 99% of supply, that
  // assumption hid the single most dangerous fact about the coin — and that holder can dump more
  // than the pool can absorb, which is the sell no stop can survive.
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getAccountInfo") return reply({ value: { data: { parsed: { info: {} } } } });
    if (method === "getTokenSupply") return reply({ value: { uiAmountString: "1000" } });
    if (method === "getTokenLargestAccounts") {
      return reply({ value: [{ address: "whaleAcc", uiAmountString: "990" }, { address: "small", uiAmountString: "5" }] });
    }
    if (method === "getMultipleAccounts") {
      if (params[0][0] === "whaleAcc") {
        return reply({ value: params[0].map((a) => ({ data: { parsed: { info: { owner: `${a}Owner` } } } })) });
      }
      // Both owners are ordinary wallets — neither is a pool.
      return reply({ value: params[0].map(() => ({ owner: "11111111111111111111111111111111" })) });
    }
    if (method === "getSignaturesForAddress") return reply([{ blockTime: Math.floor(Date.now() / 1000) - 600 }]);
    throw new Error(`unexpected ${method}`);
  };

  const report = await fetchSafetyReport(MINT, "https://rpc.example.com", { topCount: 5, fetchImpl });
  assert.ok(report.topPct > 99, `the whale is counted: topPct ${report.topPct}`);
  assert.ok(report.largestHolderPct > 98);
  const verdict = holderReason({ status: "ok", ...report }, {
    maxTopHoldersPct: 35, topHoldersCount: 5, requireMintRevoked: false, requireFreezeRevoked: false, maxFreshHoldersPct: 60,
  });
  assert.equal(verdict.category, "holders", "and the coin is refused");
});

test("safety: a wallet lookup that fails does not condemn the coin", async () => {
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getAccountInfo") return reply({ value: { data: { parsed: { info: {} } } } });
    if (method === "getTokenSupply") return reply({ value: { uiAmountString: "1000" } });
    if (method === "getTokenLargestAccounts") {
      return reply({ value: [{ address: "pool", uiAmountString: "800" }, { address: "acc1", uiAmountString: "100" }] });
    }
    if (method === "getMultipleAccounts") return reply({ value: [{ data: { parsed: { info: { owner: "w1" } } } }] });
    if (method === "getSignaturesForAddress") throw new Error("node is busy");
    throw new Error(`unexpected ${method}`);
  };
  const report = await fetchSafetyReport(MINT, "https://rpc.example.com", { fetchImpl });
  assert.equal(report.holders[0].fresh, null, "unknown, not fresh");
  assert.equal(report.checkedHolders, 0);
  assert.equal(report.freshPct, null, "and so no fresh-wallet rule applies");
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

test("journal: reports what it has written, for the dashboard's storage row", () => {
  const filePath = path.join(tmp(), "journal.jsonl");
  const journal = createJournal({ filePath });
  assert.deepEqual(journal.stats(), { filePath, lines: 0, bytes: 0, pending: 0, lastError: "" });

  journal.write({ type: "new", mint: "m1" });
  journal.write({ type: "new", mint: "m2" });
  let stats = journal.stats();
  assert.equal(stats.lines, 2);
  assert.equal(stats.pending, 2, "still buffered");
  assert.equal(stats.bytes, 0, "nothing on disk until it flushes");

  journal.flush();
  stats = journal.stats();
  assert.equal(stats.pending, 0);
  assert.ok(stats.bytes > 0, "now it is on disk");
  assert.equal(stats.lastError, "");
  journal.stop();
});

test("journal: a failed write is reported rather than swallowed", () => {
  // A directory where the file should be: writing can never succeed.
  const dir = tmp();
  const filePath = path.join(dir, "blocked.jsonl");
  fs.mkdirSync(filePath);
  const journal = createJournal({ filePath, onError: () => {} });
  journal.write({ type: "new" });
  journal.flush();
  assert.ok(journal.stats().lastError, "the storage row can show that writing failed");
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
