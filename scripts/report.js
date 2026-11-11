// What the desk actually did, read back from its own logs.
//   data/scout.jsonl   what the scout saw
//   data/kills.jsonl   every refusal, from any agent, with the reason — and every pass
//   data/trades.jsonl  what the executor did about the ones that got through
// Usage: npm run report
//
// The kill log is the point of this report. A desk that only logs its trades can tell you what it
// won and lost; this one can tell you what it refused, which agent refused it, and therefore which
// rule is actually shaping the night.
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("data");

function read(name) {
  const records = [];
  let skipped = 0;
  for (const file of [`${name}.1`, name].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f))) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        skipped += 1; // the last line can be half-written while the bot is running
      }
    }
  }
  return { records, skipped };
}

const bot1 = read("scout.jsonl");
const bot2 = read("kills.jsonl");
const bot3 = read("trades.jsonl");

if (!bot1.records.length && !bot2.records.length && !bot3.records.length) {
  console.log("No logs yet in data/. Run the bot first (npm start or npm run bot).");
  process.exit(0);
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
const sol = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(5)}`;
const counted = (rows, key) => {
  const out = {};
  for (const row of rows) {
    const value = row[key] ?? "unknown";
    out[value] = (out[value] ?? 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
};
const list = (pairs, limit = 8) => pairs.slice(0, limit).map(([k, v]) => `${k} ${v}`).join(", ") || "-";

// Age buckets exist to answer one question: is the pipeline really looking at old coins, or only
// at fresh launches?
function ageBucket(seconds) {
  if (!Number.isFinite(seconds)) return "unknown age";
  if (seconds < 3600) return "< 1h";
  if (seconds < 86_400) return "1h - 24h";
  if (seconds < 7 * 86_400) return "1d - 7d";
  if (seconds < 30 * 86_400) return "7d - 30d";
  return "> 30d";
}

// Bot 1's log runs to hundreds of thousands of lines, so nothing here may spread an array into
// Math.max / Math.min — that overflows the call stack.
function span(records) {
  let min = Infinity;
  let max = -Infinity;
  let seen = 0;
  for (const record of records) {
    const t = Date.parse(record.t);
    if (!Number.isFinite(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
    seen += 1;
  }
  return seen < 2 ? null : (max - min) / 60_000;
}

console.log("Paper results only: they ignore latency, failed sells and rugs you cannot exit.\n");

// ---------- SCOUT ----------
console.log("== AGENT 1: SCOUT ==");
if (!bot1.records.length) console.log("nothing logged yet");
else {
  const minutes = span(bot1.records);
  const firstSightings = bot1.records.filter((r) => r.type === "new");
  console.log(`log lines ${bot1.records.length} | distinct coins ${new Set(bot1.records.map((r) => r.mint)).size} | first sightings ${firstSightings.length}${minutes ? ` over ${minutes.toFixed(0)} min (${(firstSightings.length / Math.max(minutes, 1)).toFixed(0)} new coins/min)` : ""}`);
  console.log(`sources: ${list(counted(bot1.records, "source"))}`);
  console.log(`age of coins screened: ${list(counted(firstSightings.map((r) => ({ bucket: ageBucket(r.ageSeconds) })), "bucket"))}`);
}

// ---------- THE FUNNEL: EVERY KILL, BY AGENT ----------
console.log("\n== THE FUNNEL: WHAT WAS REFUSED, AND BY WHOM ==");
if (!bot2.records.length) console.log("nothing logged yet");
else {
  const kills = bot2.records.filter((r) => r.type === "kill");
  const passes = bot2.records.filter((r) => r.type === "pass");
  console.log(`kills ${kills.length} | coins that cleared the filter ${passes.filter((r) => r.stage === "filter").length} | coins the analyst passed ${passes.filter((r) => r.stage === "analyst").length}`);
  console.log(`by agent: ${list(counted(kills, "stage"))}`);

  // Per agent, because one stage's reasons are not comparable with another's: the scout turns away
  // most of the world on the window alone, and that number would bury everything else.
  for (const stage of ["scout", "filter", "analyst", "risk"]) {
    const mine = kills.filter((r) => r.stage === stage);
    if (!mine.length) continue;
    console.log(`  ${stage.padEnd(9)} ${String(mine.length).padStart(6)} | ${list(counted(mine, "category"), 8)}`);
  }

  const scored = kills.filter((r) => r.stage === "analyst" && Number.isFinite(r.score));
  if (scored.length) {
    const values = scored.map((r) => r.score).sort((a, b) => a - b);
    console.log(`scores of the coins the analyst refused: median ${values[Math.floor(values.length / 2)]}, best ${values[values.length - 1]} (pass mark is what to compare these with)`);
  }
  const rugs = bot2.records.filter((r) => r.type === "rug");
  if (rugs.length) console.log(`coins banned after collapsing while held: ${rugs.length} (never bought again)`);
}

// ---------- EXECUTOR + RISK ----------
console.log("\n== AGENTS 4 & 5: EXECUTION AND RISK ==");
if (!bot3.records.length) console.log("nothing logged yet");
else {
  const entries = bot3.records.filter((r) => r.type === "entry");
  const exits = bot3.records.filter((r) => r.type === "exit");
  const wins = exits.filter((r) => r.pnlSol > 0).length;
  const total = exits.reduce((sum, r) => sum + (Number(r.pnlSol) || 0), 0);
  const held = exits.reduce((sum, r) => sum + (Number(r.heldSeconds) || 0), 0);
  console.log(`entries ${entries.length} | closed ${exits.length} | win rate ${pct(wins, exits.length)} | total ${sol(total)} SOL | avg ${exits.length ? sol(total / exits.length) : "-"} SOL | avg hold ${exits.length ? Math.round(held / exits.length) : "-"}s`);
  if (exits.length) {
    console.log(`exits by reason: ${list(counted(exits, "reason"), 10)}`);
    // With a trailing take-profit and no target, this is the question that matters: are winners
    // being ended by the trail (good) or by a timer / the stop coming back (not good)?
    const winners = exits.filter((r) => r.pnlSol > 0);
    if (winners.length) {
      console.log(`how winners ended: ${list(counted(winners, "reason"), 10)}`);
      const best = winners.map((r) => r.pnlSol).sort((a, b) => b - a)[0];
      console.log(`best single trade ${sol(best)} SOL | average winner ${sol(winners.reduce((t, r) => t + r.pnlSol, 0) / winners.length)} SOL`);
    }
  }
  if (entries.length) {
    console.log(`entries by coin age: ${list(counted(entries.map((r) => ({ bucket: ageBucket(r.ageSeconds) })), "bucket"))}`);
    const blocked = bot2.records.filter((r) => r.stage === "risk");
    if (blocked.length) console.log(`entries held back by a money limit: ${list(counted(blocked, "detail"))}`);
  }

  // Pair each exit with the entry before it, then slice the outcomes two ways.
  const lastEntry = new Map();
  const byScore = {};
  const byTrigger = {};
  const bucket = (table, key) => (table[key] = table[key] ?? { trades: 0, wins: 0, pnl: 0 });
  for (const row of bot3.records) {
    if (row.type === "entry") lastEntry.set(row.mint, row);
    if (row.type === "exit" && lastEntry.has(row.mint)) {
      const entry = lastEntry.get(row.mint);
      lastEntry.delete(row.mint);
      const won = row.pnlSol > 0;
      const pnl = Number(row.pnlSol) || 0;

      const trigger = bucket(byTrigger, entry.trigger ?? "unknown");
      trigger.trades += 1;
      if (won) trigger.wins += 1;
      trigger.pnl += pnl;

      if (!Number.isFinite(entry.score)) continue;
      const key = entry.score >= 90 ? "90+" : entry.score >= 80 ? "80-89" : entry.score >= 70 ? "70-79" : "below 70";
      const score = bucket(byScore, key);
      score.trades += 1;
      if (won) score.wins += 1;
      score.pnl += pnl;
    }
  }

  const table = (title, rows) => {
    if (rows.length < 2) return;
    console.log(`\n${title}`);
    for (const [key, value] of rows) {
      console.log(`  ${key.padEnd(16)} trades ${String(value.trades).padStart(4)} | win rate ${pct(value.wins, value.trades).padStart(4)} | total ${sol(value.pnl)} SOL | avg ${sol(value.pnl / value.trades)} SOL`);
    }
  };
  // Buying a retrace gets a better price; buying a breakout catches coins that never retrace.
  // Which one is actually paying is a question only the journal can answer.
  table("entry trigger vs outcome (is the dip or the breakout making the money?):",
    Object.entries(byTrigger).sort((a, b) => b[1].trades - a[1].trades));
  // The question the whole analyst exists to answer. If the high buckets do not out-earn the low
  // ones over a few hundred trades, the weights in DESK_WEIGHTS are decoration.
  table("analyst score vs outcome (does a higher score actually win more?):",
    Object.entries(byScore).sort((a, b) => b[0].localeCompare(a[0])));
}

// ---------- account ----------
const statePath = path.join(dir, "paper-state.json");
if (fs.existsSync(statePath)) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    console.log(`\nPaper account: ${Number(state.balanceSol).toFixed(5)} SOL (started at ${state.startBalanceSol}) | open positions ${Object.keys(state.positions ?? {}).length} | closed trades ${(state.closedTrades ?? []).length}`);
  } catch (error) {
    console.log(`\nCould not read ${statePath}: ${error.message}`);
  }
}

const skipped = bot1.skipped + bot2.skipped + bot3.skipped;
if (skipped) console.log(`\n(${skipped} unreadable log lines skipped)`);
