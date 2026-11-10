// The dashboard rebuilds every feed sentence from the dictionary by matching the worker's own log
// templates. If a template changes in src/ and the matcher does not, the line silently drops to
// "technical details only" — so every line the three bots can print is checked here.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const publicDir = path.resolve("public");
const dictionary = fs.readFileSync(path.join(publicDir, "i18n.js"), "utf8");

const definedKeys = new Set();
{
  let lang = "";
  for (const line of dictionary.split(/\r?\n/)) {
    const start = line.match(/^ {2}(id|en): \{$/);
    if (start) lang = start[1];
    else if (line === "  },") lang = "";
    const key = line.match(/^\s*"([^"]+)":/);
    if (key && lang === "id") definedKeys.add(key[1]);
  }
}

// humanize.js is a classic script; load it with the i18n helpers stubbed out. The stub answers a
// key that exists with "TEXT:<key>" and an unknown key with the key itself, which is what the real
// t() does — so the fallback paths in the label helpers are exercised for real.
function loadHumanizer() {
  const source = fs.readFileSync(path.join(publicDir, "humanize.js"), "utf8");
  const t = (key) => (definedKeys.has(key) ? `TEXT:${key}` : key);
  const tn = (key) => t(key);
  const factory = new Function("t", "tn", `${source}\nreturn { humanizeLog, categoryLabel, leadText, waitingText, surgeText, fmtScore };`);
  return factory(t, tn);
}

const h = loadHumanizer();

// Exactly what src/index.js, src/feed.js and the three bots print. Keep in step with them.
const WORKER_LINES = [
  "[start] mode=paper paper balance=1.00000 SOL, 0.01 SOL per trade, max 3 open, max 20 entries/day, daily loss limit 0.05 SOL.",
  "[pipeline] bot 1 screens every coin (any age) -> bot 2 judges can-it-pump -> bot 3 times entry and exit. No strategy settings: bot 3 measures each coin and sets its own stops.",
  "[pipeline] bot 2 turns a coin green at score 0.58; holder check OFF (set SOLANA_RPC_URL); dev history max 1 rug / 5 launches.",
  "[shutdown] Paper account saved; all three bots stopped.",
  "[bot1] Screening every coin, any age: 17 GeckoTerminal pages round-robin every 2.5s + 30 coins refreshed every 2s. Log: data/bot1-screened.jsonl",
  "[bot1] sweep error: fetch failed",
  "[bot1] refresh error: terminated",
  "[bot2] GREEN JEANPHIL score=0.82 (surge, volume 18.0x its normal hour) age=30d",
  "[bot2] GREEN OnlyCats score=0.844 (surge, 2.4x the pool traded in an hour) age=12h",
  "[bot2] GREEN PEPE score=0.61 (breadth) age=12h",
  "[bot2] PEPE is no longer green: 1h volume $900 below $2,000.",
  "[bot3] BUY JEANPHIL MC=$450,000 after a 12.3% dip and a 4.1% bounce | stop 10.0% trail 8.0% (this coin moves ~4.0%/min)",
  "[bot3] SELL:trail JEANPHIL MC=$430,000 pnl=-0.00120 SOL | balance=0.99880 SOL",
  "[bot3] SELL:trail-locked PEPE MC=$510,000 pnl=+0.00240 SOL | balance=1.00240 SOL",
  "[bot3] SELL:stop-loss PEPE MC=$390,000 pnl=-0.00180 SOL | balance=0.99820 SOL",
  "[bot3] SELL:stall PEPE MC=$455,000 pnl=+0.00010 SOL | balance=1.00010 SOL",
  "[bot3] SELL:breakdown PEPE MC=$410,000 pnl=-0.00090 SOL | balance=0.99910 SOL",
  "[bot3] SELL:max-hold PEPE MC=$452,000 pnl=+0.00005 SOL | balance=1.00005 SOL",
  "[bot3] SELL:max-hold-stale PEPE MC=$452,000 pnl=+0.00005 SOL | balance=1.00005 SOL",
  "[feed] PumpPortal connected: new launches and AMM migrations are streaming in.",
  "[feed] PumpPortal disconnected; reconnecting in 2s.",
  '[feed] PumpPortal response: {"message":"Successfully subscribed to token creation events."}',
  '[feed] PumpPortal response: {"errors":["Invalid API key"]}',
  "[feed] Could not subscribe: socket closed",
  "[feed] GeckoTerminal trending page 2 failed: GeckoTerminal rate limited (429)",
  "[feed] SOL/USD refresh failed: fetch failed",
  "[settings] Batas uang diperbarui tanpa restart bot.",
  "[settings error] BUY_AMOUNT_SOL cannot exceed PAPER_START_BALANCE_SOL.",
];

