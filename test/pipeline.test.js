import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDevBook } from "../src/devbook.js";
import { devReason, gateReason, holderReason, GATE_DEFAULTS } from "../src/filters.js";
import { parseReport } from "../src/rugcheck.js";
import { rugcheckReason } from "../src/agents/filter.js";
import { windowReason } from "../src/agents/scout.js";
import { deskScore, holderGrowthPerHour } from "../src/signals.js";
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

test("gates: volume made by a handful of wallets is not a market", () => {
  // The insider pattern from the outside: the hour looks busy, but the buying is a few addresses
  // trading with each other. Volume and trade count are free to manufacture; distinct buyers are
  // not, so that is the number the gate is built on.
  assert.equal(gateReason(tradable({ buyersH1: 40 }), GATE_DEFAULTS), null);
  assert.equal(gateReason(tradable({ buyersH1: 6 }), GATE_DEFAULTS).category, "few_buyers");
  assert.match(gateReason(tradable({ buyersH1: 6 }), GATE_DEFAULTS).detail, /6 different wallets/);

  // Enough wallets to pass the count, but 300 trades between 15 of them is 20 trades each.
  assert.equal(gateReason(tradable({ buyersH1: 15 }), GATE_DEFAULTS).category, "wash_trading");
  assert.equal(gateReason(tradable({ buyersH1: 15, tradesH1: 120 }), GATE_DEFAULTS), null, "8 trades each is ordinary");

  // Unknown stays unknown: most sources never report a buyer count, and a missing number must not
  // reject a coin. Bot 2 refuses to call a coin GREEN until it has one (see bots/filter.js).
  assert.equal(gateReason(tradable(), GATE_DEFAULTS), null);
  assert.equal(gateReason(tradable({ buyersH1: null }), GATE_DEFAULTS), null);
});

test("gates: a coin more wallets are leaving than joining is being handed out", () => {
  // Measured on the coin that prompted this: 271 wallets bought that hour and 349 sold, while the
  // buy/sell split (507/519) looked almost even and the volume looked healthy. Counting WALLETS
  // is what separates "busy" from "the holders are getting out".
  const live = { marketCapUsd: 612_124, liquidityUsd: 70_748, volumeH1Usd: 47_632, tradesH1: 1_026 };
  assert.equal(gateReason({ ...live, buyersH1: 271, sellersH1: 349 }, GATE_DEFAULTS).category, "distribution");
  assert.match(gateReason({ ...live, buyersH1: 271, sellersH1: 349 }, GATE_DEFAULTS).detail, /349 wallets sold against 271/);

  // An ordinary two-way market is not distribution: some selling into a rise is how a market works.
  assert.equal(gateReason({ ...live, buyersH1: 271, sellersH1: 300 }, GATE_DEFAULTS), null);
  assert.equal(gateReason({ ...live, buyersH1: 271, sellersH1: 120 }, GATE_DEFAULTS), null);
  assert.equal(gateReason({ ...live, buyersH1: 271 }, GATE_DEFAULTS), null, "a source that does not report sellers never rejects");
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
    requireMintRevoked: true, requireFreezeRevoked: true, maxFreshSupplyPct: 25,
  };
  const ok = { status: "ok", topPct: 20, mintAuthority: null, freezeAuthority: null, freshSupplyPct: 0, freshHolders: 0, checkedHolders: 5 };
  assert.equal(holderReason(ok, config), null);

  assert.equal(holderReason({ ...ok, mintAuthority: "Dev111" }, config).category, "mint_authority");
  assert.equal(holderReason({ ...ok, freezeAuthority: "Dev111" }, config).category, "freeze_authority");
  assert.equal(holderReason({ ...ok, topPct: 61 }, config).category, "holders");
  assert.equal(holderReason({ ...ok, freshHolders: 2, checkedHolders: 5, freshSupplyPct: 40 }, config).category, "fresh_wallets");

  // Switched off, or not enough data, means no opinion — never a rejection.
  assert.equal(holderReason({ ...ok, mintAuthority: "Dev111" }, { ...config, requireMintRevoked: false }), null);
  assert.equal(holderReason({ ...ok, freshHolders: 5, checkedHolders: 5, freshSupplyPct: 1.1 }, config), null, "five new wallets holding 1% between them are harmless");
  assert.equal(holderReason({ status: "pending" }, config), null);
  assert.equal(holderReason({ ...ok, topPct: null, freshSupplyPct: null }, config), null);
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
  assert.equal(report.freshSupplyPct, 15, 'wallet1 holds 15% and is the fresh one');
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
    maxTopHoldersPct: 35, topHoldersCount: 5, requireMintRevoked: false, requireFreezeRevoked: false, maxFreshSupplyPct: 25,
  });
  assert.equal(verdict.category, "holders", "and the coin is refused");
});

