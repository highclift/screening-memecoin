import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccount, loadLaneState, saveLaneState } from "../src/lanestate.js";
import { fetchDexSnapshots } from "../src/pricefeed.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lanes-")), "lanes-state.json");

test("loadLaneState creates fresh accounts when there is no file", () => {
  const s = loadLaneState({ young: 1, veteran: 2 }, "2026-11-10", tmp());
  assert.equal(s.lanes.young.balanceSol, 1);
  assert.equal(s.lanes.veteran.startBalanceSol, 2);
  assert.deepEqual(s.lanes.young.positions, {});
  assert.deepEqual(s.cooldowns.young, {});
});

test("lane state round-trips and survives a restart", () => {
  const file = tmp();
  const s = loadLaneState({ young: 1, veteran: 1 }, "2026-11-10", file);
  s.lanes.young.balanceSol = 0.9;
  s.lanes.young.positions.MINT1 = { mint: "MINT1", costSol: 0.01 };
  s.cooldowns.veteran.MINT2 = 12345;
  saveLaneState(s, file);
  const again = loadLaneState({ young: 1, veteran: 1 }, "2026-11-11", file);
  assert.equal(again.lanes.young.balanceSol, 0.9);
  assert.equal(again.lanes.young.positions.MINT1.costSol, 0.01);
  assert.equal(again.cooldowns.veteran.MINT2, 12345);
  assert.equal(fs.existsSync(`${file}.tmp`), false, "atomic write leaves no temp file");
});

test("a corrupt account is replaced instead of crashing the bot", () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ lanes: { young: { balanceSol: "lots", positions: [] }, veteran: createAccount(3, "2026-11-10") }, cooldowns: { young: [] } }));
  const s = loadLaneState({ young: 1, veteran: 1 }, "2026-11-10", file);
  assert.equal(s.lanes.young.balanceSol, 1, "corrupt young account is recreated");
  assert.equal(s.lanes.veteran.balanceSol, 3, "the valid one is kept");
  assert.deepEqual(s.cooldowns.young, {});
});

test("an unreadable file falls back to fresh accounts", () => {
  const file = tmp();
  fs.writeFileSync(file, "{not json");
  const s = loadLaneState({ young: 1 }, "2026-11-10", file);
  assert.equal(s.lanes.young.balanceSol, 1);
});

test("fetchDexSnapshots exposes the age-lane fields and keeps the fresh-lane ones", async () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const pair = {
    baseToken: { address: "MINTX" }, quoteToken: { address: SOL, symbol: "SOL" },
    priceNative: "0.000002", priceUsd: "0.0003", marketCap: 4_200_000, fdv: 4_300_000, pairCreatedAt: 1_700_000_000_000,
    liquidity: { usd: 90_000 }, pairAddress: "poolX",
    txns: { m5: { buys: 10, sells: 5 }, h1: { buys: 300, sells: 200 } },
    volume: { h1: 55_000, h24: 700_000 }, priceChange: { h1: -4.5 },
  };
  const fetchImpl = async () => new Response(JSON.stringify([pair]));
  const snap = (await fetchDexSnapshots(["MINTX"], fetchImpl)).get("MINTX");
  assert.equal(snap.reportedMarketCapUsd, 4_200_000);
  assert.equal(snap.tradesH1, 500);
  assert.equal(snap.buysH1, 300);
  assert.equal(snap.trades, 15);
  assert.equal(snap.volumeH1, 55_000);
  assert.equal(snap.priceChangeH1, -4.5);
  assert.equal(snap.pairCreatedAt, 1_700_000_000_000);
  assert.equal(snap.marketCapUsd, 0.0003 * 1_000_000_000, "fresh-lane value still assumes the 1B supply");
  assert.ok(Math.abs(snap.solUsd - 150) < 1e-6);

  const noCap = { ...pair, marketCap: undefined, fdv: undefined };
  const snap2 = (await fetchDexSnapshots(["MINTX"], async () => new Response(JSON.stringify([noCap])))).get("MINTX");
  assert.equal(snap2.reportedMarketCapUsd, null, "unknown stays unknown (the age lanes then skip the update)");
});
