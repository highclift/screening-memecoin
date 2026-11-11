import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createUniverse } from "./universe.js";
import { createJournal } from "./journal.js";
import { createDevBook } from "./devbook.js";
import { createFeed } from "./feed.js";
import { createRugcheck } from "./rugcheck.js";
import { createSmartWallets } from "./smartwallets.js";
import { createLogger } from "./agents/logger.js";
import { createScout } from "./agents/scout.js";
import { createFilter } from "./agents/filter.js";
import { createAnalyst } from "./agents/analyst.js";
import { createRisk } from "./agents/risk.js";
import { createExecutor } from "./agents/executor.js";
import { currentUtcDay, loadState, saveState } from "./state.js";

// SIX AGENTS, ONE PROCESS, HARD HANDOFFS.
//
//   scout     finds coins and keeps only what is inside the age / market-cap window
//     -> filter    kills anything unsafe: authorities, LP, liquidity, dev bag, bundled wallets
//       -> analyst scores what is left out of 100; only PASS_SCORE and above goes on
//         -> executor times the entry and is the only agent that touches a position
//           <-> risk decides the size, whether a trade is allowed, and when it ends
//   logger    every stage reports here, and every kill is written down with its reason
//
// Each handoff is one function call, so an agent only ever sees the stage before it. A coin cannot
// skip a stage, and a coin that fails one is never seen by the next.
//
// They share one process so they share one API budget and one copy of the data. Paper only:
// nothing here signs or sends a transaction.

let config = loadConfig();
const account = loadState(config.paperStartBalanceSol);
const universe = createUniverse({ maxTokens: config.maxUniverseTokens });
const devBook = createDevBook();
const smartWallets = createSmartWallets();
const rugcheck = createRugcheck({ callsPerMinute: config.rugcheckCallsPerMinute });

const journals = {
  scout: createJournal({ filePath: path.resolve("data", "scout.jsonl"), maxBytes: 20 * 1024 * 1024 }),
  kills: createJournal({ filePath: path.resolve("data", "kills.jsonl"), maxBytes: 20 * 1024 * 1024 }),
  trades: createJournal({ filePath: path.resolve("data", "trades.jsonl") }),
};

let stopping = false;
let feedConnected = false;
let statusTimer;
let sweepTimer;
let saveTimer;
let bookTimer;

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

const logger = createLogger({ journals, maxTracked: config.maxUniverseTokens, log, note });

const feed = createFeed({
  config,
  log,
  onLaunch: (event) => scout.onLaunch(event),
  onMigration: (event) => scout.onMigration(event),
  onConnectionChange: (connected) => {
    feedConnected = connected;
    if (process.send) process.send({ type: "feed", connected, source: "pumpportal" });
  },
});

// Declared in reverse order of the chain, so each agent can be handed the one after it.
const risk = createRisk({ config, account, logger, persist });

const executor = createExecutor({
  config,
  universe,
  account,
  risk,
  logger,
  persist,
  solUsd: () => feed.solUsd(),
  isCandidate: (mint) => analyst.passes(mint),
  // A position that collapsed while held: ban the coin for good and count it against its creator.
  onRug: (mint, detail) => {
    if (!devBook.recordRug(mint)) return;
    journals.kills.write({ type: "rug", stage: "executor", mint, ...detail });
    log(`[filter] ${mint.slice(0, 8)} collapsed while held; banned from now on (${devBook.bannedCount()} banned).`);
  },
});

const analyst = createAnalyst({
  config,
  universe,
  feed,
  smartWallets,
  logger,
  onPassed: (record) => executor.watch(record),
  onDropped: (mint, why) => {
    if (!executor.holds(mint)) executor.unwatch(mint, why);
  },
});

const filter = createFilter({
  config,
  universe,
  devBook,
  rugcheck,
  logger,
  onPassed: (record, meta) => analyst.consider(record, meta),
  onKilled: (mint, why) => {
    analyst.withdraw(mint, why);
    if (!executor.holds(mint)) executor.unwatch(mint, why);
  },
});

const scout = createScout({
  config,
  universe,
  feed,
  logger,
  devBook,
  log,
  note,
  onScouted: (record, meta) => {
    // scout -> filter -> analyst -> executor, in that order: the executor must see this round's
    // verdict, not the last one.
    filter.consider(record, meta);
    executor.onData(record, meta.now);
  },
});

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
        scout: scout.status(),
        filter: filter.status(),
        analyst: analyst.status(),
        executor: executor.status(),
        risk: risk.status(),
        logger: { ...logger.status(), ...storageStatus() },
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
  clearInterval(bookTimer);
  scout.stop();
  feed.stop();
  persist();
  devBook.save();
  smartWallets.save();
  for (const journal of Object.values(journals)) journal.stop();
  log("[shutdown] Paper account saved; all six agents stopped.");
  if (process.connected) process.disconnect();
}

// Importing this file must never start a desk.
//
// Everything above only builds objects; nothing connects, writes or ticks until start() runs, and
// start() runs only when this file was launched as a program (`npm run bot`, or the fork from
// server.js). A plain `import()` of it — from a test, a tooling script, an editor's auto-import —
// used to launch a full second desk against the same data/ directory as the one already running.
// Two desks stamping the same paper account over each other is almost impossible to recognise from
// the dashboard: the numbers simply flip between two different accounts every few seconds.
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function start() {
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("message", onParentMessage);

  if (account.daily?.day !== currentUtcDay()) {
    account.daily = { day: currentUtcDay(), entries: 0, realizedPnlSol: 0 };
  }

  const w = config.window;
  log(`[start] mode=${config.mode} paper balance=${account.balanceSol.toFixed(5)} SOL, ${Math.round(config.positionPct * 100)}% per trade (${risk.sizeSol().toFixed(5)} SOL now), max ${config.maxOpenPositions} open, max ${config.maxEntriesPerDay} entries/day, daily loss limit ${config.maxDailyLossSol} SOL.`);
  log("[desk] scout -> filter -> analyst -> executor <-> risk, and every kill goes to the logger.");
  log(`[desk] window ${Math.round(w.minAgeSeconds / 60)}m-${Math.round(w.maxAgeSeconds / 3600)}h old, $${Math.round(w.minMarketCapUsd / 1000)}k-$${Math.round(w.maxMarketCapUsd / 1_000_000)}M | pass mark ${config.passScore}/100 | stop -${Math.round(config.stopPct * 100)}%, trail ${Math.round(config.trailPct * 100)}% once +${Math.round(config.trailAfterPct * 100)}%.`);
  log(`[desk] safety: LP >= ${config.minLpLockedPct}% burned/locked, dev <= ${config.maxDevPct}%, bundled <= ${config.maxBundledPct}%, liquidity >= $${Math.round(config.gates.minLiquidityUsd / 1000)}k; holder graph ${config.solanaRpcUrl ? "ON" : "OFF (set SOLANA_RPC_URL)"}.`);

  for (const journal of Object.values(journals)) journal.start();
  bookTimer = setInterval(() => {
    devBook.save();
    smartWallets.save();
  }, 60_000);
  feed.start();
  scout.start();
  sweepTimer = setInterval(() => {
    executor.sweep();
    scout.prioritize(executor.priorityMints());
  }, 2000);
  saveTimer = setInterval(persist, 15_000);
  statusTimer = setInterval(publishStatus, 1000);
  if (process.send) process.send({ type: "status", status: "running" });
}

function onParentMessage(message) {
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
}

if (isMain) start();
