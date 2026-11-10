// Turns one raw log line into a plain-language feed item.
//
// The raw lines are generated from a fixed set of templates in src/index.js and server.js, each
// carrying a stable `[tag]`. We match the tag, pull the numbers back out, and rebuild the sentence
// from the dictionary — so the result is real text in both languages, not translated prose.
//
// humanizeLog(raw) -> { key, params, tone, icon, lane } | null
// null means "technical only": the line still shows under the Technical details toggle.

const LANE_BY_LABEL = { fresh: "fresh", young: "young", veteran: "veteran" };

function shortenMint(value) {
  const text = String(value ?? "");
  if (text.length < 14) return text || "?";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

// displayName() in the worker prints "SYMBOL (mint)" when it knows the symbol, otherwise the mint.
// The trailing group is matched loosely rather than as strict base58: an unexpected character in
// an address should not cost us the symbol, which is the part a reader actually recognises.
function tokenLabel(raw) {
  const text = String(raw ?? "").trim();
  const withSymbol = text.match(/^(.+?)\s+\(([^\s()]{25,60})\)$/);
  if (withSymbol) return withSymbol[1].trim() || shortenMint(withSymbol[2]);
  return shortenMint(text);
}

function laneName(id) {
  return id && LANE_BY_LABEL[id] ? t(`lane.${id}.name`) : "";
}

// "[skip] [young] FOO (mint) rejected: ..." -> { lane: "young", rest: "FOO (mint) rejected: ..." }
function splitLane(rest) {
  const match = String(rest).match(/^\s*\[(fresh|young|veteran)\]\s*(.*)$/i);
  if (!match) return { lane: "", rest: String(rest).trim() };
  return { lane: match[1].toLowerCase(), rest: match[2].trim() };
}

// Maps the English rejection detail produced by the filters onto a reason key in the dictionary.
function reasonKeyFromDetail(detail) {
  const text = String(detail ?? "").toLowerCase();
  if (text.includes("market cap")) return "market_cap";
  if (text.startsWith("liquidity") || text.includes(" liquidity ")) return "liquidity";
  if (text.includes("volume")) return "volume";
  if (text.includes("holders own") || text.includes("holders")) return "holders";
  if (text.includes("metadata") || text.includes("twitter") || text.includes("telegram") || text.includes("website")) return "social";
  if (text.includes("dev ") || text.includes("rugged") || text.includes("launched")) return "dev_history";
  if (text.includes("candidate limit")) return "capacity";
  return "unknown";
}

const EXIT_KEY = {
  "take-profit": "ev.exit.takeProfit",
  "stop-loss": "ev.exit.stopLoss",
  "max-hold": "ev.exit.maxHold",
  "max-hold-stale": "ev.exit.stale",
};

// Each matcher: [regex, builder]. The builder gets the match and returns the feed item.
const MATCHERS = [
  // ---------- worker: startup banner ----------
  [/^\[start\] mode=\S+ balance=([\d.]+) SOL buy=([\d.]+) SOL/i, (m) => ({
    key: "ev.start",
    params: { balance: `${Number(m[1]).toFixed(4)} SOL`, buy: `${Number(m[2])} SOL` },
    tone: "info",
    icon: "▶",
  })],
  [/^\[strategy\] pullback=([\d.]+)% bounce=([\d.]+)%/i, (m) => ({
    key: "ev.strategy",
    params: { pullback: m[1], bounce: m[2] },
    tone: "info",
    icon: "⌘",
  })],
  [/^\[pipeline\]/i, () => ({ key: "ev.pipeline", params: {}, tone: "info", icon: "⌗" })],
  [/^\[lanes\] (Fresh|Young|Veteran): (ON|OFF)/i, (m) => {
    const lane = m[1].toLowerCase();
    // No lane badge here: the sentence already names the bot.
    return {
      key: "ev.lanes",
      params: { lane: laneName(lane), state: t(m[2].toUpperCase() === "ON" ? "ev.laneOn" : "ev.laneOff") },
      tone: m[2].toUpperCase() === "ON" ? "info" : "muted",
      icon: "◈",
    };
  }],
  [/^\[discovery\]/i, () => ({ key: "ev.discovery", params: {}, tone: "info", icon: "⌕" })],

  // ---------- worker: feed ----------
  [/^\[feed\] Connected to PumpPortal/i, () => ({ key: "ev.feedConnected", params: {}, tone: "good", icon: "⚡" })],
  [/^\[feed\] Free data mode: DexScreener polling every (\d+)s/i, (m) => ({
    key: "ev.feedFree",
    params: { seconds: m[1] },
    tone: "info",
    icon: "⇄",
  })],
  [/^\[feed\] Disconnected; reconnecting in (\d+)s/i, (m) => ({
    key: "ev.feedDisconnected",
    params: { seconds: m[1] },
    tone: "warn",
    icon: "⚠",
  })],
  [/^\[feed\] subscribeTokenTrade requests sent: (\d+)/i, (m) => ({
    key: "ev.subscriptions",
    params: { count: m[1] },
    tone: "muted",
    icon: "⇉",
  })],
  [/^\[feed\] (?:Failed to send .*?|PumpPortal response.*?): ?(.*)$/i, (m) => ({
    key: "ev.feedError",
    params: { detail: m[1] || "—" },
    tone: "bad",
    icon: "✕",
  })],

  // ---------- worker: per-coin lifecycle ----------
  [/^\[migration\] (.+?)(?: mcap=.*)?$/i, (m) => ({
    key: "ev.migration",
    params: { token: tokenLabel(m[1]) },
    tone: "info",
    icon: "✦",
    lane: "fresh",
  })],
  [/^\[skip\] migrated token (.+?) skipped; active candidate limit \((\d+)\) reached/i, (m) => ({
    key: "ev.skipCapacity",
    params: { token: tokenLabel(m[1]), limit: m[2] },
    tone: "warn",
    icon: "⊘",
  })],
  [/^\[skip\]\s*(.*?) rejected: (.+?)\.?$/i, (m) => {
    const { lane, rest } = splitLane(m[1]);
    return {
      key: "ev.skip",
      params: { token: tokenLabel(rest), reason: t(`reason.${reasonKeyFromDetail(m[2])}`) },
      tone: "muted",
      icon: "⊘",
      lane,
    };
  }],
  [/^\[expire\]\s*(.*?) did not meet entry criteria in time/i, (m) => {
    const { lane, rest } = splitLane(m[1]);
    return {
      key: "ev.expireSimple",
      params: { token: tokenLabel(rest) },
      tone: "muted",
      icon: "⏱",
      lane,
    };
  }],
  [/^\[paper-buy\]\s*(.*?) MC=(\S+) spend=([\d.]+) SOL \| activity=(\d+) trades\/(\d+) buyers/i, (m) => {
    const { lane, rest } = splitLane(m[1]);
    return {
      key: "ev.buy",
      params: {
        token: tokenLabel(rest),
        mc: m[2],
        spend: `${Number(m[3])} SOL`,
        trades: m[4],
        buyers: m[5],
      },
      tone: "good",
      icon: "▲",
      lane,
    };
  }],
  [/^\[exit:([a-z-]+)\]\s*(.*?) MC=(\S+) pnl=([+-]?[\d.]+) SOL/i, (m) => {
    const { lane, rest } = splitLane(m[2]);
    const pnl = Number(m[4]);
    return {
      key: EXIT_KEY[m[1]] ?? "ev.exit.other",
      params: { token: tokenLabel(rest), pnl: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL` },
      tone: pnl >= 0 ? "good" : "bad",
      icon: pnl >= 0 ? "▲" : "▼",
      lane,
    };
  }],
  [/^\[stale\] (.+?) had no fresh price/i, (m) => ({
    key: "ev.stale",
    params: { token: tokenLabel(m[1]) },
    tone: "warn",
    icon: "⚠",
  })],

  // ---------- worker + server: settings and errors ----------
  [/^\[settings\] /i, () => ({ key: "ev.settingsApplied", params: {}, tone: "info", icon: "⌘" })],
  [/^\[settings error\] (.+)$/i, (m) => ({ key: "ev.settingsError", params: { detail: m[1] }, tone: "bad", icon: "✕" })],
  [/^\[start error\] (.+)$/i, (m) => ({ key: "ev.startError", params: { detail: m[1] }, tone: "bad", icon: "✕" })],
  [/^\[worker (?:stderr|error)\] (.+)$/i, (m) => ({ key: "ev.workerError", params: { detail: m[1] }, tone: "bad", icon: "✕" })],

  // ---------- server: lifecycle ----------
  [/^\[web\] /i, () => ({ key: "ev.dashboardReady", params: {}, tone: "muted", icon: "◈" })],
  [/^Memulai scanner/i, () => ({ key: "ev.startRequested", params: {}, tone: "info", icon: "▶" })],
  [/^\[debug\] Bot worker berjalan/i, () => ({ key: "ev.workerStarted", params: {}, tone: "info", icon: "◉" })],
  [/^\[debug\] Perubahan strategi dikirim/i, () => ({ key: "ev.settingsApplied", params: {}, tone: "info", icon: "⌘" })],
  [/^Menghentikan scanner/i, () => ({ key: "ev.stopRequested", params: {}, tone: "warn", icon: "■" })],
  [/^Bot dihentikan\./i, () => ({ key: "ev.stopped", params: {}, tone: "muted", icon: "■" })],
  [/^Bot berhenti karena error/i, () => ({ key: "ev.workerCrashed", params: {}, tone: "bad", icon: "✕" })],
  [/^Paper account direset ke ([\d.]+) SOL/i, (m) => ({
    key: "ev.resetAccount",
    params: { balance: `${Number(m[1])} SOL` },
    tone: "info",
    icon: "↺",
  })],
];

function humanizeLog(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  for (const [pattern, build] of MATCHERS) {
    const match = text.match(pattern);
    if (match) {
      const item = build(match);
      return { lane: "", ...item };
    }
  }
  return null;
}

// Plain sentence for what one coin is waiting on, built from stageKey + the lane's own thresholds.
function humanizeStage(candidate, thresholds = {}) {
  const key = candidate?.stageKey || "unknown";
  const headline = t(`stage.${key}`) === `stage.${key}` ? t("stage.unknown") : t(`stage.${key}`);
  let detail = "";
  if (key === "trades" && thresholds.minTrades) {
    detail = t("stage.detail.trades", { have: candidate.trades ?? 0, need: thresholds.minTrades });
  } else if (key === "buys" && thresholds.minBuys) {
    detail = t("stage.detail.buys", { have: candidate.buys ?? 0, need: thresholds.minBuys });
  } else if (key === "buyers" && thresholds.minUniqueBuyers) {
    detail = t("stage.detail.buyers", { have: candidate.uniqueBuyers ?? 0, need: thresholds.minUniqueBuyers });
  } else if (key === "pullback" && thresholds.pullbackPct) {
    detail = t("stage.detail.pullback", { pct: (thresholds.pullbackPct * 100).toFixed(1) });
  } else if (key === "rebound" && thresholds.bouncePct) {
    detail = t("stage.detail.rebound", { pct: (thresholds.bouncePct * 100).toFixed(1) });
  } else if (key === "score" && thresholds.minScore !== undefined) {
    detail = t("stage.detail.score", { need: thresholds.minScore });
  }
  return { headline, detail, key };
}
