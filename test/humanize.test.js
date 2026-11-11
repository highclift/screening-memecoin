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
  const factory = new Function("t", "tn", `${source}\nreturn { humanizeLog, categoryLabel, leadText, waitingText, surgeText, measuredText, fmtScore };`);
  return factory(t, tn);
}

const h = loadHumanizer();

// Exactly what src/index.js, src/feed.js and the three bots print. Keep in step with them.
const WORKER_LINES = [
  "[start] mode=paper paper balance=1.00000 SOL, 8% per trade (0.08000 SOL now), max 3 open, max 20 entries/day, daily loss limit 0.05 SOL.",
  "[desk] scout -> filter -> analyst -> executor <-> risk, and every kill goes to the logger.",
  "[desk] window 30m-72h old, $300k-$20M | pass mark 70/100 | stop -6%, trail 8% once +12%.",
  "[desk] safety: LP >= 90% burned/locked, dev <= 3%, bundled <= 10%, liquidity >= $25k; holder graph OFF (set SOLANA_RPC_URL).",
  "[shutdown] Paper account saved; all six agents stopped.",
  "[scout] Window: 30m-72h old, $300,000-$20,000,000 market cap. Watching wider than that: 17 GeckoTerminal pages round-robin at 15 calls/min + every known coin re-checked on DexScreener at 2700 coins/min. Log: data/scout.jsonl",
  "[scout] sweep error: fetch failed",
  "[scout] refresh error: terminated",
  "[filter] 4iJ7xEQr collapsed while held; banned from now on (3 banned).",
  "[analyst] JEANPHIL scores 82/100 (momentum leading, 5/6 parts measured) -> executor",
  "[analyst] OnlyCats scores 71/100 (uniqueBuyers leading, 4/6 parts measured) -> executor",
  "[executor] BUY JEANPHIL $450,000 score=82 dip-and-bounce | 0.08000 SOL, stop -6%, trail 8% after +12%",
  "[executor] BUY PEPE $450,000 score=? breakout | 0.08000 SOL, stop -6%, trail 8% after +12%",
  "[executor] SELL:trail JEANPHIL $430,000 pnl=-0.00120 SOL | balance=0.99880 SOL",
  "[executor] SELL:trail-locked PEPE $510,000 pnl=+0.00240 SOL | balance=1.00240 SOL",
  "[executor] SELL:stop-loss PEPE $390,000 pnl=-0.00180 SOL | balance=0.99820 SOL",
  "[executor] SELL:break-even PEPE $460,000 pnl=-0.00002 SOL | balance=0.99998 SOL",
  "[executor] SELL:stall PEPE $455,000 pnl=+0.00010 SOL | balance=1.00010 SOL",
  "[executor] SELL:breakdown PEPE $410,000 pnl=-0.00090 SOL | balance=0.99910 SOL",
  "[executor] SELL:max-hold PEPE $452,000 pnl=+0.00005 SOL | balance=1.00005 SOL",
  "[executor] SELL:max-hold-stale PEPE $452,000 pnl=+0.00005 SOL | balance=1.00005 SOL",
  "[executor] MANUAL EXIT: closed 2 positions on request.",
  "[feed] GeckoTerminal rate limited; pausing coin discovery for 30s and slowing to 7 calls/min (DexScreener and the launch feed keep running).",
  "[feed] GeckoTerminal back at full speed (15 calls/min).",
  "[feed] GeckoTerminal trending page 2 failed: HTTP 503",
  "[feed] PumpPortal connected: new launches and AMM migrations are streaming in.",
  "[feed] PumpPortal disconnected; reconnecting in 2s.",
  '[feed] PumpPortal response: {"message":"Successfully subscribed to token creation events."}',
  '[feed] PumpPortal response: {"errors":["Invalid API key"]}',
  "[feed] Could not subscribe: socket closed",
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
  assert.equal(h.humanizeLog("[scout] sweep error: x").bot, "scout");
  assert.equal(h.humanizeLog("[analyst] A scores 80/100 (momentum leading, 6/6 parts measured) -> executor").bot, "analyst");
  assert.equal(h.humanizeLog("[executor] SELL:stall A $1 pnl=+0.00001 SOL").bot, "executor");
  assert.equal(h.humanizeLog("[filter] ABC collapsed while held; banned from now on (1 banned).").bot, "filter");
  assert.equal(h.humanizeLog("[web] up").bot, "", "server lines belong to no bot");
});

test("the analyst's line keeps the score, the leading part and how much was measured", () => {
  const item = h.humanizeLog("[analyst] JEAN scores 82/100 (holderGrowth leading, 5/6 parts measured) -> executor");
  assert.equal(item.key, "ev.analyst.pass");
  assert.equal(item.params.score, "82");
  assert.equal(item.params.measured, "5/6");
  assert.equal(item.params.reason, "TEXT:lead.holderGrowth");
  assert.equal(item.params.token, "JEAN");

  // The entry line carries the size and the levels it was opened with, so a reader can tell what
  // the trade actually risked without opening the journal.
  const buy = h.humanizeLog("[executor] BUY JEAN $450,000 score=82 dip-and-bounce | 0.08000 SOL, stop -6%, trail 8% after +12%");
  assert.equal(buy.key, "ev.executor.buy");
  assert.equal(buy.params.size, "0.0800 SOL");
  assert.equal(buy.params.stop, "6");
  assert.equal(buy.params.after, "12");
  assert.equal(buy.params.trigger, "dip-and-bounce");
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
  // The analyst's score is a whole number out of 100, not the old 0..1 score.
  assert.equal(h.fmtScore(72), "72");
  assert.equal(h.fmtScore(72.4), "72");
  assert.equal(h.fmtScore(null), "—");
  assert.equal(h.measuredText({ measured: 4 }), "TEXT:frag.measured");
  assert.equal(h.measuredText({}), "—", "a candidate with no score yet shows nothing, not 0/6");
  assert.equal(h.surgeText({ surgeFrom: "baseline", surgeRatio: 18.4 }), "TEXT:frag.times");
  assert.equal(h.surgeText({ surgeFrom: "turnover", turnover: 2.4 }), "TEXT:frag.timesPool");
  assert.equal(h.surgeText({ surgeFrom: "turnover", surgeRatio: 0.6 }), "TEXT:frag.times", "falls back to what it does know");
  assert.equal(h.surgeText({}), "—");
  assert.equal(h.surgeText(), "—");
});