test("safety: top holders funded by one wallet are treated as a single holder", async () => {
  // The bubble-map case: four holders of 15% each look harmless one at a time, but one wallet
  // paid to create all four, so 60% can be dumped in a single decision.
  const now = Date.parse("2026-11-11T12:00:00Z");
  const recent = Math.floor(now / 1000) - 1800;
  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getAccountInfo") return reply({ value: { data: { parsed: { info: {} } } } });
    if (method === "getTokenSupply") return reply({ value: { uiAmountString: "1000" } });
    if (method === "getTokenLargestAccounts") {
      return reply({ value: [
        { address: "pool", uiAmountString: "380" },
        ...[1, 2, 3, 4].map((i) => ({ address: `acc${i}`, uiAmountString: "150" })),
      ] });
    }
    if (method === "getMultipleAccounts") {
      // First call asks about token accounts, second about the owners behind them.
      if (!String(params[0][0]).endsWith("Owner")) {
        return reply({ value: params[0].map((a) => ({ data: { parsed: { info: { owner: `${a}Owner` } } } })) });
      }
      return reply({ value: params[0].map((owner) => ({
        owner: owner === "poolOwner" ? "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" : "11111111111111111111111111111111",
      })) });
    }
    if (method === "getSignaturesForAddress") {
      return reply([{ signature: `sig-${params[0]}`, blockTime: recent }]); // all brand new
    }
    if (method === "getTransaction") {
      // Every one of these wallets had its first transaction paid for by the same address.
      return reply({ transaction: { message: { accountKeys: [{ pubkey: "theHub" }, { pubkey: "whoever" }] } } });
    }
    throw new Error(`unexpected ${method}`);
  };

  const report = await fetchSafetyReport(MINT, "https://rpc.example.com", { topCount: 5, fetchImpl, now });
  assert.equal(report.largestClusterWallets, 4, "all four share a funder");
  assert.ok(Math.abs(report.largestClusterPct - 60) < 0.01, `cluster holds ${report.largestClusterPct}%`);

  const verdict = holderReason({ status: "ok", ...report }, {
    maxTopHoldersPct: 100, topHoldersCount: 5, requireMintRevoked: false, requireFreezeRevoked: false,
    maxFreshSupplyPct: 100, maxClusterPct: 50,
  });
  assert.equal(verdict.category, "wallet_cluster", "refused even though no single holder is large");

  // A wallet that paid its own first fee tells us nothing, so it forms no cluster.
  const alone = await fetchSafetyReport(MINT, "https://rpc.example.com", {
    topCount: 5, now,
    fetchImpl: async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      if (method !== "getTransaction") return fetchImpl(url, init);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { transaction: { message: { accountKeys: [{ pubkey: `${params[0].replace("sig-", "")}` }] } } } }));
    },
  });
  assert.equal(alone.largestClusterPct, null, "no funder, no cluster");
});

