// Turns one raw log line into a plain-language feed item.
//
// The raw lines are generated from a fixed set of templates in src/index.js and server.js, each
// carrying a stable `[tag]`. We match the tag, pull the numbers back out, and rebuild the sentence
// from the dictionary — so the result is real text in both languages, not translated prose.
//
// humanizeLog(raw) -> { key, params, tone, icon, bot } | null
// null means "technical only": the line still shows under the Technical details toggle.
// `bot` is which of the three bots the line came from, shown as a badge next to the sentence.

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

// Maps the English detail produced by bot 2's gates onto a reason key in the dictionary.
function reasonKeyFromDetail(detail) {
  const text = String(detail ?? "").toLowerCase();
  if (text.includes("% of market cap")) return "liquidity_ratio";
  if (text.includes("market cap")) return "market_cap";
  if (text.startsWith("liquidity") || text.includes(" liquidity ")) return "liquidity";
  if (text.includes("trades in the last hour")) return "dead";
  if (text.includes("volume")) return "dead_volume";
  if (text.includes("holders own") || text.includes("holders")) return "holders";
  if (text.includes("rugged") || text.includes("launched")) return "dev_history";
  if (text.includes("score")) return "low_score";
  return "unknown";
}

// A bot 2 category, as a sentence. Used by the card list, the funnel panel and the story.
function categoryLabel(category) {
  const key = `reason.${category}`;
  const label = t(key);
  return label === key ? String(category).replaceAll("_", " ") : label;
}

// Which signal carried a coin over the line ("volume waking up", "buyers", ...).
function leadText(lead) {
  const key = `lead.${lead}`;
  const label = t(key);
  return label === key ? String(lead ?? "—") : label;
}

// Number(null) is 0, so an unknown value has to be rejected before it is converted.
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtScore(score) {
  const value = numberOrNull(score);
  return value === null ? "—" : value.toFixed(2);
}

// What bot 3 is waiting for on one coin it may buy, with the level it worked out itself.
function waitingText(coin = {}) {
  const key = `waiting.${coin.waitingFor ?? "unknown"}`;
  const pct = (value) => (Number.isFinite(value) ? (value * 100).toFixed(1) : "—");
  const label = t(key, { dip: pct(coin.dipPct), bounce: pct(coin.bouncePct), vol: pct(coin.volPct) });
  return label === key ? t("waiting.unknown", {}) : label;
}

// Mirrors the error test in src/index.js so the dashboard and the worker never disagree about
// whether a feed message was a failure.
const FEED_ERROR_RE = /error|failed|unauthorized|\b40[13]\b|insufficient|fund|invalid|denied/i;

// Feed payloads arrive as JSON like {"message":"Subscribed to 'migration' events."}. Readers want
// the sentence inside, not the braces.
function payloadMessage(raw) {
  const text = String(raw ?? "").trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const message = parsed.message ?? parsed.error ?? parsed.errors;
      if (typeof message === "string" && message) return message;
      // Some responses carry a list, e.g. {"errors":["Invalid API key"]}.
      if (Array.isArray(message)) {
        const joined = message.filter((part) => typeof part === "string").join("; ");
        if (joined) return joined;
      }
    }
  } catch {
    // not JSON: fall through and use the raw text
  }
  return text;
}

function classifyFeedPayload(raw) {
  const text = String(raw ?? "").trim();
  const message = payloadMessage(text);
  if (FEED_ERROR_RE.test(text)) {
    return { key: "ev.feedError", params: { detail: message || "—" }, tone: "bad", icon: "✕" };
  }
  if (/subscrib\w*.*migration/i.test(message)) {
    return { key: "ev.subMigration", params: {}, tone: "good", icon: "⇉" };
  }
  if (/subscrib\w*.*(token creation|new token)/i.test(message)) {
    return { key: "ev.subNewCoins", params: {}, tone: "good", icon: "⇉" };
  }
  if (/subscrib/i.test(message)) {
    return { key: "ev.subGeneric", params: {}, tone: "good", icon: "⇉" };
  }
  return { key: "ev.feedNotice", params: { detail: message || "—" }, tone: "muted", icon: "·" };
}

const EXIT_KEY = {
  "stop-loss": "ev.exit.stopLoss",
  trail: "ev.exit.trail",
  "trail-locked": "ev.exit.trailLocked",
  stall: "ev.exit.stall",
  breakdown: "ev.exit.breakdown",
  "max-hold": "ev.exit.maxHold",
  "max-hold-stale": "ev.exit.stale",
};

