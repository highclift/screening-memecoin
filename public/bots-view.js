// The three bot cards and the "what is happening now" headline.
//
// One card per stage of the chain: bot 1 screens every coin, bot 2 decides which could pump, bot 3
// buys and sells. Cards are built once and updated in place, so numbers can ease instead of
// flickering. Bot 1's card carries the list of coins it screened most recently — the point of the
// first stage is that you can see what it looked at.

const BOT_ORDER = ["screener", "filter", "executor"];
const BOT_ICON = { screener: "◎", filter: "⧩", executor: "◆" };

// bot id -> { card, fields... }, kept across renders so DOM nodes are reused.
const botCardRefs = new Map();

function botStatRow(labelKey, helpKey) {
  const row = document.createElement("div");
  row.className = "lane-stat";
  const caption = document.createElement("span");
  caption.className = "lane-stat-label";
  caption.textContent = t(labelKey);
  caption.dataset.labelKey = labelKey;
  if (helpKey) {
    const mark = document.createElement("span");
    mark.className = "help-mark";
    mark.dataset.help = helpKey;
    mark.textContent = "?";
    mark.setAttribute("tabindex", "0");
    mark.setAttribute("role", "note");
    caption.append(mark);
  }
  const value = document.createElement("strong");
  value.className = "lane-stat-value";
  value.textContent = "—";
  row.append(caption, value);
  return { row, value, caption };
}

// Which stats each card shows, in order. [key, label, optional help key]
const BOT_STATS = {
  screener: [
    ["coins", "bot.stat.coins"],
    ["perMinute", "bot.stat.perMinute", "help.perMinute"],
    ["newPerMinute", "bot.stat.newPerMinute"],
    ["universe", "bot.stat.universe"],
    ["launches", "bot.stat.launches"],
  ],
  filter: [
    ["judged", "bot.stat.judged"],
    ["green", "bot.stat.green", "help.green"],
    ["red", "bot.stat.red"],
    ["topReason", "bot.stat.topReason"],
  ],
  executor: [
    ["balance", "bot.stat.balance"],
    ["pnl", "bot.stat.pnl"],
    ["open", "bot.stat.open"],
    ["record", "bot.stat.record", "help.record"],
    ["watching", "bot.stat.watching", "help.watching"],
    ["entries", "bot.stat.entriesToday"],
  ],
};

function buildBotCard(id) {
  const card = document.createElement("article");
  card.className = "lane-card";
  card.dataset.bot = id;

  const head = document.createElement("div");
  head.className = "lane-head";
  const icon = document.createElement("span");
  icon.className = "lane-icon";
  icon.textContent = BOT_ICON[id] ?? "◈";
  const titles = document.createElement("div");
  titles.className = "lane-titles";
  const name = document.createElement("strong");
  name.className = "lane-name";
  const stage = document.createElement("span");
  stage.className = "lane-age";
  titles.append(name, stage);
  const pill = document.createElement("span");
  pill.className = "lane-pill";
  head.append(icon, titles, pill);

  const task = document.createElement("p");
  task.className = "lane-task";

  const now = document.createElement("div");
  now.className = "lane-now";
  const nowDot = document.createElement("span");
  nowDot.className = "lane-now-dot";
  const nowText = document.createElement("span");
  nowText.className = "lane-now-text";
  now.append(nowDot, nowText);

  const stats = document.createElement("div");
  stats.className = "lane-stats";
  const rows = {};
  for (const [key, labelKey, helpKey] of BOT_STATS[id]) {
    rows[key] = botStatRow(labelKey, helpKey);
    stats.append(rows[key].row);
  }

  const details = document.createElement("details");
  details.className = "lane-details";
  const summary = document.createElement("summary");
  const list = document.createElement("div");
  list.className = "bot-detail-list";
  details.append(summary, list);

  card.append(head, task, now, stats, details);
  const refs = { card, name, stage, pill, task, nowText, rows, summary, list, details };
  botCardRefs.set(id, refs);
  return refs;
}

function ageText(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  return fmtDuration(seconds * 1000);
}

