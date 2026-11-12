import "dotenv/config";
import express from "express";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.js";
import { envOverrides, publicSchema, shownValues } from "./src/settings.js";
import { freshState } from "./src/state.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(ROOT, "data", "paper-state.json");
const BOT_PATH = path.join(ROOT, "src", "index.js");
const PORT = Number(process.env.WEB_PORT ?? 3000);
const HOST = "127.0.0.1";
const app = express();

// What the dashboard may change lives in src/settings.js, grouped by the agent that reads it; the
// defaults and every range check stay in src/config.js. This file only holds the OVERRIDES the
// dashboard has saved this session, as env strings, and layers them over process.env.
//
// They are deliberately not written to disk: .env is the user's file, and a form quietly rewriting
// it is worse than a setting that resets when the dashboard restarts.
let settingOverrides = {};
let pendingRestart = false;

let worker = null;
let workerStatus = "stopped";
let feedConnected = false;
let activeDataSource = "pumpportal";
let feedSource = null;
let sessionApiKey = "";
const recentLogs = [];

const envWith = (overrides = settingOverrides, apiKey = sessionApiKey || configuredApiKey()) => ({
  ...process.env,
  ...overrides,
  MODE: "paper",
  BOT_FEED_MODE: activeDataSource,
  PUMPPORTAL_API_KEY: apiKey,
});

// The config the desk is running on, or would run on if it were started now. Rebuilt whenever the
// overrides change, so /api/state can describe the desk without asking the worker.
let activeConfig = loadConfig(envWith({}, ""));

// What the three bots report. Empty until the worker publishes its first status.
const emptyStatus = () => ({ bots: null, updatedAt: null });
let screenerStatus = emptyStatus();
const screenerDebug = [];

function configuredApiKey() {
  const key = (process.env.PUMPPORTAL_API_KEY ?? "").trim();
  return key && key !== "replace_me" ? key : "";
}

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.use((req, res, next) => {
  const allowedHosts = new Set(["127.0.0.1", "localhost"]);
  if (!allowedHosts.has(req.hostname)) return res.status(403).json({ error: "The dashboard accepts local connections only." });

  const origin = req.get("origin");
  if (origin) {
    try {
      if (!allowedHosts.has(new URL(origin).hostname)) {
        return res.status(403).json({ error: "That request origin is not allowed." });
      }
    } catch {
      return res.status(403).json({ error: "That request origin is not valid." });
    }
  }
  next();
});

app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

function addLog(message, timestamp = new Date().toISOString()) {
  let safeMessage = String(message);
  for (const secret of [sessionApiKey, configuredApiKey()].filter(Boolean)) {
    safeMessage = safeMessage.replaceAll(secret, "[API KEY REDACTED]");
  }
  recentLogs.unshift({ message: safeMessage.slice(0, 500), timestamp });
  if (recentLogs.length > 120) recentLogs.length = 120;
}

function addScreenerDebug(level, message, timestamp = new Date().toISOString()) {
  let safeMessage = String(message);
  for (const secret of [sessionApiKey, configuredApiKey()].filter(Boolean)) {
    safeMessage = safeMessage.replaceAll(secret, "[API KEY REDACTED]");
  }
  screenerDebug.unshift({ timestamp, level, message: safeMessage.slice(0, 500) });
  if (screenerDebug.length > 60) screenerDebug.length = 60;
  screenerStatus = { ...screenerStatus, updatedAt: timestamp };
}

// The paper account, cached for a beat.
//
// Every open dashboard polls /api/state, and this used to read and parse the whole file on each
// one. Two costs: the obvious one, and a sharper one on Windows — the worker saves by renaming a
// temp file over this path, and Windows refuses a rename while another process has the
// destination open. A read in flight at the wrong moment made the worker's save fail, which
// killed it. The worker only writes every 15 seconds, so holding the parse for one second is
// free, and it cuts the number of open handles by however many pollers there are.
const STATE_CACHE_MS = 1000;
let cachedPaperState = null;
let cachedPaperStateAt = 0;

