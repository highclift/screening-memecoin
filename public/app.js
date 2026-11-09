const $ = (selector) => document.querySelector(selector);
const strategyForm = $("#strategyForm");
const messageBox = $("#formMessage");
const percentageFields = new Set(["pullbackPct", "bouncePct", "takeProfitPct", "stopLossPct"]);
let settingsSnapshot = "";
let refreshing = false;
let currentRuntimeStatus = "stopped";
let clientDiagnostics = [];
let lastRuntimeSnapshot = {};
let lastServerLogs = [];
let lastScreenerSnapshot = {};

function fmtSol(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)} SOL` : "—";
}

function fmtPrice(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(n < 1 ? 6 : 3) : "—";
}

function shortMint(value) {
  if (!value || value.length < 14) return value || "—";
  return `${value.slice(0, 6)}…${value.slice(-5)}`;
}

function localTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "--:--:--" : date.toLocaleTimeString("id-ID", { hour12: false });
}

function signClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function isSyntheticToken(item) {
  return item?.dataSource === "demo" || String(item?.mint ?? "").startsWith("DEMO-");
}

function tokenReference(label, item, className) {
  const element = document.createElement(isSyntheticToken(item) ? "span" : "a");
  element.className = className;
  element.textContent = label;
  if (!isSyntheticToken(item)) {
    element.href = `https://trenchly.gg/trade/${encodeURIComponent(item.mint)}`;
    element.target = "_blank";
    element.rel = "noreferrer";
    element.title = `Buka chart token ${item.mint} di Trenchly`;
  }
  return element;
}

function showMessage(message, isError = false) {
  messageBox.textContent = message;
  messageBox.classList.toggle("error", isError);
}

function addClientDiagnostic(level, message) {
  const entry = { timestamp: new Date().toISOString(), level, message: String(message).slice(0, 500) };
  if (clientDiagnostics[0]?.message === entry.message && clientDiagnostics[0]?.level === entry.level) return;
  clientDiagnostics.unshift(entry);
  if (clientDiagnostics.length > 20) clientDiagnostics.length = 20;
  renderStartupDiagnostics(lastRuntimeSnapshot, lastServerLogs, lastScreenerSnapshot);
}

window.addEventListener("error", (event) => {
  addClientDiagnostic("error", `Kesalahan JavaScript dashboard: ${event.message || "tidak diketahui"}`);
});
window.addEventListener("unhandledrejection", (event) => {
  addClientDiagnostic("error", `Permintaan dashboard gagal: ${event.reason?.message ?? String(event.reason)}`);
});

strategyForm.addEventListener("invalid", (event) => {
  const input = event.target;
  const field = input?.name || input?.id || "input";
  addClientDiagnostic("error", `Validasi ${field} gagal: ${input?.validationMessage || "nilai tidak valid"}`);
}, true);

function applySettings(settings) {
  for (const [name, rawValue] of Object.entries(settings ?? {})) {
    const input = strategyForm.elements.namedItem(name);
    if (!input || document.activeElement === input) continue;
    const value = percentageFields.has(name) ? Number(rawValue) * 100 : rawValue;
    input.value = String(value);
  }
}

function collectSettings() {
  const settings = {};
  for (const [name, rawValue] of new FormData(strategyForm).entries()) {
    if (name === "dataSource") continue;
    let value = Number(rawValue);
    if (percentageFields.has(name)) value /= 100;
    settings[name] = value;
  }
  return settings;
}