// Bot 1's card lists the coins it screened last: symbol, how old the coin is, its market cap.
function fillScreenerList(list, status) {
  list.replaceChildren();
  const recent = Array.isArray(status.recent) ? status.recent : [];
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("bot.screener.listEmpty");
    list.append(empty);
    return;
  }
  for (const coin of recent) {
    const row = document.createElement("div");
    row.className = "bot-detail-row";
    const label = document.createElement("span");
    label.className = "bot-detail-name";
    label.textContent = coin.symbol || shortMint(coin.mint);
    const meta = document.createElement("span");
    meta.className = "bot-detail-meta";
    meta.textContent = t("bot.screener.listRow", {
      age: ageText(coin.ageSeconds),
      marketCap: fmtUsdExact(coin.marketCapUsd),
    });
    row.append(label, meta);
    list.append(row);
  }
}

// Bot 2's card lists the coins it turned green most recently, and why.
function fillFilterList(list, status) {
  list.replaceChildren();
  const recent = Array.isArray(status.recentGreen) ? status.recentGreen : [];
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("bot.filter.listEmpty");
    list.append(empty);
    return;
  }
  for (const coin of recent) {
    const row = document.createElement("div");
    row.className = "bot-detail-row";
    const label = document.createElement("span");
    label.className = "bot-detail-name";
    label.textContent = coin.symbol || shortMint(coin.mint);
    const meta = document.createElement("span");
    meta.className = "bot-detail-meta";
    meta.textContent = t("bot.filter.listRow", {
      score: fmtScore(coin.score),
      reason: leadText(coin.lead),
      age: ageText(coin.ageSeconds),
    });
    row.append(label, meta);
    list.append(row);
  }
}

// Bot 3's card lists what it is waiting for on each coin it may buy.
function fillExecutorList(list, status) {
  list.replaceChildren();
  const watching = Array.isArray(status.watching) ? status.watching : [];
  if (!watching.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("bot.executor.listEmpty");
    list.append(empty);
    return;
  }
  for (const coin of watching) {
    const row = document.createElement("div");
    row.className = "bot-detail-row";
    const label = document.createElement("span");
    label.className = "bot-detail-name";
    label.textContent = coin.symbol || shortMint(coin.mint);
    const meta = document.createElement("span");
    meta.className = "bot-detail-meta";
    meta.textContent = waitingText(coin);
    row.append(label, meta);
    list.append(row);
  }
}

function botNowSentence(id, status, runtime) {
  const running = runtime.status === "running" || runtime.status === "starting";
  if (!running) return t("bot.now.off");
  if (!status) return t("bot.now.notStarted");

  if (id === "screener") {
    const perMinute = Number(status.perMinute ?? 0);
    if (!Number(status.coins ?? 0)) return t("bot.screener.now.waiting");
    return t("bot.screener.now.working", { perMinute: fmtInt(perMinute), newPerMinute: fmtInt(status.newPerMinute ?? 0), coins: fmtInt(status.coins) });
  }
  if (id === "filter") {
    if (!Number(status.evaluated ?? 0)) return t("bot.filter.now.waiting");
    if (Number(status.greenNow ?? 0) > 0) return t("bot.filter.now.green", { coins: tn("frag.coins", Number(status.greenNow)) });
    return t("bot.filter.now.none", { judged: fmtInt(status.evaluated) });
  }
  if (Number(status.openPositions ?? 0) > 0) return t("bot.executor.now.holding", { positions: tn("frag.positions", Number(status.openPositions)) });
  if (status.blockedReason) return t("bot.executor.now.blocked", { reason: status.blockedReason });
  if (Number(status.watchingCount ?? 0) > 0) return t("bot.executor.now.watching", { coins: tn("frag.coins", Number(status.watchingCount)) });
  return t("bot.executor.now.idle");
}

