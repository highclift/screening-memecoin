import test from "node:test";
import assert from "node:assert/strict";
import { SOL_MINT, isMemecoinPool, createBudget, fetchGeckoPools, fetchGeckoPoolsMulti, parseGeckoPool } from "../src/discovery.js";

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

test("isMemecoinPool: a SOL-paired memecoin at any age is screened", () => {
  // Age is not part of this decision: bot 1 screens a 20-minute-old coin and a 3-month-old coin
  // the same way, and bot 2 decides what to make of them.
  for (const ageHours of [0.3, 5, 24 * 10, 24 * 200]) {
    assert.equal(isMemecoinPool(parseGeckoPool(row({ ageHours }), NOW)), true, `age ${ageHours}h`);
  }
  // Unknown numbers are no reason to skip a coin either.
  const sparse = row();
  sparse.attributes.reserve_in_usd = null;
  sparse.attributes.market_cap_usd = null;
  sparse.attributes.fdv_usd = null;
  sparse.attributes.volume_usd = {};
  assert.equal(isMemecoinPool(parseGeckoPool(sparse, NOW)), true);
});

test("isMemecoinPool: anything that is not a memecoin against SOL is skipped", () => {
  assert.equal(isMemecoinPool(parseGeckoPool(row({ quote: USDC }), NOW)), false, "non-SOL quote");
  assert.equal(isMemecoinPool(parseGeckoPool(row({ mint: SOL_MINT, quote: SOL_MINT }), NOW)), false, "base is SOL itself");
  assert.equal(isMemecoinPool(parseGeckoPool(row({ mint: USDC }), NOW)), false, "stablecoin base");
  assert.equal(isMemecoinPool({ mint: "", pool: "" }), false);
  assert.equal(isMemecoinPool(null), false);
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