function setRuntime(runtime) {
  currentRuntimeStatus = runtime.status;
  const running = ["starting", "running", "stopping"].includes(runtime.status);
  $("#sourceEyebrow").textContent = "SOLANA · PUMP.FUN FEED";
  const status = $("#feedStatus");
  status.classList.toggle("connected", runtime.feedConnected);
  status.classList.toggle("pending", running && !runtime.feedConnected);
  status.lastElementChild.textContent = runtime.feedConnected
    ? "Feed terhubung"
    : running ? "Menghubungkan feed" : "Feed terputus";

  const title = {
    starting: "Memulai…",
    running: "Scanner aktif",
    stopping: "Menghentikan…",
    stopped: "Siap dijalankan",
    error: "Perlu diperiksa",
  }[runtime.status] ?? "Siap dijalankan";
  $("#runtimeStatus").textContent = title;
  $("#runtimeDetail").textContent = runtime.feedConnected
    ? "Menunggu migrasi token ke pool AMM melalui PumpPortal; saldo tetap paper."
    : running
      ? "Menunggu koneksi ke PumpPortal."
      : runtime.hasApiKey
        ? "API key tersedia; siapkan konfigurasi lalu mulai."
        : "Masukkan API key PumpPortal untuk mulai.";

  $("#startButton").classList.toggle("hidden", running);
  $("#startButton").disabled = running;
  $("#applySettingsButton").classList.toggle("hidden", runtime.status !== "running");
  $("#applySettingsButton").disabled = runtime.status !== "running";
  $("#stopButton").classList.toggle("hidden", !running);
  $("#apiKey").disabled = running;
  for (const input of document.querySelectorAll(".settings-input")) {
    if (input.id !== "apiKey") input.disabled = runtime.status === "stopping";
  }
  $("#resetButton").disabled = running;
}

function renderAccount(account, settings) {
  $("#balanceValue").textContent = fmtSol(account.balanceSol, 4);
  const pnl = Number(account.realizedPnlSol ?? 0);
  const pnlElement = $("#pnlValue");
  pnlElement.textContent = `${pnl > 0 ? "+" : ""}${pnl.toFixed(4)} SOL`;
  pnlElement.classList.remove("positive", "negative");
  if (pnl !== 0) pnlElement.classList.add(signClass(pnl));
  $("#pnlIcon").classList.toggle("negative", pnl < 0);
  $("#positionsValue").textContent = String(account.openPositions.length);
  $("#positionsLimit").textContent = String(settings.maxOpenPositions);
  $("#entriesValue").textContent = String(account.entriesToday);
  $("#entriesLimit").textContent = String(settings.maxEntriesPerDay);
  $("#openCount").textContent = String(account.openPositions.length);
  renderPositions(account.openPositions);
  renderClosedTrades(account.closedTrades);
}

function renderPositions(positions) {
  const container = $("#positionsList");
  container.replaceChildren();
  if (!positions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Belum ada posisi terbuka.";
    container.append(empty);
    return;
  }
  for (const position of positions) {
    const row = document.createElement("div");
    row.className = "position-row";
    const ident = document.createElement("div");
    ident.className = "token-ident";
    const avatar = document.createElement("div");
    avatar.className = "token-avatar";
    avatar.textContent = (position.symbol || position.name || "?").slice(0, 2).toUpperCase();
    const nameWrap = document.createElement("div");
    const tokenLabel = position.symbol || position.name || shortMint(position.mint);
    const nameRef = tokenReference(tokenLabel, position, "token-name token-link");
    const mint = document.createElement("div");
    mint.className = "token-sub";
    mint.textContent = isSyntheticToken(position) ? "DEMO SINTETIS" : shortMint(position.mint);
    const mintRef = isSyntheticToken(position)
      ? mint
      : tokenReference(shortMint(position.mint), position, "token-sub token-link");
    nameWrap.append(nameRef, mintRef);
    ident.append(avatar, nameWrap);

    const numbers = document.createElement("div");
    numbers.className = "position-numbers";
    const pnl = document.createElement("div");
    pnl.className = `position-pnl ${signClass(position.estimatedPnlSol)}`;
    const pnlValue = Number(position.estimatedPnlSol ?? 0);
    pnl.textContent = `${pnlValue >= 0 ? "+" : ""}${pnlValue.toFixed(4)} SOL`;
    const cost = document.createElement("div");
    cost.className = "position-cost";
    cost.textContent = `${fmtSol(position.costSol, 3)} · MC ${fmtPrice(position.lastPrice)}`;
    numbers.append(pnl, cost);
    row.append(ident, numbers);
    container.append(row);
  }
}