function readPaperState() {
  const now = Date.now();
  if (cachedPaperState && now - cachedPaperStateAt < STATE_CACHE_MS) return cachedPaperState;

  try {
    cachedPaperState = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    cachedPaperStateAt = now;
  } catch {
    // A read that lands in the instant between the worker's write and its rename sees no file at
    // all. Showing the last good account is right; showing a fresh one would flash a full balance
    // and no positions onto the dashboard for a second, which reads as the desk having been reset.
    if (!cachedPaperState) {
      cachedPaperState = {
        balanceSol: activeConfig.paperStartBalanceSol,
        startBalanceSol: activeConfig.paperStartBalanceSol,
        positions: {},
        closedTrades: [],
        daily: { day: new Date().toISOString().slice(0, 10), entries: 0, realizedPnlSol: 0 },
      };
    }
  }
  return cachedPaperState;
}

// The account changed underneath the cache (a reset writes the file directly).
function invalidatePaperState() {
  cachedPaperStateAt = 0;
}

// Fill realism, from the SAME config the worker is running on, so an open position is valued here
// exactly as the worker would value it.
function positionSnapshot(position) {
  const fee = activeConfig.paperFeeBps / 10_000;
  const slippage = activeConfig.paperSlippageBps / 10_000;
  const estimate = position.tokenQuantity * position.lastPrice * (1 - slippage) * (1 - fee);
  return {
    mint: position.mint,
    name: position.name ?? "",
    symbol: position.symbol ?? "",
    dataSource: position.dataSource ?? (String(position.mint ?? "").startsWith("DEMO-") ? "demo" : "pumpportal"),
    openedAt: position.openedAt,
    entryPrice: position.entryPrice,
    lastPrice: position.lastPrice,
    entryMarketCapUsd: position.entryMarketCapUsd ?? null,
    currentMarketCapUsd: position.lastMarketCapUsd ?? null,
    costSol: position.costSol,
    estimatedPnlSol: estimate - position.costSol,
  };
}

function sendState(res) {
  const paper = readPaperState();
  const positions = Object.values(paper.positions ?? {}).map(positionSnapshot);
  res.json({
    runtime: {
      status: workerStatus,
      feedConnected,
      dataSource: activeDataSource,
      feedSource,
      mode: "paper",
      screenerDiagnosticsVersion: 2,
      hasApiKey: Boolean(sessionApiKey || configuredApiKey()),
    },
    // The handful the dashboard reads directly for the rail and the tiles. Everything else it
    // needs about the configuration it gets from /api/settings.
    settings: {
      paperStartBalanceSol: activeConfig.paperStartBalanceSol,
      positionPct: activeConfig.positionPct,
      maxOpenPositions: activeConfig.maxOpenPositions,
      maxEntriesPerDay: activeConfig.maxEntriesPerDay,
      maxDailyLossSol: activeConfig.maxDailyLossSol,
    },
    account: {
      balanceSol: Number(paper.balanceSol ?? activeConfig.paperStartBalanceSol),
      startBalanceSol: Number(paper.startBalanceSol ?? activeConfig.paperStartBalanceSol),
      realizedPnlSol: Number(paper.daily?.realizedPnlSol ?? 0),
      entriesToday: Number(paper.daily?.entries ?? 0),
      openPositions: positions,
      closedTrades: Array.isArray(paper.closedTrades) ? paper.closedTrades.slice(-20).reverse() : [],
    },
    screener: screenerStatus,
    screenerDebug,
    logs: recentLogs,
  });
}

app.get("/api/state", (_req, res) => sendState(res));

app.get("/api/settings", (_req, res) => {
  res.json({
    schema: publicSchema(),
    values: shownValues(activeConfig),
    pendingRestart,
    running: Boolean(worker) && ["starting", "running"].includes(workerStatus),
  });
});

