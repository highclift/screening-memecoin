const $ = (selector) => document.querySelector(selector);
const strategyForm = $("#strategyForm");
const messageBox = $("#formMessage");

let settingsSnapshot = "";
let refreshing = false;
let currentRuntimeStatus = "stopped";
let clientDiagnostics = [];
let lastRuntimeSnapshot = {};
let lastServerLogs = [];
let lastScreenerSnapshot = {};
let lastScreenerDebug = [];
// Set once the first batch of feed lines has been drawn, so a page load does not animate 40 rows.
let storyPrimed = false;
// The message currently shown under the form, kept as { key, params } so it survives a language switch.
let formMessage = null;

function shortMint(value) {
  if (!value || value.length < 14) return value || "—";
  return `${value.slice(0, 6)}…${value.slice(-5)}`;
}

function signClass(value) {
  return Number(value) >= 0 ? "positive" : "negative";
}

function isSyntheticToken(item) {
  return item?.dataSource === "demo" || String(item?.mint ?? "").startsWith("DEMO-");
}

// A coin with no symbol or name is already shown by its shortened mint, so the mint sub-line
// would just repeat it.
function hasTokenName(item) {
  return Boolean(item?.symbol || item?.name);
}

function tokenReference(label, item, className) {
  const element = document.createElement(isSyntheticToken(item) ? "span" : "a");
  element.className = className;
  element.textContent = label;
  if (!isSyntheticToken(item)) {
    element.href = `https://axiom.trade/token/${encodeURIComponent(item.mint)}`;
    element.target = "_blank";
    element.rel = "noreferrer";
    element.title = item.mint;
  }
  return element;
}

// Every call to the dashboard server goes through here. A reply is not always JSON: a route that
// does not exist in the running server answers with an HTML error page, and parsing that throws
// "Unexpected token '<'", which tells nobody anything. This turns it into a sentence that does.
async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let result = null;
  try {
    result = await response.json();
  } catch {
    result = null;
  }
  if (result === null) {
    throw new Error(response.status === 404
      ? t("msg.staleServer")
      : t("msg.badResponse", { status: response.status }));
  }
  if (!response.ok) throw new Error(result.error || t("msg.badResponse", { status: response.status }));
  return result;
}

function showMessage(key, params, isError = false) {
  formMessage = key ? { key, params, isError } : null;
  messageBox.textContent = key ? t(key, params) : "";
  messageBox.classList.toggle("error", Boolean(isError));
}

// Raw text from the server (an API error) has no dictionary key, so it is shown verbatim.
function showRawMessage(text, isError = true) {
  formMessage = null;
  messageBox.textContent = String(text);
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
  addClientDiagnostic("error", `Dashboard JavaScript error: ${event.message || "unknown"}`);
});
window.addEventListener("unhandledrejection", (event) => {
  addClientDiagnostic("error", `Dashboard request failed: ${event.reason?.message ?? String(event.reason)}`);
});

strategyForm.addEventListener("invalid", (event) => {
  const input = event.target;
  const field = input?.name || input?.id || "input";
  addClientDiagnostic("error", `Validation failed for ${field}: ${input?.validationMessage || "invalid value"}`);
}, true);

// ---------- language switch ----------
function syncLangButtons() {
  for (const button of document.querySelectorAll(".lang-option")) {
    const active = button.dataset.lang === lang();
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => setLang(button.dataset.lang));
}