function renderClosedTrades(trades) {
  const body = $("#tradesBody");
  body.replaceChildren();
  if (!trades.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.className = "empty-cell";
    cell.textContent = "Belum ada trade yang ditutup.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const trade of trades) {
    const row = document.createElement("tr");
    const tokenCell = document.createElement("td");
    const token = document.createElement("span");
    token.className = "trade-token";
    token.textContent = trade.symbol || trade.name || shortMint(trade.mint);
    const tokenRef = tokenReference(token.textContent, trade, "trade-token token-link");
    const mint = document.createElement("span");
    mint.className = "trade-mint";
    mint.textContent = isSyntheticToken(trade) ? "DEMO SINTETIS" : shortMint(trade.mint);
    const mintRef = isSyntheticToken(trade)
      ? mint
      : tokenReference(shortMint(trade.mint), trade, "trade-mint token-link");
    tokenCell.append(tokenRef, mintRef);
    const reasonCell = document.createElement("td");
    reasonCell.className = "exit-reason";
    reasonCell.textContent = String(trade.reason ?? "exit").replaceAll("-", " ");
    const pnlCell = document.createElement("td");
    pnlCell.className = signClass(trade.pnlSol);
    const pnl = Number(trade.pnlSol ?? 0);
    pnlCell.textContent = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}`;
    row.append(tokenCell, reasonCell, pnlCell);
    body.append(row);
  }
}

function renderLogs(logs) {
  const container = $("#logList");
  container.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Aktivitas feed muncul di sini setelah scanner dimulai.";
    container.append(empty);
    return;
  }
  for (const item of logs) {
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = localTime(item.timestamp);
    const text = document.createElement("span");
    text.className = "log-message";
    text.textContent = item.message;
    if (item.message.includes("paper-buy")) text.classList.add("buy");
    else if (item.message.includes("exit:")) text.classList.add("exit");
    else if (item.message.includes("launch")) text.classList.add("launch");
    else if (item.message.includes("error") || item.message.includes("gagal")) text.classList.add("error");
    row.append(time, text);
    container.append(row);
  }
}

function renderStartupDiagnostics(runtime = {}, logs = [], screener = {}) {
  const title = $("#startupTitle");
  const badge = $("#startupBadge");
  const message = $("#startupMessage");
  const events = $("#startupEvents");
  if (!title || !badge || !message || !events) return;

  const serverErrors = (Array.isArray(logs) ? logs : []).filter((item) =>
    /\[start error\]|\[worker stderr\]|\[worker error\]|\[feed\].*(error|failed|unauthorized|\b40[13]\b|timed out|ECONN|ENOTFOUND|EAI_AGAIN|refused|reset|closed)|exception|gagal/i.test(String(item.message ?? "")),
  );
  const newestServerError = serverErrors[0]?.message;
  const newestClientError = clientDiagnostics.find((entry) => entry.level === "error")?.message;
  const staleNoTradeCandidates = (Array.isArray(screener.candidates) ? screener.candidates : [])
    .filter((candidate) => Number(candidate.ageSeconds ?? 0) >= 45 && Number(candidate.trades ?? 0) === 0).length;
  const tradeFeedMissing = runtime.status === "running"
    && runtime.feedConnected
    && Number(screener.scanned ?? 0) >= 10
    && Number(screener.entered ?? 0) === 0
    && staleNoTradeCandidates >= 5;
  let stateTitle = "Siap dimulai";
  let stateBadge = "SIAP";
  let stateMessage = "Masukkan API key PumpPortal lalu tekan Mulai paper scanner.";
  let stateLevel = "";

  if (runtime.status === "error") {
    stateTitle = "Start gagal";
    stateBadge = "ERROR";
    stateMessage = newestServerError || newestClientError || "Server melaporkan error, tetapi belum menerima detailnya.";
    stateLevel = "error";
  } else if (runtime.status === "starting") {
    stateTitle = "Worker sedang mulai";
    stateBadge = "MULAI";
    stateMessage = "Permintaan diterima; menunggu worker dan koneksi PumpPortal.";
  } else if (runtime.status === "stopping") {
    stateTitle = "Worker sedang berhenti";
    stateBadge = "STOP";
    stateMessage = "Menunggu proses scanner selesai.";
  } else if (tradeFeedMissing) {
    stateTitle = "Token bermigrasi, trade belum masuk";
    stateBadge = "CEK TRADE FEED";
    const subscriptionStats = screener.tradeSubscriptionsRequested === undefined
      ? ""
      : `Permintaan subscription: ${screener.tradeSubscriptionsRequested}; event trade diterima: ${screener.tradeMessagesReceived ?? 0}. `;
    stateMessage = `${subscriptionStats}Koneksi PumpPortal aktif, tetapi kandidat yang sudah bermigrasi masih 0 trade. Cek respons feed di log dan wallet tertaut API key: subscribeTokenTrade mensyaratkan minimal 0,02 SOL. Ini syarat data feed, bukan saldo posisi paper.`;
    stateLevel = "warning";
  } else if (runtime.status === "running" && runtime.feedConnected) {
    stateTitle = "Terhubung ke PumpPortal";
    stateBadge = "LIVE";
    stateMessage = "Feed live aktif; menunggu token Pump.fun bermigrasi ke pool AMM.";
  } else if (runtime.status === "running") {
    stateTitle = "Worker aktif, feed belum terhubung";
    stateBadge = "FEED";
    stateMessage = newestServerError || "Menunggu koneksi PumpPortal. Jika berlanjut, periksa API key, saldo wallet feed, dan log di bawah.";
    stateLevel = newestServerError ? "error" : "warning";
  } else if (newestClientError) {
    stateTitle = "Dashboard gagal menjalankan permintaan";
    stateBadge = "ERROR UI";
    stateMessage = newestClientError;
    stateLevel = "error";
  } else if (!runtime.hasApiKey) {
    stateTitle = "API key belum diterima server";
    stateBadge = "PERLU KEY";
    stateMessage = "Tempel API key PumpPortal di panel konfigurasi. Key tidak muncul di status sampai scanner mulai.";
    stateLevel = "warning";
  } else if (newestServerError) {
    stateTitle = "Percobaan terakhir gagal";
    stateBadge = "ERROR";
    stateMessage = newestServerError;
    stateLevel = "error";
  }

  title.textContent = stateTitle;
  badge.textContent = stateBadge;
  badge.classList.toggle("startup-error", stateLevel === "error");
  badge.classList.toggle("startup-warning", stateLevel === "warning");
  message.textContent = stateMessage;
  message.classList.toggle("error", stateLevel === "error");
  message.classList.toggle("warning", stateLevel === "warning");

  const combined = [
    ...clientDiagnostics,
    ...(Array.isArray(logs) ? logs.map((item) => ({
      timestamp: item.timestamp,
      level: /error|failed|gagal|unauthorized|\b40[13]\b|exception|ECONN|ENOTFOUND/i.test(String(item.message ?? ""))
        ? "error"
        : /disconnect|reconnect|starting|worker/i.test(String(item.message ?? "")) ? "warning" : "info",
      message: item.message,
    })) : []),
  ];
  const unique = new Map();
  for (const entry of combined) unique.set(`${entry.timestamp}|${entry.message}`, entry);
  const recent = [...unique.values()]
    .sort((a, b) => new Date(b.timestamp).valueOf() - new Date(a.timestamp).valueOf())
    .slice(0, 8);
  events.replaceChildren();
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Belum ada percobaan start. Log browser dan server akan tampil di sini.";
    events.append(empty);
    return;
  }
  for (const entry of recent) {
    const row = document.createElement("div");
    row.className = `screener-debug-row ${entry.level || "info"}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = localTime(entry.timestamp);
    const text = document.createElement("span");
    text.className = "screener-debug-message";
    text.textContent = entry.message || "";
    row.append(time, text);
    events.append(row);
  }
}