// Each matcher: [regex, builder]. The builder gets the match and returns the feed item.
const MATCHERS = [
  // ---------- worker: startup banner ----------
  [/^\[start\] mode=\S+ paper balance=([\d.]+) SOL, ([\d.]+) SOL per trade/i, (m) => ({
    key: "ev.start",
    params: { balance: `${Number(m[1]).toFixed(4)} SOL`, buy: `${Number(m[2])} SOL` },
    tone: "info",
    icon: "▶",
  })],
  [/^\[pipeline\] bot 2 turns a coin green at score ([\d.]+)/i, (m) => ({
    key: "ev.greenScore",
    params: { score: m[1] },
    tone: "info",
    icon: "⧩",
    bot: "filter",
  })],
  [/^\[pipeline\]/i, () => ({ key: "ev.pipeline", params: {}, tone: "info", icon: "⌗" })],
  [/^\[shutdown\]/i, () => ({ key: "ev.shutdown", params: {}, tone: "muted", icon: "■" })],

  // ---------- bot 1: screening ----------
  [/^\[bot1\] Screening every coin, any age: (\d+) GeckoTerminal pages round-robin every ([\d.]+)s \+ (\d+) coins refreshed every ([\d.]+)s/i, (m) => ({
    key: "ev.bot1.started",
    params: { pages: m[1], seconds: m[2], batch: m[3], refresh: m[4] },
    tone: "info",
    icon: "◎",
    bot: "screener",
  })],
  [/^\[bot1\] (?:sweep|refresh) error: (.+)$/i, (m) => ({
    key: "ev.bot1.error",
    params: { detail: m[1] },
    tone: "warn",
    icon: "⚠",
    bot: "screener",
  })],

  // ---------- bot 2: filtering ----------
  [/^\[bot2\] GREEN (.+?) score=([\d.]+) \(([^,)]+)(?:, volume ([\d.]+)x its normal hour|, ([\d.]+)x the pool traded in an hour)?\) age=(\S+)/i, (m) => ({
    key: m[4] ? "ev.bot2.greenSurge" : m[5] ? "ev.bot2.greenTurnover" : "ev.bot2.green",
    params: { token: tokenLabel(m[1]), score: m[2], reason: leadText(m[3]), times: m[4] ?? m[5] ?? "", age: m[6] },
    tone: "good",
    icon: "⧩",
    bot: "filter",
  })],
  [/^\[bot2\] (.+?) is no longer green: (.+?)\.?$/i, (m) => ({
    key: "ev.bot2.ungreen",
    params: { token: tokenLabel(m[1]), reason: categoryLabel(reasonKeyFromDetail(m[2])) },
    tone: "muted",
    icon: "⊘",
    bot: "filter",
  })],

  // ---------- bot 3: execution ----------
  [/^\[bot3\] BUY (.+?) MC=(\S+) after a ([\d.]+)% dip and a ([\d.]+)% bounce \| stop ([\d.]+)% trail ([\d.]+)% \(this coin moves ~([\d.]+)%\/min\)/i, (m) => ({
    key: "ev.bot3.buy",
    params: { token: tokenLabel(m[1]), mc: m[2], dip: m[3], bounce: m[4], stop: m[5], trail: m[6], vol: m[7] },
    tone: "good",
    icon: "▲",
    bot: "executor",
  })],
  [/^\[bot3\] SELL:([a-z-]+) (.+?) MC=(\S+) pnl=([+-]?[\d.]+) SOL/i, (m) => {
    const pnl = Number(m[4]);
    return {
      key: EXIT_KEY[m[1]] ?? "ev.exit.other",
      params: { token: tokenLabel(m[2]), pnl: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL` },
      tone: pnl >= 0 ? "good" : "bad",
      icon: pnl >= 0 ? "▲" : "▼",
      bot: "executor",
    };
  }],

  // ---------- worker: feed ----------
  [/^\[feed\] PumpPortal connected/i, () => ({ key: "ev.feedConnected", params: {}, tone: "good", icon: "⚡" })],
  [/^\[feed\] PumpPortal disconnected; reconnecting in (\d+)s/i, (m) => ({
    key: "ev.feedDisconnected",
    params: { seconds: m[1] },
    tone: "warn",
    icon: "⚠",
  })],
  [/^\[feed\] Could not subscribe: ?(.*)$/i, (m) => ({
    key: "ev.feedError",
    params: { detail: m[1] || "—" },
    tone: "bad",
    icon: "✕",
  })],
  // The data source answers our subscriptions with plain acknowledgements. Those are successes, so
  // they must never be dressed as errors. Same error test the worker uses to pick its own level.
  [/^\[feed\] PumpPortal response(?: \([^)]*\))?: ?(.*)$/i, (m) => classifyFeedPayload(m[1])],
  // Anything else tagged [feed]: classified the same way rather than dropped from the story.
  [/^\[feed\] (.+)$/i, (m) => classifyFeedPayload(m[1])],

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
      return { bot: "", ...item };
    }
  }
  return null;
}

// How loud a coin's volume is compared with a normal hour for itself, as a short label.
// Whichever volume measure carried the coin: against its own normal hour (a coin waking up), or
// against its own pool (a coin too young to have a normal hour).
function surgeText(coin = {}) {
  const times = (value) => (value >= 10 ? value.toFixed(0) : value.toFixed(1));
  const ratio = numberOrNull(coin.surgeRatio);
  const turns = numberOrNull(coin.turnover);
  if (coin.surgeFrom === "baseline" && ratio !== null) return t("frag.times", { times: times(ratio) });
  if (coin.surgeFrom === "turnover" && turns !== null) return t("frag.timesPool", { times: times(turns) });
  if (ratio !== null) return t("frag.times", { times: times(ratio) });
  return "—";
}
