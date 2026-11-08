const $ = (selector) => document.querySelector(selector);
const strategyForm = $("#strategyForm");
const messageBox = $("#formMessage");
const percentageFields = new Set(["pullbackPct", "bouncePct", "takeProfitPct", "stopLossPct"]);
let settingsSnapshot = "";
let refreshing = false;
let currentRuntimeStatus = "stopped";

function fmtSol(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(digits)} SOL` : "—";
}

function fmtPrice(value) {
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

function showMessage(message, isError = false) {
  messageBox.textContent = message;
  messageBox.classList.toggle("error", isError);
}

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
    let value = Number(rawValue);
    if (percentageFields.has(name)) value /= 100;
    settings[name] = value;
  }
  return settings;
}

function setRuntime(runtime) {
  currentRuntimeStatus = runtime.status;
  const running = ["starting", "running", "stopping"].includes(runtime.status);
  const status = $("#feedStatus");
  status.classList.toggle("connected", runtime.feedConnected);
  status.classList.toggle("pending", running && !runtime.feedConnected);
  status.lastElementChild.textContent = runtime.feedConnected ? "Feed terhubung" : running ? "Menghubungkan feed" : "Feed terputus";

  const title = {
    starting: "Memulai…",
    running: "Scanner aktif",
    stopping: "Menghentikan…",
    stopped: "Siap dijalankan",
    error: "Perlu diperiksa",
  }[runtime.status] ?? "Siap dijalankan";
  $("#runtimeStatus").textContent = title;
  $("#runtimeDetail").textContent = runtime.feedConnected
    ? "Launch baru sedang dipantau melalui PumpPortal."
    : running
      ? "Menunggu koneksi ke PumpPortal."
      : runtime.hasApiKey
        ? "API key tersedia; siapkan konfigurasi lalu mulai."
        : "Masukkan API key feed untuk mulai.";

  $("#startButton").classList.toggle("hidden", running);
  $("#startButton").disabled = running;
  $("#applySettingsButton").classList.toggle("hidden", runtime.status !== "running");
  $("#applySettingsButton").disabled = runtime.status !== "running";
  $("#stopButton").classList.toggle("hidden", !running);
  for (const input of document.querySelectorAll(".settings-input")) {
    input.disabled = input.id === "apiKey" ? running : runtime.status === "stopping";
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
    const name = document.createElement("div");
    name.className = "token-name";
    name.textContent = position.symbol || position.name || shortMint(position.mint);
    const mint = document.createElement("div");
    mint.className = "token-sub";
    mint.textContent = shortMint(position.mint);
    nameWrap.append(name, mint);
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
    const mint = document.createElement("span");
    mint.className = "trade-mint";
    mint.textContent = shortMint(trade.mint);
    tokenCell.append(token, mint);
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
    setRuntime(data.runtime);
    renderAccount(data.account, data.settings);
    renderLogs(data.logs);
  } catch (error) {
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
  showMessage("Memulai paper scanner…");
  const button = $("#startButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: $("#apiKey").value, settings: collectSettings() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Tidak bisa menjalankan scanner.");
    $("#apiKey").value = "";
    showMessage("Scanner dimulai. Saldo dan trade pada halaman ini adalah simulasi.");
    await refresh();
  } catch (error) {
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
setInterval(refresh, 2000);