// ---------- appearance ----------
function syncThemeButtons() {
  for (const button of document.querySelectorAll("[data-theme-option]")) {
    const active = button.dataset.themeOption === theme();
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

for (const button of document.querySelectorAll("[data-theme-option]")) {
  button.addEventListener("click", () => setTheme(button.dataset.themeOption));
}

onThemeChange(syncThemeButtons);

onLangChange(() => {
  syncLangButtons();
  // Re-draw everything derived from data so the new language reaches generated text too.
  if (formMessage) showMessage(formMessage.key, formMessage.params, formMessage.isError);
  setRuntime(lastRuntimeSnapshot);
  renderStartupDiagnostics(lastRuntimeSnapshot, lastServerLogs, lastScreenerSnapshot);
  renderScreener(lastScreenerSnapshot, lastRuntimeSnapshot);
  renderStory(lastServerLogs);
  renderTechnicalLog(lastServerLogs, lastScreenerDebug);
  renderNowHeadline(lastRuntimeSnapshot, lastScreenerSnapshot);
  renderBotCards(lastScreenerSnapshot, lastRuntimeSnapshot);
  refresh();
});

// Only money limits are left in the form: the window, the kill list and the pass mark are the
// desk's definition of itself and live in .env.
//
// A field may be shown in friendlier units than it is stored in (`data-scale`): the position size
// is a fraction everywhere in the code and a percentage in the form, because nobody thinks in 0.08.
const scaleOf = (input) => Number(input?.dataset?.scale) || 1;

function applySettings(settings) {
  for (const [name, rawValue] of Object.entries(settings ?? {})) {
    const input = strategyForm.elements.namedItem(name);
    if (!input || document.activeElement === input) continue;
    const scale = scaleOf(input);
    const value = Number(rawValue);
    input.value = String(scale === 1 || !Number.isFinite(value) ? rawValue : Number((value / scale).toFixed(6)));
  }
}

function collectSettings() {
  const settings = {};
  for (const [name, rawValue] of new FormData(strategyForm).entries()) {
    const input = strategyForm.elements.namedItem(name);
    settings[name] = Number(rawValue) * scaleOf(input);
  }
  return settings;
}

function setRuntime(runtime = {}) {
  currentRuntimeStatus = runtime.status ?? "stopped";
  const running = ["starting", "running", "stopping"].includes(runtime.status);
  const status = $("#feedStatus");
  status.classList.toggle("connected", Boolean(runtime.feedConnected));
  status.classList.toggle("pending", running && !runtime.feedConnected);
  setText(status.lastElementChild, runtime.feedConnected
    ? t("feed.connected")
    : running ? t("feed.connecting") : t("feed.disconnected"));

  const titleKey = {
    starting: "runtime.starting",
    running: "runtime.running",
    stopping: "runtime.stopping",
    stopped: "runtime.stopped",
    error: "runtime.error",
  }[runtime.status] ?? "runtime.stopped";
  setText($("#runtimeStatus"), t(titleKey));
  setText($("#runtimeDetail"), runtime.feedConnected
    ? t("runtime.detail.running")
    : running
      ? t("runtime.detail.connecting")
      : runtime.hasApiKey
        ? t("runtime.detail.hasKey")
        : t("runtime.detail.noKey"));

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
  setNumber($("#balanceValue"), account.balanceSol, (n) => fmtSol(n, 4));
  const pnl = Number(account.realizedPnlSol ?? 0);
  const pnlElement = $("#pnlValue");
  setNumber(pnlElement, pnl, (n) => fmtSolSigned(n, 4));
  pnlElement.classList.toggle("positive", pnl > 0);
  pnlElement.classList.toggle("negative", pnl < 0);
  $("#pnlIcon").classList.toggle("negative", pnl < 0);
  setNumber($("#positionsValue"), account.openPositions.length, fmtInt);
  setText($("#positionsFoot"), t("metric.positionsFoot", { limit: fmtInt(settings.maxOpenPositions) }));
  setNumber($("#entriesValue"), account.entriesToday, fmtInt);
  setText($("#entriesFoot"), t("metric.entriesFoot", { limit: fmtInt(settings.maxEntriesPerDay) }));
  setText($("#openCount"), fmtInt(account.openPositions.length));
  renderPositions(account.openPositions);
  renderClosedTrades(account.closedTrades);
}

function emptyState(key) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = t(key);
  return empty;
}

function renderPositions(positions) {
  const container = $("#positionsList");
  container.replaceChildren();
  if (!positions.length) {
    container.append(emptyState("positions.empty"));
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
    const tokenLabelText = position.symbol || position.name || shortMint(position.mint);
    const nameRef = tokenReference(tokenLabelText, position, "token-name token-link");
    nameWrap.append(nameRef);
    if (isSyntheticToken(position) || hasTokenName(position)) {
      const mint = document.createElement("div");
      mint.className = "token-sub";
      mint.textContent = "DEMO";
      nameWrap.append(isSyntheticToken(position)
        ? mint
        : tokenReference(shortMint(position.mint), position, "token-sub token-link"));
    }
    ident.append(avatar, nameWrap);

    const numbers = document.createElement("div");
    numbers.className = "position-numbers";
    const pnl = document.createElement("div");
    const pnlValue = Number(position.estimatedPnlSol ?? 0);
    pnl.className = `position-pnl ${signClass(pnlValue)}`;
    pnl.textContent = fmtSolSigned(pnlValue, 4);
    const cost = document.createElement("div");
    cost.className = "position-cost";
    cost.textContent = t("positions.cost", {
      cost: fmtSol(position.costSol, 3),
      entry: fmtUsdExact(position.entryMarketCapUsd),
      now: fmtUsdExact(position.currentMarketCapUsd),
    });
    numbers.append(pnl, cost);

    // Emergency exit for this one coin. Confirmed, because it spends the position immediately.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "button button-quiet button-small position-close";
    close.textContent = t("positions.close");
    close.title = t("positions.closeHelp");
    close.addEventListener("click", () => closePositions(position.mint, tokenLabelText));

    row.append(ident, numbers, close);
    container.append(row);
  }
}

// mint = close that one; null = close everything.
async function closePositions(mint, label) {
  const question = mint ? t("msg.closeConfirm", { token: label }) : t("msg.closeAllConfirm");
  if (!window.confirm(question)) return;
  try {
    await postJson("/api/close", mint ? { mint } : {});
    showMessage(mint ? "msg.closed" : "msg.closedAll");
    await refresh();
  } catch (error) {
    showRawMessage(error.message);
  }
}

function mcCell(value, note) {
  const cell = document.createElement("td");
  cell.textContent = fmtUsdExact(value);
  if (note) {
    const sub = document.createElement("span");
    sub.className = "trade-mint";
    sub.textContent = note;
    cell.append(sub);
  }
  return cell;
}

function renderClosedTrades(trades) {
  const body = $("#tradesBody");
  body.replaceChildren();
  if (!trades.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty-cell";
    cell.textContent = t("trades.empty");
    row.append(cell);
    body.append(row);
    return;
  }
  for (const trade of trades) {
    const row = document.createElement("tr");
    const tokenCell = document.createElement("td");
    const label = trade.symbol || trade.name || shortMint(trade.mint);
    tokenCell.append(tokenReference(label, trade, "trade-token token-link"));
    if (isSyntheticToken(trade) || hasTokenName(trade)) {
      const mint = document.createElement("span");
      mint.className = "trade-mint";
      mint.textContent = isSyntheticToken(trade) ? "DEMO" : shortMint(trade.mint);
      tokenCell.append(isSyntheticToken(trade) ? mint : tokenReference(mint.textContent, trade, "trade-mint token-link"));
    }

    const entryCell = mcCell(trade.entryMarketCapUsd, trade.openedAt ? t("trade.openedAt", { time: fmtClock(trade.openedAt) }) : "");
    const exitCell = mcCell(trade.exitMarketCapUsd, trade.closedAt ? t("trade.closedAt", { time: fmtClock(trade.closedAt) }) : "");

    const reasonCell = document.createElement("td");
    reasonCell.className = "exit-reason";
    const reason = String(trade.reason ?? "exit");
    const reasonLabel = t(`exit.${reason}`);
    reasonCell.textContent = reasonLabel === `exit.${reason}` ? reason.replaceAll("-", " ") : reasonLabel;
    if (trade.openedAt && trade.closedAt) {
      const held = document.createElement("span");
      held.className = "trade-mint";
      held.textContent = t("trade.held", { duration: fmtDuration(trade.closedAt - trade.openedAt) });
      reasonCell.append(held);
    }

    const pnlCell = document.createElement("td");
    const pnl = Number(trade.pnlSol ?? 0);
    pnlCell.className = signClass(pnl);
    pnlCell.textContent = fmtSolSigned(pnl, 4);
    const cost = Number(trade.costSol);
    if (Number.isFinite(cost) && cost > 0) {
      const pct = document.createElement("span");
      pct.className = "trade-mint";
      pct.textContent = `${pnl >= 0 ? "+" : ""}${((pnl / cost) * 100).toFixed(1)}%`;
      pnlCell.append(pct);
    }
    row.append(tokenCell, entryCell, exitCell, reasonCell, pnlCell);
    body.append(row);
  }
}

// ---------- the plain-language story ----------
// Nodes are keyed by timestamp+message so an unchanged line keeps its DOM node and does not
// replay its enter animation on the next one-second refresh.
const storyNodes = new Map();

function buildStoryRow() {
  const row = document.createElement("div");
  row.className = "story-row";
  const icon = document.createElement("span");
  icon.className = "story-icon";
  const body = document.createElement("div");
  body.className = "story-body";
  const text = document.createElement("span");
  text.className = "story-text";
  const meta = document.createElement("span");
  meta.className = "story-meta";
  const botTag = document.createElement("span");
  botTag.className = "story-lane";
  const time = document.createElement("span");
  time.className = "story-time";
  meta.append(botTag, time);
  body.append(text, meta);
  row.append(icon, body);
  return { row, icon, text, botTag, time };
}

function fillStoryRow(refs, entry) {
  const { item, timestamp } = entry;
  refs.row.className = `story-row tone-${item.tone ?? "info"}`;
  refs.icon.textContent = item.icon ?? "·";
  refs.text.textContent = t(item.key, item.params);
  refs.time.textContent = fmtClock(timestamp);
  if (item.bot) {
    refs.botTag.textContent = t(`bot.${item.bot}.badge`);
    refs.botTag.classList.remove("hidden");
    refs.botTag.dataset.bot = item.bot;
  } else {
    refs.botTag.textContent = "";
    refs.botTag.classList.add("hidden");
  }
}

function renderStory(logs = []) {
  const container = $("#storyList");
  if (!container) return;
  const entries = [];
  for (const line of Array.isArray(logs) ? logs : []) {
    const item = humanizeLog(line.message);
    if (!item) continue;
    entries.push({ key: `${line.timestamp}|${line.message}`, timestamp: line.timestamp, item });
    if (entries.length >= 40) break;
  }

  if (!entries.length) {
    storyNodes.clear();
    container.replaceChildren(emptyState("activity.empty"));
    return;
  }

  const fragment = document.createDocumentFragment();
  const liveKeys = new Set();
  for (const entry of entries) {
    liveKeys.add(entry.key);
    let refs = storyNodes.get(entry.key);
    if (!refs) {
      refs = buildStoryRow();
      storyNodes.set(entry.key, refs);
      if (storyPrimed) markNew(refs.row);
    }
    fillStoryRow(refs, entry);
    fragment.append(refs.row);
  }
  for (const key of [...storyNodes.keys()]) if (!liveKeys.has(key)) storyNodes.delete(key);
  container.replaceChildren(fragment);
  storyPrimed = true;
}

// Raw, untranslated lines: the escape hatch for whoever can read them.
function renderTechnicalLog(logs = [], debug = []) {
  const container = $("#logList");
  if (!container) return;
  const combined = [
    ...(Array.isArray(logs) ? logs.map((item) => ({ timestamp: item.timestamp, message: item.message, level: "" })) : []),
    ...(Array.isArray(debug) ? debug.map((item) => ({ timestamp: item.timestamp, message: item.message, level: item.level })) : []),
  ];
  const unique = new Map();
  for (const entry of combined) unique.set(`${entry.timestamp}|${entry.message}`, entry);
  const rows = [...unique.values()]
    .sort((a, b) => new Date(b.timestamp).valueOf() - new Date(a.timestamp).valueOf())
    .slice(0, 120);

  container.replaceChildren();
  if (!rows.length) {
    container.append(emptyState("activity.technicalEmpty"));
    return;
  }
  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "log-row";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = fmtClock(item.timestamp);
    const text = document.createElement("span");
    text.className = "log-message";
    text.textContent = item.message;
    const message = String(item.message ?? "");
    if (item.level === "error" || /error|exception|gagal|stderr/i.test(message)) text.classList.add("error");
    else if (message.includes("[bot3] BUY")) text.classList.add("buy");
    else if (message.includes("[bot3] SELL")) text.classList.add("exit");
    else if (message.includes("[bot2] GREEN")) text.classList.add("launch");
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
  // The scout is seeing coins but the filter cannot judge any of them: that means the market data
  // is not arriving, which looks identical to "nothing is pumping" unless it is called out.
  const bot1 = screener.bots?.scout ?? {};
  const bot2 = screener.bots?.filter ?? {};
  const waitingForData = Number(bot2.categories?.no_data ?? 0);
  const dataMissing = runtime.status === "running"
    && runtime.feedConnected
    && Number(bot1.coins ?? 0) >= 20
    && Number(bot2.judged ?? 0) > 0
    && Number(bot2.passed ?? 0) + Number(bot2.killed ?? 0) === 0
    && waitingForData >= 10;

  let titleKey = "startup.ready";
  let badgeKey = "startup.readyBadge";
  let messageKey = "startup.readyMessage";
  let rawMessage = "";
  let level = "";

  if (runtime.status === "error") {
    titleKey = "startup.errorTitle";
    badgeKey = "startup.errorBadge";
    messageKey = "startup.errorMessage";
    rawMessage = newestServerError || newestClientError || "";
    level = "error";
  } else if (runtime.status === "starting") {
    titleKey = "startup.startingTitle";
    badgeKey = "startup.startingBadge";
    messageKey = "startup.startingMessage";
  } else if (runtime.status === "stopping") {
    titleKey = "startup.stoppingTitle";
    badgeKey = "startup.stoppingBadge";
    messageKey = "startup.stoppingMessage";
  } else if (dataMissing) {
    titleKey = "startup.dataMissingTitle";
    badgeKey = "startup.dataMissingBadge";
    messageKey = "startup.dataMissingMessage";
    level = "warning";
  } else if (runtime.status === "running" && runtime.feedConnected) {
    titleKey = "startup.liveTitle";
    badgeKey = "startup.liveBadge";
    messageKey = "startup.liveMessage";
  } else if (runtime.status === "running") {
    titleKey = "startup.feedTitle";
    badgeKey = "startup.feedBadge";
    messageKey = "startup.feedMessage";
    rawMessage = newestServerError || "";
    level = newestServerError ? "error" : "warning";
  } else if (newestClientError) {
    titleKey = "startup.uiErrorTitle";
    badgeKey = "startup.uiErrorBadge";
    messageKey = "";
    rawMessage = newestClientError;
    level = "error";
  } else if (newestServerError) {
    titleKey = "startup.errorTitle";
    badgeKey = "startup.errorBadge";
    messageKey = "";
    rawMessage = newestServerError;
    level = "error";
  }

  setText(title, t(titleKey));
  setText(badge, t(badgeKey));
  badge.classList.toggle("startup-error", level === "error");
  badge.classList.toggle("startup-warning", level === "warning");
  setText(message, [messageKey ? t(messageKey) : "", rawMessage].filter(Boolean).join(" — "));
  message.classList.toggle("error", level === "error");
  message.classList.toggle("warning", level === "warning");

  const combined = [
    ...clientDiagnostics,
    ...(Array.isArray(logs) ? logs.map((item) => ({ timestamp: item.timestamp, level: "", message: item.message })) : []),
  ];
  const unique = new Map();
  for (const entry of combined) unique.set(`${entry.timestamp}|${entry.message}`, entry);
  const recent = [...unique.values()]
    .sort((a, b) => new Date(b.timestamp).valueOf() - new Date(a.timestamp).valueOf())
    .slice(0, 10);

  events.replaceChildren();
  if (!recent.length) {
    events.append(emptyState("startup.eventsEmpty"));
    return;
  }
  for (const entry of recent) {
    const row = document.createElement("div");
    const isError = entry.level === "error" || /error|failed|gagal|unauthorized|exception/i.test(String(entry.message ?? ""));
    row.className = `screener-debug-row ${isError ? "error" : "info"}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = fmtClock(entry.timestamp);
    const text = document.createElement("span");
    text.className = "screener-debug-message";
    text.textContent = entry.message || "";
    row.append(time, text);
    events.append(row);
  }
}

// The candidate list: what the analyst scored at or above the pass mark, and what the executor is
// doing about each one.
function renderScreener(status = {}, runtime = {}) {
  const bots = status.bots ?? {};
  const filter = bots.filter ?? {};
  const analyst = bots.analyst ?? {};
  const executor = bots.executor ?? {};
  const screener = bots.scout ?? {};
  const greenList = Array.isArray(analyst.candidates) ? analyst.candidates : [];

  let phaseKey = "screener.stopped";
  if (runtime.status === "starting") phaseKey = "screener.starting";
  else if (runtime.status === "stopping") phaseKey = "screener.stopping";
  else if (runtime.status === "error") phaseKey = "screener.error";
  else if (runtime.status === "running") phaseKey = runtime.feedConnected ? "screener.live" : "screener.waitingFeed";
  const phase = $("#screenerState");
  setText(phase, t(phaseKey));
  phase.classList.toggle("error", runtime.status === "error");
  phase.classList.toggle("active", runtime.status === "running" && Boolean(runtime.feedConnected));

  setNumber($("#screenerActiveCount"), analyst.passingNow ?? 0, fmtInt);
  setText($("#screenerCapacity"), fmtInt(analyst.passScore ?? 70));
  setNumber($("#statScreened"), screener.coins ?? 0, fmtInt);
  setNumber($("#statPerMinute"), screener.newPerMinute ?? 0, fmtInt);
  setNumber($("#statRejected"), bots.logger?.kills ?? 0, fmtInt);
  setNumber($("#statBought"), executor.entries ?? 0, fmtInt);
  if (typeof renderFunnel === "function") renderFunnel(status);

  // What the executor is doing with each candidate, keyed by mint.
  const bot3State = new Map();
  for (const position of Array.isArray(executor.positions) ? executor.positions : []) {
    bot3State.set(position.mint, { text: t("bot3.holding"), className: "positive" });
  }
  for (const coin of Array.isArray(executor.watching) ? executor.watching : []) {
    if (!bot3State.has(coin.mint)) bot3State.set(coin.mint, { text: waitingText(coin), className: "" });
  }

  const body = $("#screenerBody");
  body.replaceChildren();
  if (!greenList.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "empty-cell";
    cell.textContent = t(Number(screener.coins ?? 0) ? "screener.emptyScreening" : "screener.empty");
    row.append(cell);
    body.append(row);
    return;
  }

  for (const coin of greenList) {
    const row = document.createElement("tr");

    const tokenCell = document.createElement("td");
    const label = coin.symbol || shortMint(coin.mint);
    tokenCell.append(tokenReference(label, coin, "trade-token token-link"));
    if (coin.symbol) {
      tokenCell.append(tokenReference(shortMint(coin.mint), coin, "trade-mint token-link"));
    }

    const ageCell = document.createElement("td");
    ageCell.textContent = Number.isFinite(coin.ageSeconds) ? fmtDuration(coin.ageSeconds * 1000) : "—";

    const scoreCell = document.createElement("td");
    scoreCell.className = "candidate-stage";
    const scoreHead = document.createElement("span");
    scoreHead.className = "stage-head";
    scoreHead.textContent = fmtScore(coin.score);
    const scoreWhy = document.createElement("span");
    scoreWhy.className = "stage-detail";
    scoreWhy.textContent = leadText(coin.lead);
    scoreCell.append(scoreHead, scoreWhy);

    const surgeCell = document.createElement("td");
    surgeCell.textContent = measuredText(coin);

    const mcCellEl = document.createElement("td");
    mcCellEl.textContent = fmtUsdExact(coin.marketCapUsd);

    const stateCell = document.createElement("td");
    stateCell.className = "candidate-stage";
    const state = bot3State.get(coin.mint) ?? { text: t("bot3.notWatching"), className: "" };
    const stateText = document.createElement("span");
    stateText.className = `stage-head ${state.className}`.trim();
    stateText.textContent = state.text;
    stateCell.append(stateText);

    row.append(tokenCell, ageCell, scoreCell, surgeCell, mcCellEl, stateCell);
    body.append(row);
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not read state.");
    const nextSnapshot = JSON.stringify(data.settings);
    if (nextSnapshot !== settingsSnapshot) {
      applySettings(data.settings);
      settingsSnapshot = nextSnapshot;
    }
    lastRuntimeSnapshot = data.runtime;
    lastServerLogs = data.logs;
    lastScreenerSnapshot = data.screener;
    lastScreenerDebug = data.screenerDebug;

    setRuntime(data.runtime);
    renderNowHeadline(data.runtime, data.screener);
    renderStory(data.logs);
    renderTechnicalLog(data.logs, data.screenerDebug);
    renderBotCards(data.screener, data.runtime);
    renderAccount(data.account, data.settings);
    renderStartupDiagnostics(data.runtime, data.logs, data.screener);
    renderScreener(data.screener, data.runtime);
  } catch (error) {
    addClientDiagnostic("error", `Could not read the dashboard server: ${error.message}`);
    showMessage("msg.readError", { detail: error.message }, true);
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
  showMessage("msg.starting");
  const button = $("#startButton");
  button.disabled = true;
  try {
    await postJson("/api/start", { apiKey: $("#apiKey").value, settings: collectSettings() });
    $("#apiKey").value = "";
    showMessage("msg.started");
    await refresh();
  } catch (error) {
    addClientDiagnostic("error", `Start failed in the browser: ${error.message}`);
    showRawMessage(error.message);
  } finally {
    button.disabled = false;
    await refresh();
  }
});

async function applyLiveSettings() {
  const button = $("#applySettingsButton");
  button.disabled = true;
  showMessage("msg.applying");
  try {
    await postJson("/api/settings", { settings: collectSettings() });
    showMessage("msg.applied");
    await refresh();
  } catch (error) {
    showRawMessage(error.message);
  } finally {
    button.disabled = false;
    await refresh();
  }
}

$("#applySettingsButton").addEventListener("click", applyLiveSettings);

$("#stopButton").addEventListener("click", async () => {
  try {
    await postJson("/api/stop");
    showMessage("msg.stopping");
    await refresh();
  } catch (error) {
    showRawMessage(error.message);
  }
});

$("#closeAllButton").addEventListener("click", () => closePositions(null));

$("#resetButton").addEventListener("click", async () => {
  const balance = Number(strategyForm.elements.namedItem("paperStartBalanceSol").value);
  if (!window.confirm(t("msg.resetConfirm", { balance }))) return;
  try {
    await postJson("/api/reset-account", { balanceSol: balance });
    showMessage("msg.reset");
    await refresh();
  } catch (error) {
    showRawMessage(error.message);
  }
});

applyStaticText();
syncLangButtons();
syncThemeButtons();
setupNav();
refresh();
setInterval(refresh, 1000);