test("safety: twenty small wallets paid for by one address are caught, though no holder is big", async () => {
  // The bubble map this was built for: a dense ring of wallets around one hub, none of them large
  // enough to trip a top-holder limit. 20 wallets at 1.5% is 30% of supply under one hand, and the
  // top-5 concentration check sees only 7.5% of it. The hub here is itself a holder — the middle
  // of the map — so it has to be counted as part of its own cluster.
  const now = Date.parse("2026-11-11T12:00:00Z");
  const first = Math.floor(now / 1000) - 7200;
  const accounts = Array.from({ length: 20 }, (_, i) => `acc${i + 1}`);
  const fundedAt = (owner) => first + accounts.indexOf(owner.replace("Owner", "")) * 300; // ~1.6h apart

  const fetchImpl = async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    if (method === "getAccountInfo") return reply({ value: { data: { parsed: { info: {} } } } });
    if (method === "getTokenSupply") return reply({ value: { uiAmountString: "1000" } });
    if (method === "getTokenLargestAccounts") {
      return reply({ value: [
        { address: "pool", uiAmountString: "700" },
        ...accounts.map((address) => ({ address, uiAmountString: "15" })), // 1.5% each
      ] });
    }
    if (method === "getMultipleAccounts") {
      if (!String(params[0][0]).endsWith("Owner")) {
        return reply({ value: params[0].map((a) => ({ data: { parsed: { info: { owner: `${a}Owner` } } } })) });
      }
      return reply({ value: params[0].map((owner) => ({
        owner: owner === "poolOwner" ? "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" : "11111111111111111111111111111111",
      })) });
    }
    if (method === "getSignaturesForAddress") {
      return reply([{ signature: `sig-${params[0]}`, blockTime: fundedAt(params[0]) }]);
    }
    if (method === "getTransaction") {
      // acc1Owner paid for all the others, and for nothing but its own first fee itself.
      const owner = params[0].replace("sig-", "");
      return reply({ transaction: { message: { accountKeys: [{ pubkey: owner === "acc1Owner" ? owner : "acc1Owner" }] } } });
    }
    throw new Error(`unexpected ${method}`);
  };

  const report = await fetchSafetyReport(MINT, "https://rpc.example.com", {
    topCount: 5, clusterHolderCount: 20, fetchImpl, now,
  });
  assert.equal(report.topPct, 7.5, "the top-5 check only ever sees 7.5% — this is why it missed");
  assert.equal(report.largestClusterWallets, 20, "the hub counts inside its own cluster, once");
  assert.ok(Math.abs(report.largestClusterPct - 30) < 0.01, `cluster holds ${report.largestClusterPct}%`);
  assert.ok(report.largestClusterSpanHours < 2, "all funded inside two hours: a setup, not a coincidence");
  assert.ok(Math.abs(report.linkedSupplyPct - 30) < 0.01);

  const config = {
    maxTopHoldersPct: 35, topHoldersCount: 5, requireMintRevoked: false, requireFreezeRevoked: false,
    maxFreshSupplyPct: 100, maxClusterPct: 15, maxLinkedSupplyPct: 25, maxClusterWallets: 3, clusterBurstHours: 72,
  };
  assert.equal(holderReason({ status: "ok", ...report }, config).category, "wallet_cluster");

  // Even with the size limits switched off, twenty wallets from one payer is refused on the count.
  const sizeBlind = { ...config, maxClusterPct: 100, maxLinkedSupplyPct: 100 };
  assert.equal(holderReason({ status: "ok", ...report }, sizeBlind).category, "linked_wallets");
  assert.equal(holderReason({ status: "ok", ...report, largestClusterPct: 20, linkedSupplyPct: 40 },
    { ...config, maxClusterPct: 100 }).category, "linked_supply", "several hubs add up");

  // The guard against false positives: an address that funded these wallets months apart is an
  // exchange hot wallet that strangers happen to share, not somebody building a position.
  assert.equal(holderReason({ status: "ok", ...report, largestClusterSpanHours: 5000 }, sizeBlind), null);
  assert.equal(holderReason({ status: "ok", ...report, largestClusterWallets: 2 }, sizeBlind), null,
    "two wallets is under the count limit");
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
  assert.equal(report.freshSupplyPct, null, "and so no fresh-wallet rule applies");
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

test("rugcheck: the report is read the way the live API actually shapes it", () => {
  // Trimmed from a real api.rugcheck.xyz response. The shapes that matter: amounts are raw and
  // have to be divided by `token.supply`, and a coin trades in SEVERAL markets whose LP numbers
  // disagree — eight pools here, one of them holding almost all the liquidity.
  const report = parseReport({
    token: { supply: 1_000_000_000, decimals: 6, mintAuthority: null, freezeAuthority: "Frz1" },
    creator: "DoXSiJr1",
    creatorBalance: 25_000_000, // 2.5%
    totalMarketLiquidity: 106_122,
    totalHolders: 9_284,
    rugged: false,
    score_normalised: 1,
    launchpad: { platform: "pump_fun" },
    markets: [
      { marketType: "meteoraDlmm", lp: { quoteUSD: 23_068, lpLockedPct: 0, lpLockedUSD: 0 } },
      { marketType: "pump_fun_amm", lp: { quoteUSD: 36_959, lpLockedPct: 100, lpLockedUSD: 75_367 } },
      { marketType: "orca", lp: { quoteUSD: 5, lpLockedPct: 0, lpLockedUSD: 0 } },
    ],
    insiderNetworks: [
      { size: 6, type: "transfer", tokenAmount: 90_000_000, currentHolding: 60_000_000, activeAccounts: 6 },
      { size: 3, type: "transfer", tokenAmount: 20_000_000, currentHolding: 10_000_000, activeAccounts: 3 },
    ],
    topHolders: [{ pct: 5.6, insider: false }, { pct: 4.3, insider: true }],
  });

  // The deepest pool is the one a position would be sold into, so that is the LP number that
  // counts — not an average that a dust pool at 0% would drag down.
  assert.equal(report.lpLockedPct, 100);
  assert.equal(report.marketType, "pump_fun_amm");
  assert.equal(report.marketCount, 3);
  assert.equal(report.creatorPct, 2.5);
  assert.equal(report.freezeAuthority, "Frz1");
  // Both insider networks together, measured on what they STILL hold.
  assert.ok(Math.abs(report.insiderPct - 7) < 1e-9, `insiders hold ${report.insiderPct}%`);
  assert.ok(Math.abs(report.insiderEverPct - 11) < 1e-9);
  assert.equal(report.insiderWallets, 9);
  assert.equal(report.flaggedHolderPct, 4.3);
  assert.equal(report.totalHolders, 9_284);

  assert.equal(parseReport(null), null);
  // A token with no markets and no supply yet must not come back with invented zeroes.
  const bare = parseReport({ token: {}, markets: [] });
  assert.equal(bare.lpLockedPct, null);
  assert.equal(bare.creatorPct, null);
  assert.equal(bare.insiderPct, null);
});

test("rugcheck rules: the kill list from the spec, and unknown never kills", () => {
  const config = {
    requireMintRevoked: true, requireFreezeRevoked: true,
    minLpLockedPct: 90, maxDevPct: 3, maxBundledPct: 10,
  };
  const ok = {
    mintAuthority: null, freezeAuthority: null, lpLockedPct: 100, creatorPct: 1,
    insiderPct: 2, flaggedHolderPct: 1, rugged: false, marketType: "pump_fun_amm",
  };
  assert.equal(rugcheckReason(ok, config), null);

  assert.equal(rugcheckReason({ ...ok, rugged: true }, config).category, "rugged");
  assert.equal(rugcheckReason({ ...ok, mintAuthority: "Dev1" }, config).category, "mint_authority");
  assert.equal(rugcheckReason({ ...ok, freezeAuthority: "Dev1" }, config).category, "freeze_authority");
  assert.equal(rugcheckReason({ ...ok, lpLockedPct: 50 }, config).category, "lp_unlocked");
  assert.equal(rugcheckReason({ ...ok, creatorPct: 9 }, config).category, "dev_holding");
  assert.equal(rugcheckReason({ ...ok, insiderPct: 14 }, config).category, "bundled");
  assert.equal(rugcheckReason({ ...ok, flaggedHolderPct: 25 }, config).category, "bundled");
  assert.match(rugcheckReason({ ...ok, lpLockedPct: 50 }, config).detail, /50\.0% of the pump_fun_amm pool/);

  // A field the API did not fill in is not a reason to refuse a coin — the filter keeps it in
  // `wait` instead, which is a different thing from passing it.
  assert.equal(rugcheckReason({ ...ok, lpLockedPct: null, creatorPct: null, insiderPct: null, flaggedHolderPct: null }, config), null);
  assert.equal(rugcheckReason(null, config), null);
});

test("desk score: six parts out of 100, and unknown parts stay neutral", () => {
  const strong = {
    priceChangeH1: 35, buyersH1: 120, sellersH1: 40, buysH1: 300, sellsH1: 100, tradesH1: 400,
    liquidityUsd: 60_000, marketCapUsd: 500_000,
    holderCounts: [{ at: 0, holders: 500 }, { at: 30 * 60_000, holders: 600 }],
  };
  const hot = deskScore(strong, { smartCrowd: { score: 0.9, known: 6 } });
  assert.ok(hot.score >= 80, `a coin doing everything right scored ${hot.score}`);
  assert.equal(hot.measured, 6, "all six parts measured");
  assert.equal(hot.of, 6);

  const weak = deskScore({
    priceChangeH1: -4, buyersH1: 8, sellersH1: 30, buysH1: 20, sellsH1: 80, tradesH1: 100,
    liquidityUsd: 6_000, marketCapUsd: 500_000,
  });
  assert.ok(weak.score < 40, `a coin doing everything wrong scored ${weak.score}`);

  // Nothing known at all: every part falls back to neutral, which lands at 50 — comfortably under
  // the pass mark, so an unmeasured coin is never bought on a shrug.
  const blank = deskScore({});
  assert.equal(blank.score, 50);
  assert.equal(blank.measured, 0);
  assert.equal(blank.parts.smartWallets, 0.5);

  // Holder growth needs two samples far enough apart to be a rate rather than a number.
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 100 }]), null);
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 100 }, { at: 1000, holders: 150 }]), null, "1s apart is not a rate");
  assert.equal(holderGrowthPerHour([{ at: 0, holders: 100 }, { at: 3_600_000, holders: 150 }]), 0.5);

  // The lead is only ever a part we actually measured, so the log line cannot credit a guess.
  const onlyDepth = deskScore({ liquidityUsd: 60_000, marketCapUsd: 500_000 });
  assert.equal(onlyDepth.lead, "liqMcap");
});

