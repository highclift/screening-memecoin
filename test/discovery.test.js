import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { SOL_MINT, assessPool, createBudget, fetchGeckoPools, fetchGeckoPoolsMulti, parseGeckoPool } from "../src/discovery.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Shaped like the GeckoTerminal pool object (attributes + relationships with network-prefixed ids).
function row({ address = "poolAAA", mint = "MintAAA", quote = SOL_MINT, ageHours = 5, liq = "40000", mcap = "300000", fdv = "300000",
  volH1 = "50000", buys = 120, sells = 80, buyers = 60, name = "DOGE / SOL" } = {}) {
  return {
    id: `solana_${address}`,
    type: "pool",
    attributes: {
      address,
      name,
      pool_created_at: new Date(NOW - ageHours * 3_600_000).toISOString(),
      fdv_usd: fdv,
      market_cap_usd: mcap,
      reserve_in_usd: liq,
      volume_usd: { m5: "100", h1: volH1, h24: "900000" },
      price_change_percentage: { m5: "0.1", h1: "3.2", h24: "-1.1" },
      transactions: { h1: { buys, sells, buyers, sellers: 50 }, h24: { buys: 900, sells: 800, buyers: 300, sellers: 250 } },
    },
    relationships: {
      base_token: { data: { id: `solana_${mint}`, type: "token" } },
      quote_token: { data: { id: `solana_${quote}`, type: "token" } },
    },
  };
}

const lanes = loadConfig({}).lanes;

test("parseGeckoPool extracts the fields the bot uses", () => {
  const p = parseGeckoPool(row(), NOW);
  assert.equal(p.pool, "poolAAA");
  assert.equal(p.mint, "MintAAA");
  assert.equal(p.quoteMint, SOL_MINT);
  assert.equal(p.symbol, "DOGE");
  assert.equal(p.ageSeconds, 5 * 3600);
  assert.equal(p.liquidityUsd, 40000);
  assert.equal(p.marketCapUsd, 300000);
  assert.equal(p.volumeH1Usd, 50000);
  assert.equal(p.tradesH1, 200);
  assert.equal(p.buysH1, 120);
  assert.equal(p.buyersH1, 60);
  assert.equal(p.priceChangeH1, 3.2);
});

test("parseGeckoPool: unverified market cap falls back to FDV; missing data is null, not 0", () => {
  const unverified = parseGeckoPool(row({ mcap: null, fdv: "250000" }), NOW);
  assert.equal(unverified.marketCapUsd, 250000);

  const sparse = row();
  delete sparse.attributes.reserve_in_usd;
  delete sparse.attributes.transactions;
  delete sparse.attributes.volume_usd;
  sparse.attributes.market_cap_usd = null;
  sparse.attributes.fdv_usd = null;
  const p = parseGeckoPool(sparse, NOW);
  assert.equal(p.liquidityUsd, null);
  assert.equal(p.marketCapUsd, null);
  assert.equal(p.volumeH1Usd, null);
  assert.equal(p.tradesH1, null);
  assert.equal(p.buyersH1, null);
});

test("parseGeckoPool rejects garbage rows", () => {
  assert.equal(parseGeckoPool(null), null);
  assert.equal(parseGeckoPool({}), null);
  assert.equal(parseGeckoPool({ attributes: "x" }), null);
  const noDate = row();
  delete noDate.attributes.pool_created_at;
  assert.equal(parseGeckoPool(noDate, NOW).ageSeconds, null);
});

test("assessPool: young pool that passes the cheap checks becomes a candidate", () => {
  const v = assessPool(parseGeckoPool(row(), NOW), lanes);
  assert.deepEqual(v, { lane: "young" });
});

test("assessPool: veteran band", () => {
  const v = assessPool(parseGeckoPool(row({ ageHours: 24 * 10, mcap: "2000000", fdv: "2000000", liq: "120000", volH1: "90000" }), NOW), lanes);
  assert.deepEqual(v, { lane: "veteran" });
});

