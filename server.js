import "dotenv/config";
import express from "express";
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(ROOT, "data", "paper-state.json");
const BOT_PATH = path.join(ROOT, "src", "index.js");
const PORT = Number(process.env.WEB_PORT ?? 3000);
const HOST = "127.0.0.1";
const app = express();

const DEFAULT_SETTINGS = {
  paperStartBalanceSol: 1,
  buyAmountSol: 0.01,
  maxOpenPositions: 3,
  maxEntriesPerDay: 20,
  maxActiveCandidates: 500,
  minMarketCapSol: 0,
  maxMarketCapSol: 150,
  minTrades: 8,
  minBuys: 5,
  minUniqueBuyers: 4,
  maxCandidateAgeSeconds: 180,
  pullbackPct: 0.18,
  bouncePct: 0.06,
  takeProfitPct: 0.30,
  stopLossPct: 0.20,
  maxHoldSeconds: 300,
  paperFeeBps: 100,
  paperSlippageBps: 200,
  maxDailyLossSol: 0.05,
};

const SETTINGS_TO_ENV = {
  paperStartBalanceSol: "PAPER_START_BALANCE_SOL",
  buyAmountSol: "BUY_AMOUNT_SOL",
  maxOpenPositions: "MAX_OPEN_POSITIONS",
  maxEntriesPerDay: "MAX_ENTRIES_PER_DAY",
  maxActiveCandidates: "MAX_ACTIVE_CANDIDATES",
  minMarketCapSol: "MIN_MARKET_CAP_SOL",
  maxMarketCapSol: "MAX_MARKET_CAP_SOL",
  minTrades: "MIN_TRADES",
  minBuys: "MIN_BUYS",
  minUniqueBuyers: "MIN_UNIQUE_BUYERS",
  maxCandidateAgeSeconds: "MAX_CANDIDATE_AGE_SECONDS",
  pullbackPct: "PULLBACK_PCT",
  bouncePct: "BOUNCE_PCT",
  takeProfitPct: "TAKE_PROFIT_PCT",
  stopLossPct: "STOP_LOSS_PCT",
  maxHoldSeconds: "MAX_HOLD_SECONDS",
  paperFeeBps: "PAPER_FEE_BPS",
  paperSlippageBps: "PAPER_SLIPPAGE_BPS",
  maxDailyLossSol: "MAX_DAILY_LOSS_SOL",
};

let worker = null;
let workerStatus = "stopped";
let feedConnected = false;
let sessionApiKey = "";
let activeSettings = { ...DEFAULT_SETTINGS };
const recentLogs = [];

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
  const fee = activeSettings.paperFeeBps / 10_000;
  const slippage = activeSettings.paperSlippageBps / 10_000;
  const estimate = position.tokenQuantity * position.lastPrice * (1 - slippage) * (1 - fee);
  return {
    mint: position.mint,
    name: position.name ?? "",
    symbol: position.symbol ?? "",
    openedAt: position.openedAt,
    entryPrice: position.entryPrice,
    lastPrice: position.lastPrice,
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
      mode: "paper",
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
    logs: recentLogs,
  });
}

function parseSettings(input = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const [name, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const value = input[name] ?? fallback;
    if (typeof value === "number" || typeof value === "string") {
      settings[name] = Number(value);
    } else {
      throw new Error(`${name} doit être numérique.`);
    }
    if (!Number.isFinite(settings[name])) throw new Error(`${name} doit être un nombre valide.`);
  }
  return settings;
}

function envForSettings(settings, apiKey) {
  const env = { ...process.env, MODE: "paper", PUMPPORTAL_API_KEY: apiKey };
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
  addLog("[debug] Permintaan start diterima dashboard.");
  try {
    const settings = parseSettings(req.body?.settings);
    const submittedKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    const apiKey = submittedKey || configuredApiKey();
    const childEnv = envForSettings(settings, apiKey);
    loadConfig(childEnv);

    activeSettings = settings;
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

    child.on("spawn", () => addLog(`[debug] Bot worker berjalan (pid ${child.pid ?? "unknown"}).`));
    child.stderr?.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) addLog(`[worker stderr] ${line.trim()}`);
      }
    });

    child.on("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "log") addLog(message.message, message.timestamp);
      if (message.type === "feed") feedConnected = Boolean(message.connected);
      if (message.type === "status") workerStatus = message.status;
    });
    child.on("error", () => {
      addLog("Bot worker gagal dijalankan. Periksa instalasi dependency dan log terminal.");
      workerStatus = "error";
    });
    child.on("exit", (code, signal) => {
      if (stderrBuffer.trim()) addLog(`[worker stderr] ${stderrBuffer.trim()}`);
      if (worker !== child) return;
      worker = null;
      feedConnected = false;
      workerStatus = code === 0 || signal === "SIGTERM" ? "stopped" : "error";
      sessionApiKey = "";
      addLog(`[debug] Worker exit: code=${code ?? "null"}, signal=${signal ?? "none"}.`);
      if (workerStatus === "error") addLog("Bot berhenti karena error; periksa pesan worker stderr di atas.");
      else addLog("Bot dihentikan.");
    });

    res.json({ ok: true, status: workerStatus });
  } catch (error) {
    addLog(`[start error] ${error.message}`);
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/settings", (req, res) => {
  if (!worker || !["starting", "running"].includes(workerStatus)) {
    return res.status(409).json({ error: "Jalankan paper scanner sebelum mengubah strategi live." });
  }

  try {
    const settings = parseSettings(req.body?.settings);
    loadConfig(envForSettings(settings, sessionApiKey || configuredApiKey()));
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
    res.status(400).json({ error: error.message });
  }
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
  const state = {
    balanceSol: balance,
    positions: {},
    seenMints: [],
    closedTrades: [],
    daily: { day: new Date().toISOString().slice(0, 10), entries: 0, realizedPnlSol: 0 },
  };
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  activeSettings.paperStartBalanceSol = balance;
  addLog(`Paper account direset ke ${balance} SOL.`);
  res.json({ ok: true });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`Paper trading dashboard: http://${HOST}:${PORT}`);
  console.log("Server hanya menerima koneksi dari komputer ini.");
  addLog(`[web] Dashboard aktif di http://${HOST}:${PORT}.`);
});

function shutdownServer() {
  worker?.kill("SIGTERM");
  httpServer.close();
}

process.on("SIGINT", shutdownServer);
process.on("SIGTERM", shutdownServer);
