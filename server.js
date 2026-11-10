import "dotenv/config";
import express from "express";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.js";
import { freshState } from "./src/state.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(ROOT, "data", "paper-state.json");
const BOT_PATH = path.join(ROOT, "src", "index.js");
const PORT = Number(process.env.WEB_PORT ?? 3000);
const HOST = "127.0.0.1";
const app = express();

// Money limits are the only settings left: bot 2 and bot 3 decide the rest from the coins
// themselves (see src/signals.js), so there is nothing else for the dashboard to ask for.
const DEFAULT_SETTINGS = {
  paperStartBalanceSol: 1,
  buyAmountSol: 0.01,
  maxOpenPositions: 3,
  maxEntriesPerDay: 20,
  maxDailyLossSol: 0.05,
};

const SETTINGS_TO_ENV = {
  paperStartBalanceSol: "PAPER_START_BALANCE_SOL",
  buyAmountSol: "BUY_AMOUNT_SOL",
  maxOpenPositions: "MAX_OPEN_POSITIONS",
  maxEntriesPerDay: "MAX_ENTRIES_PER_DAY",
  maxDailyLossSol: "MAX_DAILY_LOSS_SOL",
};

// Fill realism, env-only (PAPER_FEE_BPS / PAPER_SLIPPAGE_BPS): the same numbers the worker uses to
// value an open position.
const FEE_BPS = Number(process.env.PAPER_FEE_BPS ?? 100);
const SLIPPAGE_BPS = Number(process.env.PAPER_SLIPPAGE_BPS ?? 200);

let worker = null;
let workerStatus = "stopped";
let feedConnected = false;
let activeDataSource = "pumpportal";
let feedSource = null;
let sessionApiKey = "";
let activeSettings = { ...DEFAULT_SETTINGS };
const recentLogs = [];

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
  if (!allowedHosts.has(req.hostname)) return res.status(403).json({ error: "Dashboard hanya menerima koneksi lokal." });

  const origin = req.get("origin");
  if (origin) {
    try {
      if (!allowedHosts.has(new URL(origin).hostname)) {
        return res.status(403).json({ error: "Origin request tidak diizinkan." });
      }
    } catch {
      return res.status(403).json({ error: "Origin request tidak valid." });
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

function readPaperState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {
      balanceSol: activeSettings.paperStartBalanceSol,
      positions: {},
      closedTrades: [],
      daily: { day: new Date().toISOString().slice(0, 10), entries: 0, realizedPnlSol: 0 },
    };
  }
}

