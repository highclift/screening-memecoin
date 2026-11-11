// The bot rows and the "what is happening now" headline.
//
// One row per bot: what it is, the one number worth seeing at a glance, and whether it is working.
// The detail that used to fill three cards now lives in the log beside it and in `npm run report`.
//
//   scout -> filter -> analyst -> executor <-> risk is the chain; the logger is what they all
//   write to.

const BOT_ORDER = ["scout", "filter", "analyst", "executor", "risk", "logger"];
const BOT_ICON = { scout: "◎", filter: "⧩", analyst: "◈", executor: "◆", risk: "⛉", logger: "▤" };

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

// The one number each agent is judged by at a glance.
function botStat(id, bots) {
  const bot = bots[id];
  if (!bot) return "—";
  if (id === "scout") return t("bot.scout.stat", { coins: int(bot.coins), perMinute: int(bot.newPerMinute) });
  if (id === "filter") return t("bot.filter.stat", { passing: int(bot.passingNow), judged: int(bot.judged) });
  if (id === "analyst") return t("bot.analyst.stat", { candidates: int(bot.passingNow), scored: int(bot.scored) });
  if (id === "risk") {
    return t("bot.risk.stat", { size: fmtSolSigned(Number(bot.nextSizeSol ?? 0), 4), stop: int(Number(bot.stopPct ?? 0) * 100) });
  }
  if (id === "logger") return t("bot.logger.stat", { kills: int(bot.kills), size: fmtBytes(bot.bytes) });
  return t("bot.executor.stat", {
    open: int(bot.openPositions),
    pnl: fmtSolSigned(Number(bot.realizedPnlSol ?? 0), 3),
  });
}

// running = doing its job right now; idle = up but with nothing to do; stopped = not running.
function botState(id, bots, running) {
  if (!running) return { key: "bot.state.stopped", tone: "stopped" };
  const bot = bots[id];
  if (!bot) return { key: "bot.state.starting", tone: "idle" };

  if (id === "executor") {
    if (Number(bot.openPositions) > 0) return { key: "bot.state.trading", tone: "running" };
    return { key: "bot.state.idle", tone: "idle" };
  }
  // Risk is the one agent whose job is to say no, so "blocked" is it working, not it failing.
  if (id === "risk") {
    if (bot.blockedReason) return { key: "bot.state.blocked", tone: "blocked" };
    return { key: "bot.state.running", tone: "running" };
  }
  const busy = id === "scout" ? Number(bot.perMinute) > 0
    : id === "filter" ? Number(bot.judged) > 0
      : id === "analyst" ? Number(bot.scored) > 0
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
  const screened = Number(bots.scout?.coins ?? 0);
  const perMinute = Number(bots.scout?.newPerMinute ?? 0);
  const green = Number(bots.analyst?.passingNow ?? 0);
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