function renderScreener(status = {}, debug = [], runtime = {}, logs = []) {
  const debugEntries = Array.isArray(debug) ? [...debug] : [];
  const knownEvents = new Set(debugEntries.map((entry) => `${entry.timestamp}|${entry.message}`));
  for (const item of Array.isArray(logs) ? logs : []) {
    const message = String(item.message ?? "");
    if (!/\[debug\]|\[worker stderr\]|\[start error\]|\[feed\]|\[demo error\]|\[settings error\]|\[launch\]|\[paper-buy\]|\[exit:|\[skip\]/i.test(message)) continue;
    const key = `${item.timestamp}|${message}`;
    if (knownEvents.has(key)) continue;
    const level = /stderr|error|exception|gagal|unauthorized|\b40[13]\b/i.test(message)
      ? "error"
      : /disconnect|reconnect|skip/i.test(message) ? "warning" : "info";
    debugEntries.push({ timestamp: item.timestamp, level, message });
    knownEvents.add(key);
  }
  const diagnosticsReady = Number(runtime.screenerDiagnosticsVersion ?? 0) >= 2;
  if (!diagnosticsReady) {
    debugEntries.push({
      timestamp: new Date().toISOString(),
      level: "warning",
      message: "Server yang berjalan belum memuat diagnosa screener terbaru. Restart proses npm.cmd start sekali, lalu muat ulang halaman.",
    });
  }
  debugEntries.sort((a, b) => new Date(b.timestamp).valueOf() - new Date(a.timestamp).valueOf());
  const candidates = Array.isArray(status.candidates) ? status.candidates : [];
  const activeCount = Math.max(Number(status.activeCount ?? 0), candidates.length);
  let phaseLabel = "SCANNER BERHENTI";
  if (runtime.status === "starting") phaseLabel = "MEMULAI WORKER";
  else if (runtime.status === "stopping") phaseLabel = "MENGHENTIKAN";
  else if (runtime.status === "error") phaseLabel = "WORKER ERROR";
  else if (runtime.status === "running") {
    phaseLabel = !diagnosticsReady
      ? "UPDATE SERVER"
      : runtime.feedConnected
      ? "FEED TERHUBUNG · MENUNGGU MIGRASI AMM"
      : "MENUNGGU KONEKSI FEED";
  }
  const phase = $("#screenerState");
  phase.textContent = phaseLabel;
  phase.classList.toggle("error", runtime.status === "error");
  phase.classList.toggle("warning", runtime.status === "running" && !diagnosticsReady);
  phase.classList.toggle("active", runtime.status === "running" && runtime.feedConnected);
  $("#screenerActiveCount").textContent = String(activeCount);
  $("#screenerCapacity").textContent = String(status.maxActive ?? 500);
  const countedTokens = activeCount + Number(status.rejected ?? 0) + Number(status.entered ?? 0) + Number(status.expired ?? 0);
  $("#screenScanned").textContent = String(Math.max(Number(status.scanned ?? 0), countedTokens));
  $("#screenRejected").textContent = String(status.rejected ?? 0);
  $("#screenEntered").textContent = String(status.entered ?? 0);
  $("#screenExpired").textContent = String(status.expired ?? 0);

  const body = $("#screenerBody");
  body.replaceChildren();
  if (!candidates.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-cell";
    cell.textContent = activeCount ? "Kandidat sedang dipantau; detail akan muncul saat ada trade." : "Belum ada kandidat aktif.";
    row.append(cell);
    body.append(row);
  }
  for (const candidate of candidates) {
    const row = document.createElement("tr");
    const tokenCell = document.createElement("td");
    const name = candidate.symbol || candidate.name || shortMint(candidate.mint);
    tokenCell.append(tokenReference(name, candidate, "trade-token token-link"));
    const mint = document.createElement("span");
    mint.className = "trade-mint";
    mint.textContent = isSyntheticToken(candidate) ? "DEMO SINTETIS" : shortMint(candidate.mint);
    if (isSyntheticToken(candidate)) tokenCell.append(mint);
    else tokenCell.append(tokenReference(mint.textContent, candidate, "trade-mint token-link"));

    const stageCell = document.createElement("td");
    stageCell.className = "candidate-stage";
    stageCell.textContent = candidate.stage || "Menunggu trade";
    const activityCell = document.createElement("td");
    activityCell.textContent = `${candidate.trades ?? 0} / ${candidate.buys ?? 0} / ${candidate.uniqueBuyers ?? 0}`;
    const priceCell = document.createElement("td");
    priceCell.textContent = fmtPrice(candidate.currentPrice);
    const ageCell = document.createElement("td");
    ageCell.textContent = `${candidate.ageSeconds ?? 0}s`;
    row.append(tokenCell, stageCell, activityCell, priceCell, ageCell);
    body.append(row);
  }

  const debugList = $("#screenerDebugList");
  debugList.replaceChildren();
  if (!debugEntries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = runtime.status === "running"
      ? runtime.feedConnected
        ? "Feed terhubung, tetapi API belum mengirim log screener. Stop/start scanner untuk memuat worker terbaru."
        : "Belum ada respons worker atau feed. Lihat Aktivitas scanner untuk detail start/error."
      : runtime.status === "error"
        ? "Worker error; detail penyebab seharusnya tercatat di sini atau di Aktivitas scanner."
        : "Log screening muncul saat scanner berjalan.";
    debugList.append(empty);
    return;
  }
  for (const entry of debugEntries.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = `screener-debug-row ${entry.level || "info"}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = localTime(entry.timestamp);
    const message = document.createElement("span");
    message.className = "screener-debug-message";
    message.textContent = entry.message || "";
    row.append(time, message);
    debugList.append(row);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Tidak bisa membaca state.");
    const nextSnapshot = JSON.stringify(data.settings);
    if (nextSnapshot !== settingsSnapshot) {
      applySettings(data.settings);
      settingsSnapshot = nextSnapshot;
    }
    lastRuntimeSnapshot = data.runtime;
    lastServerLogs = data.logs;
    lastScreenerSnapshot = data.screener;
    setRuntime(data.runtime);
    renderAccount(data.account, data.settings);
    renderStartupDiagnostics(data.runtime, data.logs, data.screener);
    renderScreener(data.screener, data.screenerDebug, data.runtime, data.logs);
    renderLogs(data.logs);
  } catch (error) {
    addClientDiagnostic("error", `Tidak dapat membaca server dashboard: ${error.message}`);
    showMessage(`Dashboard tidak bisa membaca server: ${error.message}`, true);
  } finally {
    refreshing = false;
  }
}

strategyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (currentRuntimeStatus === "running") {
    await applyLiveSettings();
    return;
  }
  clientDiagnostics = clientDiagnostics.filter((entry) => entry.level !== "error");
  addClientDiagnostic("info", "Tombol Mulai ditekan; mengirim permintaan ke server.");
  showMessage("Memulai paper scanner…");
  const button = $("#startButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: $("#apiKey").value, settings: collectSettings() }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Server menjawab HTTP ${response.status} dengan respons yang bukan JSON.`);
    }
    addClientDiagnostic(response.ok ? "info" : "error", `Respons API start: HTTP ${response.status}${result.error ? ` — ${result.error}` : ""}`);
    if (!response.ok) throw new Error(result.error || "Tidak bisa menjalankan scanner.");
    $("#apiKey").value = "";
    showMessage("Scanner dimulai. Saldo dan trade pada halaman ini adalah simulasi.");
    await refresh();
  } catch (error) {
    addClientDiagnostic("error", `Start gagal di browser: ${error.message}`);
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    await refresh();
  }
});

