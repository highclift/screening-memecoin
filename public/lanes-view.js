// Per-lane cards and the "what is happening now" headline.
//
// Each lane is an independent paper bot, so each gets its own card: what its job is, what it is
// doing at this moment, its own balance and record. Cards are built once and then updated in
// place, so numbers can ease instead of flickering.

const LANE_ORDER = ["fresh", "young", "veteran"];
const LANE_ICON = { fresh: "✦", young: "◐", veteran: "◆" };

// lane id -> { card, fields... }, kept across renders so DOM nodes are reused.
const laneCardRefs = new Map();

function laneStatRow(label, helpKey) {
  const row = document.createElement("div");
  row.className = "lane-stat";
  const caption = document.createElement("span");
  caption.className = "lane-stat-label";
  caption.textContent = label;
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

function thresholdRow() {
  const row = document.createElement("div");
  row.className = "lane-threshold";
  const label = document.createElement("span");
  const value = document.createElement("strong");
  row.append(label, value);
  return { row, label, value };
}

function buildLaneCard(id) {
  const card = document.createElement("article");
  card.className = "lane-card";
  card.dataset.lane = id;

  const head = document.createElement("div");
  head.className = "lane-head";
  const icon = document.createElement("span");
  icon.className = "lane-icon";
  icon.textContent = LANE_ICON[id] ?? "◈";
  const titles = document.createElement("div");
  titles.className = "lane-titles";
  const name = document.createElement("strong");
  name.className = "lane-name";
  const age = document.createElement("span");
  age.className = "lane-age";
  titles.append(name, age);
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
  const balance = laneStatRow(t("lane.balance"));
  const pnl = laneStatRow(t("lane.pnl"));
  const open = laneStatRow(t("lane.open"));
  const record = laneStatRow(t("lane.record"));
  const watching = laneStatRow(t("lane.watching"));
  const entries = laneStatRow(t("lane.entriesToday"));
  stats.append(balance.row, pnl.row, open.row, record.row, watching.row, entries.row);

  const details = document.createElement("details");
  details.className = "lane-details";
  const summary = document.createElement("summary");
  summary.textContent = t("lane.detailsToggle");
  const thresholds = document.createElement("div");
  thresholds.className = "lane-thresholds";
  const rows = {
    marketCap: thresholdRow(),
    liquidity: thresholdRow(),
    buyers: thresholdRow(),
    pullback: thresholdRow(),
    bounce: thresholdRow(),
    takeProfit: thresholdRow(),
    stopLoss: thresholdRow(),
    buyAmount: thresholdRow(),
  };
  for (const row of Object.values(rows)) thresholds.append(row.row);
  details.append(summary, thresholds);

  card.append(head, task, now, stats, details);
  const refs = { card, name, age, pill, task, nowText, balance, pnl, open, record, watching, entries, summary, rows, stats };
  laneCardRefs.set(id, refs);
  return refs;
}

// The gate that most of a lane's watched coins are stuck on: the useful one-line summary.
function commonStage(candidates, laneId) {
  const counts = new Map();
  for (const candidate of candidates) {
    if (candidate.lane !== laneId) continue;
    const key = candidate.stageKey || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (!best) return "";
  const label = t(`stage.${best}`);
  return label === `stage.${best}` ? t("stage.unknown") : label;
}

function laneNowSentence(lane, laneId, candidates, running) {
  if (!lane?.enabled) return t("lane.now.off");
  if (!running) return t("lane.now.off");
  const open = Number(lane.openPositions ?? 0);
  const watching = Number(lane.activeCandidates ?? 0);
  if (open > 0) return t("lane.now.holding", { positions: tn("frag.positions", open) });
  if (watching > 0) {
    const stage = commonStage(candidates, laneId) || t("stage.unknown");
    return t("lane.now.watching", { coins: tn("frag.coins", watching), stage: stage.toLowerCase() });
  }
  if (!Number(lane.scanned ?? 0)) return t("lane.now.waitingData");
  return t("lane.now.idle");
}

function renderLaneCards(status = {}, runtime = {}) {
  const container = document.querySelector("#laneCards");
  if (!container) return;
  const lanes = status.lanes ?? {};
  const candidates = Array.isArray(status.candidates) ? status.candidates : [];
  const running = runtime.status === "running" || runtime.status === "starting";

  for (const id of LANE_ORDER) {
    const lane = lanes[id];
    let refs = laneCardRefs.get(id);
    if (!refs) {
      refs = buildLaneCard(id);
      container.append(refs.card);
    }
    // Labels are rebuilt on every pass so a language switch needs no special handling.
    refs.name.textContent = t(`lane.${id}.name`);
    refs.age.textContent = t(`lane.${id}.age`);
    refs.task.textContent = t(`lane.${id}.task`);
    refs.summary.textContent = t("lane.detailsToggle");
    refs.balance.caption.firstChild.textContent = t("lane.balance");
    refs.pnl.caption.firstChild.textContent = t("lane.pnl");
    refs.open.caption.firstChild.textContent = t("lane.open");
    refs.record.caption.firstChild.textContent = t("lane.record");
    refs.watching.caption.firstChild.textContent = t("lane.watching");
    refs.entries.caption.firstChild.textContent = t("lane.entriesToday");

    // No lane block at all means the worker has not published a status yet: that is "not started",
    // which is a different thing from a lane the user left out of LANES.
    const enabled = Boolean(lane?.enabled);
    refs.card.classList.toggle("is-off", !enabled);
    refs.pill.textContent = enabled ? t("lane.on") : t("lane.off");
    refs.pill.classList.toggle("is-on", enabled);
    refs.card.classList.toggle("is-live", enabled && running);
    refs.nowText.textContent = !lane
      ? t("lane.now.notStarted")
      : enabled
        ? laneNowSentence(lane, id, candidates, running)
        : t("lane.offReason");

    if (!lane) {
      for (const stat of [refs.balance, refs.pnl, refs.open, refs.record, refs.watching, refs.entries]) {
        setText(stat.value, "—");
        stat.value.classList.remove("positive", "negative");
      }
      refs.card.classList.remove("is-live");
      continue;
    }

    setNumber(refs.balance.value, lane.balanceSol, (n) => fmtSol(n, 4));
    const pnl = Number(lane.realizedPnlSol ?? 0);
    setNumber(refs.pnl.value, pnl, (n) => fmtSolSigned(n, 4));
    refs.pnl.value.classList.toggle("positive", pnl > 0);
    refs.pnl.value.classList.toggle("negative", pnl < 0);
    setNumber(refs.open.value, lane.openPositions, (n) => fmtInt(n));
    setText(refs.record.value, `${fmtInt(lane.wins)} / ${fmtInt(lane.losses)}`);
    setNumber(refs.watching.value, lane.activeCandidates, (n) => fmtInt(n));
    setText(refs.entries.value, `${fmtInt(lane.todayEntries)} / ${fmtInt(lane.thresholds?.maxEntriesPerDay ?? 0)}`);

    const th = lane.thresholds ?? {};
    const pairs = [
      ["marketCap", t("lane.threshold.marketCap"), `${fmtUsd(th.minMarketCapUsd)} – ${fmtUsd(th.maxMarketCapUsd)}`],
      ["liquidity", t("lane.threshold.liquidity"), th.minLiquidityUsd ? fmtUsd(th.minLiquidityUsd) : "—"],
      ["buyers", t("lane.threshold.buyers"), fmtInt(th.minUniqueBuyers)],
      ["pullback", t("lane.threshold.pullback"), fmtPct(th.pullbackPct)],
      ["bounce", t("lane.threshold.bounce"), fmtPct(th.bouncePct)],
      ["takeProfit", t("lane.threshold.takeProfit"), fmtPct(th.takeProfitPct)],
      ["stopLoss", t("lane.threshold.stopLoss"), fmtPct(th.stopLossPct)],
      ["buyAmount", t("lane.threshold.buyAmount"), fmtSol(th.buyAmountSol, 3)],
    ];
    for (const [key, label, value] of pairs) {
      const row = refs.rows[key];
      if (!row) continue;
      setText(row.label, label);
      setText(row.value, value);
    }
  }
}

// One sentence above everything else: the thing a newcomer reads first.
function renderNowHeadline(runtime = {}, status = {}) {
  const element = document.querySelector("#nowSentence");
  if (!element) return;
  const lanes = status.lanes ?? {};
  let positions = 0;
  let watching = 0;
  for (const lane of Object.values(lanes)) {
    positions += Number(lane?.openPositions ?? 0);
    watching += Number(lane?.activeCandidates ?? 0);
  }
  if (!Object.keys(lanes).length) watching = Number(status.activeCount ?? 0);

  let sentence;
  if (runtime.status === "error") sentence = t("now.error");
  else if (runtime.status === "starting") sentence = t("now.starting");
  else if (runtime.status === "stopping") sentence = t("now.stopping");
  else if (runtime.status !== "running") sentence = t("now.stopped");
  else if (!runtime.feedConnected) sentence = t("now.connecting");
  else if (positions > 0 && watching > 0) {
    sentence = t("now.watchingHolding", { positions: tn("frag.positions", positions), coins: tn("frag.coins", watching) });
  } else if (positions > 0) sentence = t("now.holding", { positions: tn("frag.positions", positions) });
  else if (watching > 0) sentence = t("now.watching", { coins: tn("frag.coins", watching) });
  else sentence = t("now.idle");

  setText(element, sentence);
  element.classList.toggle("is-error", runtime.status === "error");
}
