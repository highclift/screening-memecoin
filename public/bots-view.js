// The bot rows and the "what is happening now" headline.
//
// One row per bot: what it is, the one number worth seeing at a glance, and whether it is working.
// The detail that used to fill three cards now lives in the log beside it and in `npm run report`.
//
//   screening -> filter -> executor are the chain; storage is what all three write to.

const BOT_ORDER = ["screener", "filter", "executor", "storage"];
const BOT_ICON = { screener: "◎", filter: "⧩", executor: "◆", storage: "▤" };

// bot id -> refs, kept across renders so rows are updated in place rather than rebuilt.
const botRowRefs = new Map();

function buildBotRow(id) {
  const row = document.createElement("div");
  row.className = "bot-row";
  row.dataset.bot = id;

  const icon = document.createElement("span");
  icon.className = "bot-row-icon";
  icon.textContent = BOT_ICON[id] ?? "◈";

  const name = document.createElement("strong");
  name.className = "bot-row-name";

  const stat = document.createElement("span");
  stat.className = "bot-row-stat";

  const state = document.createElement("span");
  state.className = "bot-row-state";

  row.append(icon, name, stat, state);
  const refs = { row, icon, name, stat, state };
  botRowRefs.set(id, refs);
  return refs;
}

const int = (value) => fmtInt(Number(value) || 0);

// The one number each bot is judged by at a glance.
function botStat(id, bots) {
  if (id === "storage") {
    const storage = bots.storage;
    return storage ? t("bot.storage.stat", { lines: int(storage.lines), size: fmtBytes(storage.bytes) }) : "—";
  }
  const bot = bots[id];
  if (!bot) return "—";
  if (id === "screener") return t("bot.screener.stat", { coins: int(bot.coins), perMinute: int(bot.newPerMinute) });
  if (id === "filter") return t("bot.filter.stat", { green: int(bot.greenNow), judged: int(bot.evaluated) });
  return t("bot.executor.stat", {
    open: int(bot.openPositions),
    pnl: fmtSolSigned(Number(bot.realizedPnlSol ?? 0), 3),
  });
}

// running = doing its job right now; idle = up but with nothing to do; stopped = not running.
function botState(id, bots, running) {
  if (!running) return { key: "bot.state.stopped", tone: "stopped" };
  const bot = id === "storage" ? bots.storage : bots[id];
  if (!bot) return { key: "bot.state.starting", tone: "idle" };

  if (id === "executor") {
    if (Number(bot.openPositions) > 0) return { key: "bot.state.trading", tone: "running" };
    if (bot.blockedReason) return { key: "bot.state.blocked", tone: "blocked" };
    return { key: "bot.state.idle", tone: "idle" };
  }
  const busy = id === "screener" ? Number(bot.perMinute) > 0
    : id === "filter" ? Number(bot.evaluated) > 0
      : Number(bot.lines) > 0;
  return busy ? { key: "bot.state.running", tone: "running" } : { key: "bot.state.idle", tone: "idle" };
}

function renderBotCards(status = {}, runtime = {}) {
  const container = document.querySelector("#botRows");
  if (!container) return;
  const bots = status.bots ?? {};
  const running = runtime.status === "running" || runtime.status === "starting";

  for (const id of BOT_ORDER) {
    let refs = botRowRefs.get(id);
    if (!refs) {
      refs = buildBotRow(id);
      container.append(refs.row);
    }
    // Rebuilt every pass so a language switch needs no special handling.
    refs.name.textContent = t(`bot.${id}.name`);
    refs.row.title = t(`bot.${id}.task`);
    setText(refs.stat, botStat(id, bots));

    const state = botState(id, bots, running);
    setText(refs.state, t(state.key));
    refs.state.dataset.tone = state.tone;
    refs.row.classList.toggle("is-live", state.tone === "running");
    refs.row.classList.toggle("is-off", state.tone === "stopped");
  }
}

// One sentence under the rows: the thing a newcomer reads first.
function renderNowHeadline(runtime = {}, status = {}) {
  const element = document.querySelector("#nowSentence");
  if (!element) return;
  const bots = status.bots ?? {};
  const screened = Number(bots.screener?.coins ?? 0);
  const perMinute = Number(bots.screener?.newPerMinute ?? 0);
  const green = Number(bots.filter?.greenNow ?? 0);
  const positions = Number(bots.executor?.openPositions ?? 0);

  let sentence;
  if (runtime.status === "error") sentence = t("now.error");
  else if (runtime.status === "starting") sentence = t("now.starting");
  else if (runtime.status === "stopping") sentence = t("now.stopping");
  else if (runtime.status !== "running") sentence = t("now.stopped");
  else if (!runtime.feedConnected) sentence = t("now.connecting");
  else if (positions > 0) {
    sentence = t("now.holding", { positions: tn("frag.positions", positions), coins: tn("frag.coins", green) });
  } else if (green > 0) {
    sentence = t("now.green", { coins: tn("frag.coins", green), perMinute: fmtInt(perMinute) });
  } else if (screened > 0) {
    sentence = t("now.screening", { coins: tn("frag.coins", screened), perMinute: fmtInt(perMinute) });
  } else sentence = t("now.idle");

  setText(element, sentence);
  element.classList.toggle("is-error", runtime.status === "error");
}