async function applyLiveSettings() {
  const button = $("#applySettingsButton");
  button.disabled = true;
  showMessage("Mengirim perubahan ke bot aktif…");
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: collectSettings() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Tidak bisa memperbarui strategi.");
    showMessage("Strategi diterapkan ke bot yang sedang berjalan; restart tidak diperlukan.");
    await refresh();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    button.disabled = false;
    await refresh();
  }
}

$("#applySettingsButton").addEventListener("click", applyLiveSettings);

$("#stopButton").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/stop", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Tidak bisa menghentikan scanner.");
    showMessage("Meminta scanner berhenti…");
    await refresh();
  } catch (error) {
    showMessage(error.message, true);
  }
});

$("#resetButton").addEventListener("click", async () => {
  const balance = Number(strategyForm.elements.namedItem("paperStartBalanceSol").value);
  if (!window.confirm(`Reset saldo dan riwayat paper ke ${balance} SOL? Tindakan ini menghapus state simulasi saat ini.`)) return;
  try {
    const response = await fetch("/api/reset-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ balanceSol: balance }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Tidak bisa mereset account.");
    showMessage("Paper account berhasil direset.");
    await refresh();
  } catch (error) {
    showMessage(error.message, true);
  }
});

refresh();
setInterval(refresh, 1000);