test("assessPool ignores pools that belong to no lane", () => {
  assert.equal(assessPool(parseGeckoPool(row({ ageHours: 0.3 }), NOW), lanes), null, "under 1h is the fresh lane's job");
  assert.equal(assessPool(parseGeckoPool(row({ ageHours: 24 * 60 }), NOW), lanes), null, "older than 30 days");
  assert.equal(assessPool(parseGeckoPool(row({ quote: USDC }), NOW), lanes), null, "non-SOL quote");
  assert.equal(assessPool(parseGeckoPool(row({ mint: SOL_MINT, quote: SOL_MINT }), NOW), lanes), null, "base is SOL itself");
  assert.equal(assessPool(parseGeckoPool(row({ mint: USDC }), NOW), lanes), null, "stablecoin base");
  assert.equal(assessPool({ mint: "", pool: "" }, lanes), null);
});

test("assessPool returns a counted rejection with the reason", () => {
  assert.equal(assessPool(parseGeckoPool(row({ mcap: "10000", fdv: "10000" }), NOW), lanes).reject.category, "market_cap");
  assert.equal(assessPool(parseGeckoPool(row({ liq: "2000" }), NOW), lanes).reject.category, "liquidity");
  assert.equal(assessPool(parseGeckoPool(row({ volH1: "100" }), NOW), lanes).reject.category, "volume");
  assert.match(assessPool(parseGeckoPool(row({ liq: "2000" }), NOW), lanes).reject.detail, /liquidity \$2,000 below \$15,000/);
});

test("assessPool: unknown data never rejects", () => {
  const r = row();
  r.attributes.reserve_in_usd = null;
  r.attributes.market_cap_usd = null;
  r.attributes.fdv_usd = null;
  r.attributes.volume_usd = {};
  assert.deepEqual(assessPool(parseGeckoPool(r, NOW), lanes), { lane: "young" });
});

test("assessPool skips a lane that is switched off", () => {
  const off = loadConfig({ LANES: "fresh" }).lanes;
  assert.equal(assessPool(parseGeckoPool(row(), NOW), off), null);
});

test("createBudget enforces calls per minute with a sliding window", () => {
  let t = 0;
  const budget = createBudget(3, () => t);
  assert.equal(budget.tryTake(), true); // t=0
  t = 10;
  assert.equal(budget.tryTake(), true);
  t = 20;
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.tryTake(), false);
  assert.equal(budget.used(), 3);
  t = 59_999;
  assert.equal(budget.tryTake(), false);
  t = 60_000; // only the first call (t=0) has left the window
  assert.equal(budget.tryTake(), true);
  assert.equal(budget.used(), 3);
  t = 200_000; // everything has expired
  assert.equal(budget.used(), 0);
});

test("fetchGeckoPools builds the right URLs and surfaces rate limiting", async () => {
  const urls = [];
  const ok = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ data: [row()] }));
  };
  assert.equal((await fetchGeckoPools({ kind: "trending", page: 2 }, ok)).length, 1);
  await fetchGeckoPools({ kind: "top", page: 3 }, ok);
  await fetchGeckoPools({ kind: "new", page: 1 }, ok);
  assert.match(urls[0], /networks\/solana\/trending_pools\?page=2$/);
  assert.match(urls[1], /networks\/solana\/pools\?page=3$/);
  assert.match(urls[2], /networks\/solana\/new_pools\?page=1$/);

  const limited = async () => new Response("slow down", { status: 429 });
  await assert.rejects(() => fetchGeckoPools({ kind: "top", page: 1 }, limited), (error) => error.rateLimited === true);
  const broken = async () => new Response("oops", { status: 500 });
  await assert.rejects(() => fetchGeckoPools({ kind: "top", page: 1 }, broken), /HTTP 500/);
  const weird = async () => new Response(JSON.stringify({ nope: true }));
  assert.deepEqual(await fetchGeckoPools({ kind: "top", page: 1 }, weird), []);
});

test("fetchGeckoPoolsMulti joins up to 30 addresses and skips empty input", async () => {
  let url = "";
  const ok = async (u) => {
    url = u;
    return new Response(JSON.stringify({ data: [] }));
  };
  const many = Array.from({ length: 40 }, (_, i) => `pool${i}`);
  await fetchGeckoPoolsMulti(many, ok);
  assert.match(url, /pools\/multi\/pool0,pool1,/);
  assert.equal(url.split("/multi/")[1].split(",").length, 30);
  url = "";
  assert.deepEqual(await fetchGeckoPoolsMulti([], ok), []);
  assert.equal(url, "");
});
