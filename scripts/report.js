// Per-lane report from data/journal.jsonl (and journal.jsonl.1 if it rotated).
// Usage: npm run report
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("data");
const files = ["journal.jsonl.1", "journal.jsonl"].map((name) => path.join(dir, name)).filter((file) => fs.existsSync(file));
if (!files.length) {
  console.log("No journal yet (data/journal.jsonl). Run the bot first.");
  process.exit(0);
}

const records = [];
let skipped = 0;
for (const file of files) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped += 1; // a half-written last line is possible while the bot is running
    }
  }
}

const LANES = ["fresh", "young", "veteran"];
const pad = (value, width) => String(value).padEnd(width);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : "-");
const sol = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(5)}`;

console.log(`Journal: ${records.length} records${skipped ? ` (${skipped} unreadable lines skipped)` : ""}`);
console.log("Paper results only: they ignore latency, failed sells and rugs you cannot exit.\n");

for (const lane of LANES) {
  const rows = records.filter((r) => (r.lane ?? "fresh") === lane);
  if (!rows.length) continue;

  const entries = rows.filter((r) => r.type === "entry");
  const exits = rows.filter((r) => r.type === "exit");
  const wins = exits.filter((r) => r.pnlSol > 0).length;
  const total = exits.reduce((sum, r) => sum + (Number(r.pnlSol) || 0), 0);
  const held = exits.reduce((sum, r) => sum + (Number(r.heldSeconds) || 0), 0);
  const rejects = rows.filter((r) => r.type === "reject");

  console.log(`== ${lane.toUpperCase()} ==`);
  console.log(`entries ${entries.length} | closed ${exits.length} | win rate ${pct(wins, exits.length)} | total ${sol(total)} SOL | avg ${exits.length ? sol(total / exits.length) : "-"} SOL | avg hold ${exits.length ? Math.round(held / exits.length) : "-"}s`);

  const byReason = {};
  for (const r of exits) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  if (exits.length) console.log(`exits by reason: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // Does the analyst score separate winners from losers? (pairs each exit with the entry before it)
  const lastEntry = new Map();
  const buckets = {};
  for (const r of rows) {
    if (r.type === "entry") lastEntry.set(r.mint, r);
    if (r.type === "exit" && lastEntry.has(r.mint)) {
      const score = lastEntry.get(r.mint).score;
      lastEntry.delete(r.mint);
      if (!Number.isFinite(score)) continue;
      const key = (Math.floor(score * 10) / 10).toFixed(1);
      buckets[key] ??= { n: 0, wins: 0, pnl: 0 };
      buckets[key].n += 1;
      buckets[key].wins += r.pnlSol > 0 ? 1 : 0;
      buckets[key].pnl += Number(r.pnlSol) || 0;
    }
  }
  const keys = Object.keys(buckets).sort();
  if (keys.length) {
    console.log("score at entry -> trades / win rate / pnl:");
    for (const key of keys) console.log(`  ${key}+  ${pad(buckets[key].n, 4)} ${pad(pct(buckets[key].wins, buckets[key].n), 5)} ${sol(buckets[key].pnl)}`);
  }

  const cats = {};
  for (const r of rejects) cats[r.category] = (cats[r.category] ?? 0) + 1;
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) {
    console.log(`why tokens dropped out (${rejects.length} total):`);
    for (const [category, count] of top) console.log(`  ${pad(count, 6)} ${category}`);
  }
  console.log("");
}

for (const file of ["paper-state.json", "lanes-state.json"]) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) continue;
  try {
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    if (file === "paper-state.json") console.log(`fresh balance: ${Number(data.balanceSol).toFixed(5)} SOL`);
    else for (const [id, account] of Object.entries(data.lanes ?? {})) console.log(`${id} balance: ${Number(account.balanceSol).toFixed(5)} SOL (started at ${account.startBalanceSol})`);
  } catch { /* ignore */ }
}