function positionSnapshot(position) {
  const fee = FEE_BPS / 10_000;
  const slippage = SLIPPAGE_BPS / 10_000;
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
    settings: activeSettings,
    account: {
      balanceSol: Number(paper.balanceSol ?? activeSettings.paperStartBalanceSol),
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

function parseSettings(input = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const [name, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = input[name] ?? fallback;
    if (typeof value !== "number" && typeof value !== "string") throw new Error(`${name} must be a number.`);
    settings[name] = Number(value);
    if (!Number.isFinite(settings[name])) throw new Error(`${name} must be a valid number.`);
  }
  return settings;
}

function envForSettings(settings, apiKey, dataSource = activeDataSource) {
  const env = { ...process.env, MODE: "paper", BOT_FEED_MODE: dataSource, PUMPPORTAL_API_KEY: apiKey };
  for (const [name, envName] of Object.entries(SETTINGS_TO_ENV)) env[envName] = String(settings[name]);
  return env;
}

function settingsForWorker(settings) {
  return Object.fromEntries(
    Object.entries(SETTINGS_TO_ENV).map(([name, envName]) => [envName, String(settings[name])]),
  );
}

app.get("/api/state", (_req, res) => sendState(res));

app.post("/api/start", (req, res) => {
  if (worker) return res.status(409).json({ error: "Bot sudah berjalan atau sedang berhenti." });

  recentLogs.length = 0;
  screenerDebug.length = 0;
  screenerStatus = { ...emptyStatus(), phase: "starting" };
  addLog("[debug] Permintaan start diterima dashboard.");
  addScreenerDebug("info", "Permintaan start diterima; memvalidasi strategi dan membuat worker paper.");
  try {
    const settings = parseSettings(req.body?.settings);
    const dataSource = "pumpportal";
    const submittedKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    const apiKey = submittedKey || configuredApiKey();
    const childEnv = envForSettings(settings, apiKey, dataSource);
    loadConfig(childEnv);

    activeSettings = settings;
    activeDataSource = dataSource;
    feedSource = dataSource;
    sessionApiKey = apiKey;
    feedConnected = false;
    workerStatus = "starting";
    addLog("Memulai scanner paper trading…");
    worker = fork(BOT_PATH, [], {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const child = worker;
    let stderrBuffer = "";

    child.on("spawn", () => {
      addLog(`[debug] Bot worker berjalan (pid ${child.pid ?? "unknown"}).`);
      addScreenerDebug("info", `Worker aktif (pid ${child.pid ?? "unknown"}); menunggu inisialisasi sumber data.`);
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
          addScreenerDebug("info", "Feed PumpPortal terhubung; menunggu launch baru untuk di-screen.");
        } else {
          addScreenerDebug("warning", "Feed terputus; worker akan mencoba menghubungkan ulang.");
        }
      }
      if (message.type === "status") {
        workerStatus = message.status;
        if (message.status === "running") addScreenerDebug("info", "Worker siap; screener berjalan.");
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
      addScreenerDebug("error", `Worker gagal dijalankan: ${error.message}`);
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
        addLog("Bot berhenti karena error; periksa pesan worker stderr di atas.");
        addScreenerDebug("error", `Worker berhenti karena error (code ${code ?? "null"}, signal ${signal ?? "none"}).`);
      } else {
        addLog("Bot dihentikan.");
        addScreenerDebug("info", "Scanner dihentikan; tidak ada token yang sedang di-screen.");
      }
    });

    res.json({ ok: true, status: workerStatus });
  } catch (error) {
    workerStatus = "error";
    screenerStatus = { ...screenerStatus, phase: "error", updatedAt: new Date().toISOString() };
    addLog(`[start error] ${error.message}`);
    addScreenerDebug("error", `Start gagal: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/settings", (req, res) => {
  if (!worker || !["starting", "running"].includes(workerStatus)) {
    return res.status(409).json({ error: "Jalankan paper scanner sebelum mengubah strategi live." });
  }

  try {
    const settings = parseSettings(req.body?.settings);
    loadConfig(envForSettings(settings, sessionApiKey || configuredApiKey(), activeDataSource));
    const child = worker;
    child.send({ type: "update-settings", settings: settingsForWorker(settings) }, (error) => {
      if (error) {
        addLog(`[settings error] Gagal mengirim konfigurasi ke bot: ${error.message}`);
        return res.status(500).json({ error: "Konfigurasi tidak terkirim ke bot." });
      }
      activeSettings = settings;
      addLog("[debug] Perubahan strategi dikirim ke bot aktif.");
      res.json({ ok: true });
    });
  } catch (error) {
    addLog(`[settings error] ${error.message}`);
    addScreenerDebug("error", `Update strategi gagal: ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

// Emergency exit. `mint` closes one coin; omitting it closes every open position. The worker sells
// at the last price it saw, with the usual simulated fee and slippage.
app.post("/api/close", (req, res) => {
  if (!worker || !["starting", "running"].includes(workerStatus)) {
    return res.status(409).json({ error: "Bot tidak sedang berjalan." });
  }
  const mint = typeof req.body?.mint === "string" && req.body.mint ? req.body.mint : null;
  if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return res.status(400).json({ error: "Alamat koin tidak valid." });
  }
  worker.send({ type: "close-position", mint }, (error) => {
    if (error) {
      addLog(`[close error] Gagal mengirim perintah tutup: ${error.message}`);
      return res.status(500).json({ error: "Perintah tidak terkirim ke bot." });
    }
    addLog(mint ? `Perintah tutup manual dikirim untuk ${mint.slice(0, 8)}…` : "Perintah tutup SEMUA posisi dikirim.");
    res.json({ ok: true });
  });
});

app.post("/api/stop", (_req, res) => {
  if (!worker) return res.json({ ok: true, status: "stopped" });
  workerStatus = "stopping";
  addLog("Menghentikan scanner…");
  worker.kill("SIGTERM");
  res.json({ ok: true, status: workerStatus });
});

app.post("/api/reset-account", (req, res) => {
  if (worker) return res.status(409).json({ error: "Hentikan bot sebelum reset paper account." });
  const balance = Number(req.body?.balanceSol);
  if (!Number.isFinite(balance) || balance <= 0 || balance > 1_000_000) {
    return res.status(400).json({ error: "Saldo awal harus lebih besar dari 0 SOL." });
  }
  const state = freshState(balance);
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  activeSettings.paperStartBalanceSol = balance;
  addLog(`Paper account direset ke ${balance} SOL.`);
  res.json({ ok: true });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Paper trading dashboard: http://${HOST}:${PORT}`);
  addLog(`[web] Dashboard aktif di http://${HOST}:${PORT}.`);
});

function shutdownServer() {
  worker?.kill("SIGTERM");
  httpServer.close();
}

process.on("SIGINT", shutdownServer);
process.on("SIGTERM", shutdownServer);