app.post("/api/start", (req, res) => {
  if (worker) return res.status(409).json({ error: "The desk is already running, or still stopping." });

  recentLogs.length = 0;
  screenerDebug.length = 0;
  screenerStatus = { ...emptyStatus(), phase: "starting" };
  addLog("[debug] Start requested from the dashboard.");
  addScreenerDebug("info", "Start requested; checking the settings and forking the paper worker.");
  try {
    const dataSource = "pumpportal";
    const submittedKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    const apiKey = submittedKey || configuredApiKey();
    const childEnv = envWith(settingOverrides, apiKey);
    activeConfig = loadConfig(childEnv);
    pendingRestart = false;

    activeDataSource = dataSource;
    feedSource = dataSource;
    sessionApiKey = apiKey;
    feedConnected = false;
    workerStatus = "starting";
    addLog("Starting the paper desk…");
    worker = fork(BOT_PATH, [], {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const child = worker;
    let stderrBuffer = "";

    child.on("spawn", () => {
      addLog(`[debug] Worker running (pid ${child.pid ?? "unknown"}).`);
      addScreenerDebug("info", `Worker up (pid ${child.pid ?? "unknown"}); waiting for the data sources.`);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          addLog(`[worker stderr] ${line.trim()}`);
          addScreenerDebug("error", `Worker stderr: ${line.trim()}`);
        }
      }
    });

    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "log") {
        addLog(message.message, message.timestamp);
        const text = String(message.message ?? "");
        if (/^\[feed\]|\[demo error\]|\[settings error\]|\b(error|exception|gagal)\b/i.test(text)) {
          const level = /error|exception|gagal|failed|server response|unauthorized|\b40[13]\b|timed out|ECONN|ENOTFOUND|EAI_AGAIN|refused|reset/i.test(text)
            ? "error"
            : /disconnected|reconnecting/i.test(text) ? "warning" : "info";
          addScreenerDebug(level, text, message.timestamp);
        }
      }
      if (message.type === "feed") {
        feedConnected = Boolean(message.connected);
        feedSource = message.source ?? activeDataSource;
        if (feedConnected) {
          addScreenerDebug("info", "PumpPortal feed connected; new launches and migrations are streaming in.");
        } else {
          addScreenerDebug("warning", "Feed disconnected; the worker will reconnect.");
        }
      }
      if (message.type === "status") {
        workerStatus = message.status;
        if (message.status === "running") addScreenerDebug("info", "Worker ready; the desk is screening.");
      }
      if (message.type === "screener-status" && message.status && typeof message.status === "object") {
        screenerStatus = message.status;
      }
      if (message.type === "screener-debug" && message.entry && typeof message.entry === "object") {
        screenerDebug.unshift(message.entry);
        if (screenerDebug.length > 60) screenerDebug.length = 60;
      }
    });
    child.on("error", (error) => {
      addLog(`[worker error] ${error.message}`);
      workerStatus = "error";
      addScreenerDebug("error", `Worker failed to start: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      if (stderrBuffer.trim()) {
        addLog(`[worker stderr] ${stderrBuffer.trim()}`);
        addScreenerDebug("error", `Worker stderr: ${stderrBuffer.trim()}`);
      }
      if (worker !== child) return;
      worker = null;
      feedConnected = false;
      workerStatus = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
      sessionApiKey = "";
      screenerStatus = { ...emptyStatus(), updatedAt: new Date().toISOString() };
      addLog(`[debug] Worker exit: code=${code ?? "null"}, signal=${signal ?? "none"}.`);
      if (workerStatus === "error") {
        addLog("The desk stopped on an error; see the worker stderr above.");
        addScreenerDebug("error", `Worker stopped on an error (code ${code ?? "null"}, signal ${signal ?? "none"}).`);
      } else {
        addLog("The desk was stopped.");
        addScreenerDebug("info", "The desk is stopped; nothing is being screened.");
      }
    });

    res.json({ ok: true, status: workerStatus });
  } catch (error) {
    workerStatus = "error";
    screenerStatus = { ...screenerStatus, phase: "error", updatedAt: new Date().toISOString() };
    addLog(`[start error] ${error.message}`);
    addScreenerDebug("error", `Start failed: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

// A patch of shown values from one agent's settings sheet. Saving is allowed whether or not the
// desk is running: with a worker up the change is sent straight through, without one it is held
// until the next Start.
app.post("/api/settings", (req, res) => {
  try {
    const patch = req.body?.settings;
    if (!patch || typeof patch !== "object") throw new Error("No settings were sent.");

    const overrides = { ...settingOverrides, ...envOverrides(patch) };
    // loadConfig owns every range and cross-field rule, so a bad value is refused here and the
    // overrides are left exactly as they were.
    const nextConfig = loadConfig(envWith(overrides));

    settingOverrides = overrides;
    activeConfig = nextConfig;
    const changed = Object.keys(patch).length;
    const running = Boolean(worker) && ["starting", "running"].includes(workerStatus);

    if (!running) {
      pendingRestart = true;
      addLog(`[settings] ${changed} setting(s) saved; they apply on the next Start.`);
      return res.json({ ok: true, changed, applied: false, pendingRestart, values: shownValues(activeConfig) });
    }

    worker.send({ type: "update-settings", settings: overrides }, (error) => {
      if (error) {
        addLog(`[settings error] Could not reach the desk: ${error.message}`);
        pendingRestart = true;
        return res.status(500).json({ error: "The desk did not receive the change; it will apply on the next Start." });
      }
      pendingRestart = false;
      addLog(`[settings] ${changed} setting(s) applied to the running desk.`);
      res.json({ ok: true, changed, applied: true, pendingRestart, values: shownValues(activeConfig) });
    });
  } catch (error) {
    addLog(`[settings error] ${error.message}`);
    addScreenerDebug("error", `Settings rejected: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

// Emergency exit. `mint` closes one coin; omitting it closes every open position. The worker sells
// at the last price it saw, with the usual simulated fee and slippage.
app.post("/api/close", (req, res) => {
  if (!worker || !["starting", "running"].includes(workerStatus)) {
    return res.status(409).json({ error: "The desk is not running." });
  }
  const mint = typeof req.body?.mint === "string" && req.body.mint ? req.body.mint : null;
  if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: "That is not a valid coin address." });
  }
  worker.send({ type: "close-position", mint }, (error) => {
    if (error) {
      addLog(`[close error] Could not send the close order: ${error.message}`);
      return res.status(500).json({ error: "The desk did not receive the close order." });
    }
    addLog(mint ? `Manual close sent for ${mint.slice(0, 8)}…` : "Manual close sent for EVERY open position.");
    res.json({ ok: true });
  });
});

app.post("/api/stop", (_req, res) => {
  if (!worker) return res.json({ ok: true, status: "stopped" });
  workerStatus = "stopping";
  addLog("Stopping the desk…");
  worker.kill("SIGTERM");
  res.json({ ok: true, status: workerStatus });
});

app.post("/api/reset-account", (req, res) => {
  if (worker) return res.status(409).json({ error: "Stop the desk before resetting the paper account." });
  const balance = Number(req.body?.balanceSol);
  if (!Number.isFinite(balance) || balance <= 0 || balance > 1_000_000) {
    return res.status(400).json({ error: "The starting balance must be greater than 0 SOL." });
  }
  const state = freshState(balance);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  invalidatePaperState();
  settingOverrides = { ...settingOverrides, PAPER_START_BALANCE_SOL: String(balance) };
  activeConfig = loadConfig(envWith());
  addLog(`Paper account reset to ${balance} SOL.`);
  res.json({ ok: true });
});

// Anything under /api that no route above handled. Without this Express answers with its HTML
// error page, and the dashboard's `response.json()` fails with "Unexpected token '<'", which says
// nothing about the real problem — usually a server still running an older build.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No API route ${req.method} /api${req.path}. If you just updated the code, restart the dashboard.` });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Paper trading dashboard: http://${HOST}:${PORT}`);
  addLog(`[web] Dashboard listening on http://${HOST}:${PORT}.`);
});

function shutdownServer() {
  worker?.kill("SIGTERM");
  httpServer.close();
}

process.on("SIGINT", shutdownServer);
process.on("SIGTERM", shutdownServer);