// What server.js prints.
const SERVER_LINES = [
  "[web] Dashboard aktif di http://127.0.0.1:3000.",
  "Memulai scanner paper trading…",
  "[debug] Bot worker berjalan (pid 1234).",
  "[debug] Perubahan strategi dikirim ke bot aktif.",
  "Menghentikan scanner…",
  "Bot dihentikan.",
  "Bot berhenti karena error; periksa pesan worker stderr di atas.",
  "Paper account direset ke 2 SOL.",
  "[start error] BUY_AMOUNT_SOL cannot exceed PAPER_START_BALANCE_SOL.",
  "[worker stderr] TypeError: boom",
  "[worker error] spawn ENOENT",
];

test("every log line the bots print becomes a translated sentence", () => {
  const unmatched = [];
  const unknownKeys = [];
  for (const line of [...WORKER_LINES, ...SERVER_LINES]) {
    const item = h.humanizeLog(line);
    if (!item) {
      unmatched.push(line);
      continue;
    }
    if (!definedKeys.has(item.key)) unknownKeys.push(`${item.key} (from: ${line})`);
  }
  assert.deepEqual(unmatched, [], "these log lines would only show under Technical details");
  assert.deepEqual(unknownKeys, [], "these matchers point at keys that do not exist");
});

test("placeholders in the matched sentence are all filled", () => {
  // Every {placeholder} in a dictionary string must be supplied by the matcher that uses that key.
  const idBlock = dictionary.slice(dictionary.indexOf("  id: {"), dictionary.indexOf("  en: {"));
  const strings = new Map();
  for (const match of idBlock.matchAll(/^\s*"([^"]+)": "((?:[^"\\]|\\.)*)",$/gm)) strings.set(match[1], match[2]);

  const missing = [];
  for (const line of WORKER_LINES) {
    const item = h.humanizeLog(line);
    if (!item) continue;
    const template = strings.get(item.key);
    if (!template) continue;
    for (const placeholder of template.matchAll(/\{(\w+)\}/g)) {
      const name = placeholder[1];
      if (name === "n") continue; // supplied by tn()
      if (!(name in (item.params ?? {}))) missing.push(`${item.key} needs {${name}} (from: ${line})`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the three bots are named in the lines they produce", () => {
  assert.equal(h.humanizeLog("[bot1] sweep error: x").bot, "screener");
  assert.equal(h.humanizeLog("[bot2] GREEN A score=0.6 (surge) age=1h").bot, "filter");
  assert.equal(h.humanizeLog("[bot3] SELL:stall A MC=$1 pnl=+0.00001 SOL").bot, "executor");
  assert.equal(h.humanizeLog("[web] up").bot, "", "server lines belong to no bot");
});

test("a surge is quoted when the log line carries one", () => {
  const withSurge = h.humanizeLog("[bot2] GREEN JEAN score=0.82 (surge, volume 18.0x its normal hour) age=30d");
  assert.equal(withSurge.key, "ev.bot2.greenSurge");
  assert.equal(withSurge.params.times, "18.0");
  assert.equal(withSurge.params.age, "30d");

  // A coin too young to have a normal hour is quoted against its own pool instead.
  const withTurnover = h.humanizeLog("[bot2] GREEN CATS score=0.84 (surge, 2.4x the pool traded in an hour) age=12h");
  assert.equal(withTurnover.key, "ev.bot2.greenTurnover");
  assert.equal(withTurnover.params.times, "2.4");

  const without = h.humanizeLog("[bot2] GREEN JEAN score=0.60 (depth) age=4h");
  assert.equal(without.key, "ev.bot2.green");
  assert.equal(without.params.times, "");
});

test("unknown lines stay technical instead of inventing a sentence", () => {
  assert.equal(h.humanizeLog("something nobody wrote a matcher for"), null);
  assert.equal(h.humanizeLog(""), null);
  assert.equal(h.humanizeLog(null), null);
});

test("label helpers fall back instead of printing a raw key", () => {
  assert.equal(h.categoryLabel("dead_volume"), "TEXT:reason.dead_volume");
  assert.equal(h.categoryLabel("something_new"), "something new", "an unknown category is readable");
  assert.equal(h.leadText("surge"), "TEXT:lead.surge");
  assert.equal(h.leadText("whatever"), "whatever");
  assert.equal(h.waitingText({ waitingFor: "dip", dipPct: 0.123 }), "TEXT:waiting.dip");
  assert.equal(h.waitingText({}), "TEXT:waiting.unknown");
  assert.equal(h.fmtScore(0.5), "0.50");
  assert.equal(h.fmtScore(null), "—");
  assert.equal(h.surgeText({ surgeFrom: "baseline", surgeRatio: 18.4 }), "TEXT:frag.times");
  assert.equal(h.surgeText({ surgeFrom: "turnover", turnover: 2.4 }), "TEXT:frag.timesPool");
  assert.equal(h.surgeText({ surgeFrom: "turnover", surgeRatio: 0.6 }), "TEXT:frag.times", "falls back to what it does know");
  assert.equal(h.surgeText({}), "—");
  assert.equal(h.surgeText(), "—");
});
