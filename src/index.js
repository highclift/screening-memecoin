import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { createUniverse } from "./universe.js";
import { createJournal } from "./journal.js";
import { createDevBook } from "./devbook.js";
import { createFeed } from "./feed.js";
import { createScreener } from "./bots/screener.js";
import { createFilter } from "./bots/filter.js";
import { createExecutor } from "./bots/executor.js";
import { currentUtcDay, loadState, saveState } from "./state.js";

// Three bots in a chain, in one process so they share one API budget and one copy of the data:
//
//   bot 1 screens every coin at any age      ->  data/bot1-screened.jsonl
//   bot 2 judges everything bot 1 screened   ->  data/bot2-filtered.jsonl
//   bot 3 buys and sells what bot 2 greenlit ->  data/bot3-trades.jsonl
//
// The handoff is one function call per stage (onScreened -> consider -> watch -> onData), so each
// bot only ever sees the stage before it. Paper only: nothing here signs or sends a transaction.

let config = loadConfig();
const account = loadState(config.paperStartBalanceSol);
const universe = createUniverse({ maxTokens: config.maxUniverseTokens });
const devBook = createDevBook();

const journals = {
  screener: createJournal({ filePath: path.resolve("data", "bot1-screened.jsonl"), maxBytes: 20 * 1024 * 1024 }),
  filter: createJournal({ filePath: path.resolve("data", "bot2-filtered.jsonl"), maxBytes: 10 * 1024 * 1024 }),
  executor: createJournal({ filePath: path.resolve("data", "bot3-trades.jsonl") }),
};

let stopping = false;
let feedConnected = false;
let statusTimer;
let sweepTimer;
let saveTimer;
let devBookTimer;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${message}`);
  if (process.send) process.send({ type: "log", timestamp, message });
}

// The plain-language event stream the dashboard shows ("story"); levels: candidate / entry / exit /
// blocked / filtered / info / error.
function note(level, message, mint = "") {
  if (process.send) {
    process.send({ type: "screener-debug", entry: { timestamp: new Date().toISOString(), level, message, mint } });
  }
}

function persist() {
  saveState(account);
}

const feed = createFeed({
  config,
  log,
  onLaunch: (event) => screener.onLaunch(event),
  onMigration: (event) => screener.onMigration(event),
  onConnectionChange: (connected) => {
    feedConnected = connected;
    if (process.send) process.send({ type: "feed", connected, source: "pumpportal" });
  },
});

// Declared in reverse order of the chain so each bot can be handed the one after it.
const executor = createExecutor({
  config,
  universe,
  journal: journals.executor,
  account,
  persist,
  solUsd: () => feed.solUsd(),
  isGreen: (mint) => filter.isGreen(mint),
  // A position that collapsed while held: ban the coin for good and count it against its creator.
  onRug: (mint, detail) => {
    if (!devBook.recordRug(mint)) return;
    journals.filter.write({ type: "rug", mint, source: "held-position", ...detail });
    log(`[bot2] ${mint.slice(0, 8)} collapsed while held; banned from now on (${devBook.bannedCount()} banned).`);
  },
  log,
  note,
});

const filter = createFilter({
  config,
  universe,
  journal: journals.filter,
  devBook,
  log,
  note,
  onGreen: (record) => executor.watch(record),
  onDropped: (mint, why) => {
    if (!executor.holds(mint)) executor.unwatch(mint, why);
  },
});

const screener = createScreener({
  config,
  universe,
  feed,
  journal: journals.screener,
  devBook,
  log,
  note,
  onScreened: (record, meta) => {
    // bot 1 -> bot 2 -> bot 3, in that order: bot 3 must see this round's verdict, not the last one.
    filter.consider(record, meta);
    executor.onData(record, meta.now);
  },
});

// The fourth row on the dashboard: everything the three bots write down. One line per journal
// plus the paper account, so a disk that fills up or a write that fails is visible rather than
// silent.
function storageStatus() {
  const files = Object.entries(journals).map(([name, journal]) => ({ name, ...journal.stats() }));
  let accountBytes = 0;
  try {
    accountBytes = fs.statSync(path.resolve("data", "paper-state.json")).size;
  } catch {
    // no account file yet
  }
  return {
    lines: files.reduce((total, file) => total + file.lines, 0),
    bytes: files.reduce((total, file) => total + file.bytes, 0) + accountBytes,
    pending: files.reduce((total, file) => total + file.pending, 0),
    lastError: files.find((file) => file.lastError)?.lastError ?? "",
    files: files.map(({ name, lines, bytes }) => ({ name, lines, bytes })),
  };
}

function publishStatus() {
  if (!process.send) return;
  process.send({
    type: "screener-status",
    status: {
      bots: {
        screener: screener.status(),
        filter: filter.status(),
        executor: executor.status(),
        storage: storageStatus(),
      },
      holderCheck: Boolean(config.solanaRpcUrl),
      updatedAt: new Date().toISOString(),
    },
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(statusTimer);
  clearInterval(sweepTimer);
  clearInterval(saveTimer);
  clearInterval(devBookTimer);
  screener.stop();
  feed.stop();
  persist();
  devBook.save();
  for (const journal of Object.values(journals)) journal.stop();
  log("[shutdown] Paper account saved; all three bots stopped.");
  if (process.connected) process.disconnect();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// The dashboard can only change money limits now; there are no strategy settings left to send.
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;

  // The dashboard's emergency exit: close one coin, or everything.
  if (message.type === "close-position") {
    const closed = executor.closeNow(typeof message.mint === "string" ? message.mint : null, "manual");
    if (process.send) process.send({ type: "closed", closed, mint: message.mint ?? null });
    return;
  }

  if (message.type !== "update-settings" || !message.settings) return;
  try {
    config = loadConfig({ ...process.env, ...message.settings, MODE: "paper", PUMPPORTAL_API_KEY: config.apiKey });
    log("[settings] Batas uang diperbarui tanpa restart bot.");
    if (process.send) process.send({ type: "settings-applied" });
  } catch (error) {
    log(`[settings error] ${error.message}`);
    if (process.send) process.send({ type: "settings-error", error: error.message });
  }
});

if (account.daily?.day !== currentUtcDay()) {
  account.daily = { day: currentUtcDay(), entries: 0, realizedPnlSol: 0 };
}

log(`[start] mode=${config.mode} paper balance=${account.balanceSol.toFixed(5)} SOL, ${config.buyAmountSol} SOL per trade, max ${config.maxOpenPositions} open, max ${config.maxEntriesPerDay} entries/day, daily loss limit ${config.maxDailyLossSol} SOL.`);
log("[pipeline] bot 1 screens every coin (any age) -> bot 2 judges can-it-pump -> bot 3 times entry and exit. No strategy settings: bot 3 measures each coin and sets its own stops.");
log(`[pipeline] bot 2 turns a coin green at score ${config.greenScore}; holder check ${config.solanaRpcUrl ? "ON" : "OFF (set SOLANA_RPC_URL)"}; dev history max ${config.maxDevRugs} rug / ${config.maxDevLaunches} launches.`);

for (const journal of Object.values(journals)) journal.start();
devBookTimer = setInterval(() => devBook.save(), 60_000);
feed.start();
screener.start();
sweepTimer = setInterval(() => {
  executor.sweep();
  screener.prioritize(executor.priorityMints());
}, 2000);
saveTimer = setInterval(persist, 15_000);
statusTimer = setInterval(publishStatus, 1000);
if (process.send) process.send({ type: "status", status: "running" });
