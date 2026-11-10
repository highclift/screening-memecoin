// What the three bots actually did, read back from their own logs.
//   data/bot1-screened.jsonl  what bot 1 saw
//   data/bot2-filtered.jsonl  what bot 2 made of it
//   data/bot3-trades.jsonl    what bot 3 did about it
// Usage: npm run report
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

const bot1 = read("bot1-screened.jsonl");
const bot2 = read("bot2-filtered.jsonl");
const bot3 = read("bot3-trades.jsonl");

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

function span(records) {
  const times = records.map((r) => Date.parse(r.t)).filter(Number.isFinite);
  if (times.length < 2) return null;
  return (Math.max(...times) - Math.min(...times)) / 60_000;
}

console.log("Paper results only: they ignore latency, failed sells and rugs you cannot exit.\n");

// ---------- BOT 1 ----------
console.log("== BOT 1: SCREENING ==");
if (!bot1.records.length) console.log("nothing logged yet");
else {
  const minutes = span(bot1.records);
  const firstSightings = bot1.records.filter((r) => r.type === "new");
  console.log(`log lines ${bot1.records.length} | distinct coins ${new Set(bot1.records.map((r) => r.mint)).size} | first sightings ${firstSightings.length}${minutes ? ` over ${minutes.toFixed(0)} min (${(firstSightings.length / Math.max(minutes, 1)).toFixed(0)} new coins/min)` : ""}`);
  console.log(`sources: ${list(counted(bot1.records, "source"))}`);
  console.log(`age of coins screened: ${list(counted(firstSightings.map((r) => ({ bucket: ageBucket(r.ageSeconds) })), "bucket"))}`);
}

// ---------- BOT 2 ----------
console.log("\n== BOT 2: FILTERING ==");
if (!bot2.records.length) console.log("nothing logged yet");
else {
  const verdicts = bot2.records.filter((r) => r.type === "verdict" || r.type === "recheck");
  const greens = verdicts.filter((r) => r.state === "green");
  console.log(`judgements ${verdicts.length} | green ${greens.length} (${pct(greens.length, verdicts.length)}) | watch ${verdicts.filter((r) => r.state === "watch").length} | red ${verdicts.filter((r) => r.state === "red").length} | rugs seen ${bot2.records.filter((r) => r.type === "rug").length}`);
  console.log(`why coins were turned down: ${list(counted(verdicts.filter((r) => r.state === "red"), "category"))}`);
  if (greens.length) {
    console.log(`green coins by age: ${list(counted(greens.map((r) => ({ bucket: ageBucket(r.ageSeconds) })), "bucket"))}`);
    console.log(`what made them green: ${list(counted(greens, "lead"))}`);
    const surges = greens.map((r) => r.surgeRatio).filter(Number.isFinite).sort((a, b) => a - b);
    if (surges.length) {
      console.log(`volume vs their own normal hour: median ${surges[Math.floor(surges.length / 2)].toFixed(1)}x, best ${surges[surges.length - 1].toFixed(1)}x`);
    }
    // A pipeline that only ever greenlights brand-new coins is not doing the job this split was for.
    const revived = greens.filter((r) => Number.isFinite(r.ageSeconds) && r.ageSeconds >= 86_400).length;
    console.log(`coins older than a day that went green: ${revived} (${pct(revived, greens.length)}) — this is the "pump again" case`);
  }
}

// ---------- BOT 3 ----------
console.log("\n== BOT 3: EXECUTION ==");
if (!bot3.records.length) console.log("nothing logged yet");
else {
  const entries = bot3.records.filter((r) => r.type === "entry");
  const exits = bot3.records.filter((r) => r.type === "exit");
  const wins = exits.filter((r) => r.pnlSol > 0).length;
  const total = exits.reduce((sum, r) => sum + (Number(r.pnlSol) || 0), 0);
  const held = exits.reduce((sum, r) => sum + (Number(r.heldSeconds) || 0), 0);
  console.log(`entries ${entries.length} | closed ${exits.length} | win rate ${pct(wins, exits.length)} | total ${sol(total)} SOL | avg ${exits.length ? sol(total / exits.length) : "-"} SOL | avg hold ${exits.length ? Math.round(held / exits.length) : "-"}s`);
  if (exits.length) console.log(`exits by reason: ${list(counted(exits, "reason"), 10)}`);
  if (entries.length) {
    console.log(`entries by coin age: ${list(counted(entries.map((r) => ({ bucket: ageBucket(r.ageSeconds) })), "bucket"))}`);
    const blocked = bot3.records.filter((r) => r.type === "blocked");
    if (blocked.length) console.log(`entries held back by a money limit: ${list(counted(blocked, "reason"))}`);
  }

  // Does bot 2's score separate winners from losers? Pairs each exit with the entry before it.
  const lastEntry = new Map();
  const buckets = {};
  for (const row of bot3.records) {
    if (row.type === "entry") lastEntry.set(row.mint, row);
    if (row.type === "exit" && lastEntry.has(row.mint)) {
      const entry = lastEntry.get(row.mint);
      lastEntry.delete(row.mint);
      if (!Number.isFinite(entry.score)) continue;
      const key = entry.score >= 0.8 ? "0.80+" : entry.score >= 0.7 ? "0.70-0.79" : entry.score >= 0.6 ? "0.60-0.69" : "below 0.60";
      buckets[key] = buckets[key] ?? { trades: 0, wins: 0, pnl: 0 };
      buckets[key].trades += 1;
      if (row.pnlSol > 0) buckets[key].wins += 1;
      buckets[key].pnl += Number(row.pnlSol) || 0;
    }
  }
  const rows = Object.entries(buckets).sort((a, b) => b[0].localeCompare(a[0]));
  if (rows.length > 1) {
    console.log("\nbot 2 score vs outcome (does a higher score actually win more?):");
    for (const [key, value] of rows) {
      console.log(`  score ${key.padEnd(10)} trades ${String(value.trades).padStart(4)} | win rate ${pct(value.wins, value.trades).padStart(4)} | total ${sol(value.pnl)} SOL`);
    }
  }
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