test("scout window: the age and size band, and missing data waits rather than kills", () => {
  const window = { minAgeSeconds: 1800, maxAgeSeconds: 259_200, minMarketCapUsd: 300_000, maxMarketCapUsd: 20_000_000 };
  const coin = { marketCapUsd: 1_000_000 };

  assert.equal(windowReason(coin, window, 7200), null);
  assert.equal(windowReason(coin, window, 600).category, "too_young");
  assert.equal(windowReason(coin, window, 10 * 86_400).category, "too_old");
  assert.equal(windowReason({ marketCapUsd: 50_000 }, window, 7200).category, "mcap_low");
  assert.equal(windowReason({ marketCapUsd: 90_000_000 }, window, 7200).category, "mcap_high");

  // A coin whose age or size has not been filled in yet is simply not handed on this round. It is
  // not a kill, because next refresh it may be both known and inside the window.
  assert.equal(windowReason(coin, window, null).wait, true);
  assert.equal(windowReason({}, window, 7200).wait, true);
});

test("config: the desk's window, kill list and trade shape have safe defaults and are validated", () => {
  const c = loadConfig({});
  assert.equal(c.mode, "paper");
  assert.equal(c.solanaRpcUrl, "");
  assert.equal(c.topHoldersSkipLargest, true);

  // The spec of the desk, in numbers.
  assert.equal(c.window.minAgeSeconds, 30 * 60);
  assert.equal(c.window.maxAgeSeconds, 72 * 3600);
  assert.equal(c.window.minMarketCapUsd, 300_000);
  assert.equal(c.window.maxMarketCapUsd, 20_000_000);
  assert.equal(c.gates.minLiquidityUsd, 25_000);
  assert.equal(c.minLpLockedPct, 90);
  assert.equal(c.maxDevPct, 3);
  assert.equal(c.maxBundledPct, 10);
  assert.equal(c.maxPriceChangeH1, 80);
  assert.equal(c.passScore, 70);
  assert.equal(c.positionPct, 0.08);
  assert.equal(c.stopPct, 0.06);
  assert.equal(c.trailAfterPct, 0.12);

  // Position size is a share of the balance now; a fixed per-trade amount is not a setting.
  for (const gone of ["buyAmountSol", "greenScore", "watchScore", "pullbackPct", "takeProfitPct", "minScore", "lanes"]) {
    assert.equal(c[gone], undefined, `${gone} must not come back as a setting`);
  }

  assert.throws(() => loadConfig({ MODE: "live" }), /paper/);
  assert.throws(() => loadConfig({ SOLANA_RPC_URL: "ftp://nope" }), /SOLANA_RPC_URL/);
  assert.throws(() => loadConfig({ TOP_HOLDERS_SKIP_LARGEST: "maybe" }), /true or false/);
  assert.throws(() => loadConfig({ MIN_MARKET_CAP_USD: "100000", MAX_MARKET_CAP_USD: "50000" }), /MIN_MARKET_CAP_USD/);
  assert.throws(() => loadConfig({ MIN_AGE_MINUTES: "4320", MAX_AGE_HOURS: "1" }), /MIN_AGE_MINUTES/);
  // A trail that arms below the stop would mean the stop can never fire: refuse to start.
  assert.throws(() => loadConfig({ STOP_PCT: "0.2", TRAIL_AFTER_PCT: "0.1" }), /TRAIL_AFTER_PCT/);
  assert.equal(loadConfig({ PASS_SCORE: "85" }).passScore, 85);
  assert.equal(loadConfig({ POSITION_PCT: "0.05" }).positionPct, 0.05);
});