function fillScreenerStats(refs, status) {
  setNumber(refs.rows.coins.value, status.coins, fmtInt);
  setNumber(refs.rows.perMinute.value, status.perMinute, fmtInt);
  setNumber(refs.rows.newPerMinute.value, status.newPerMinute, fmtInt);
  setNumber(refs.rows.universe.value, status.universeSize, fmtInt);
  setText(refs.rows.launches.value, `${fmtInt(status.launches)} / ${fmtInt(status.migrations)}`);
}

function fillFilterStats(refs, status) {
  setNumber(refs.rows.judged.value, status.evaluated, fmtInt);
  setText(refs.rows.green.value, `${fmtInt(status.greenNow)} / ${fmtInt(status.green)}`);
  setNumber(refs.rows.red.value, status.red, fmtInt);
  const top = Object.entries(status.categories ?? {}).sort((a, b) => b[1] - a[1])[0];
  setText(refs.rows.topReason.value, top ? categoryLabel(top[0]) : "—");
}

function fillExecutorStats(refs, status) {
  setNumber(refs.rows.balance.value, status.balanceSol, (n) => fmtSol(n, 4));
  const pnl = Number(status.realizedPnlSol ?? 0);
  setNumber(refs.rows.pnl.value, pnl, (n) => fmtSolSigned(n, 4));
  refs.rows.pnl.value.classList.toggle("positive", pnl > 0);
  refs.rows.pnl.value.classList.toggle("negative", pnl < 0);
  setText(refs.rows.open.value, `${fmtInt(status.openPositions)} / ${fmtInt(status.maxOpenPositions)}`);
  setText(refs.rows.record.value, `${fmtInt(status.wins)} / ${fmtInt(status.losses)}`);
  setText(refs.rows.watching.value, `${fmtInt(status.watchingCount)} / ${fmtInt(status.maxWatchlist)}`);
  setText(refs.rows.entries.value, `${fmtInt(status.todayEntries)} / ${fmtInt(status.maxEntriesPerDay)}`);
}

function renderBotCards(status = {}, runtime = {}) {
  const container = document.querySelector("#botCards");
  if (!container) return;
  const bots = status.bots ?? {};
  const running = runtime.status === "running" || runtime.status === "starting";

  for (const id of BOT_ORDER) {
    const bot = bots[id];
    let refs = botCardRefs.get(id);
    if (!refs) {
      refs = buildBotCard(id);
      container.append(refs.card);
    }
    // Labels are rebuilt every pass so a language switch needs no special handling.
    refs.name.textContent = t(`bot.${id}.name`);
    refs.stage.textContent = t(`bot.${id}.stage`);
    refs.task.textContent = t(`bot.${id}.task`);
    refs.summary.textContent = t(`bot.${id}.detailsToggle`);
    for (const [key, labelKey] of BOT_STATS[id]) {
      refs.rows[key].caption.firstChild.textContent = t(labelKey);
    }

    refs.pill.textContent = running ? t("bot.on") : t("bot.off");
    refs.pill.classList.toggle("is-on", running);
    refs.card.classList.toggle("is-live", running && Boolean(bot));
    refs.card.classList.toggle("is-off", !running);
    refs.nowText.textContent = botNowSentence(id, bot, runtime);

    if (!bot) {
      for (const [key] of BOT_STATS[id]) {
        setText(refs.rows[key].value, "—");
        refs.rows[key].value.classList.remove("positive", "negative");
      }
      refs.list.replaceChildren();
      continue;
    }

    if (id === "screener") {
      fillScreenerStats(refs, bot);
      fillScreenerList(refs.list, bot);
    } else if (id === "filter") {
      fillFilterStats(refs, bot);
      fillFilterList(refs.list, bot);
    } else {
      fillExecutorStats(refs, bot);
      fillExecutorList(refs.list, bot);
    }
  }
}

// One sentence above everything else: the thing a newcomer reads first.
function renderNowHeadline(runtime = {}, status = {}) {
  const element = document.querySelector("#nowSentence");
  if (!element) return;
  const bots = status.bots ?? {};
  const screened = Number(bots.screener?.coins ?? 0);
  const perMinute = Number(bots.screener?.perMinute ?? 0);
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
