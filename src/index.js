import "dotenv/config";
import fs from "node:fs";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { currentUtcDay, loadState, saveState } from "./state.js";
import { buyerCount, estimateNetProceeds, exitReason, priceFromEvent, shouldEnter, updateLevels } from "./strategy.js";
import { fetchDexSnapshots, fetchSolUsdPrice, fetchUniqueBuyers } from "./pricefeed.js";
import { fetchTokenMetadata, mergeSocials, parseSocials, socialVerdict } from "./social.js";
import { createDevBook } from "./devbook.js";
import { createJournal } from "./journal.js";
import { fetchHolderStats } from "./holders.js";
import { devReason, holderReason, liquidityReason, volumeReason } from "./filters.js";
import { scoreCandidate } from "./analyst.js";
import { AGE_LANE_IDS, LANE_COOLDOWN_MS, LANE_IDS, LANE_LABELS } from "./lanes.js";
import { DISCOVERY_JOBS, assessPool, createBudget, fetchGeckoPools, fetchGeckoPoolsMulti, parseGeckoPool } from "./discovery.js";
import { loadLaneState, saveLaneState } from "./lanestate.js";

let config = loadConfig();
// Three independent paper accounts ("lanes"): fresh (paper-state.json, shown by the current dashboard),
// young and veteran (data/lanes-state.json).
const state = loadState(config.paperStartBalanceSol);
const laneState = loadLaneState(
  Object.fromEntries(AGE_LANE_IDS.map((id) => [id, config.lanes[id].cfg.paperStartBalanceSol])),
  currentUtcDay(),
);
const accounts = { fresh: state, young: laneState.lanes.young, veteran: laneState.lanes.veteran };
const journal = createJournal();
const devBook = createDevBook();
const candidates = new Map(); // mint -> candidate (each has .lane)
const subscribedMints = new Set();
const tokenNames = new Map();
const tokenUris = new Map(); // mint -> metadata uri, remembered from launch events (bounded)
const geckoBudget = createBudget(config.geckoCallsPerMinute); // one budget for every GeckoTerminal call
const funnelByLane = Object.fromEntries(LANE_IDS.map((id) => [id, {}])); // rejection / expiry category -> count
const laneStats = Object.fromEntries(LANE_IDS.map((id) => [id, { scanned: 0, rejected: 0, entered: 0, expired: 0, scored: 0, scoreBlocked: 0 }]));
let socket;
let reconnectTimer;
let reconnectDelayMs = 1000;
let stopping = false;
let stateDirty = false;
let lastStateWriteAt = 0;
let sweepTimer;
let screenerTimer;
let devBookTimer;
let discoveryTimer;
let refreshTimer;
let pollTimer;
let solUsdTimer;
let pollBackoffUntil = 0;
let geckoBackoffUntil = 0;
let lastPollErrorLogAt = 0;
let discoveryJobIndex = 0;
let solUsdPrice = null;
const polledMints = new Set();
const screenerStats = {
  scanned: 0,
  rejected: 0,
  entered: 0,
  expired: 0,
  scored: 0,
  scoreBlocked: 0,
  devUnknown: 0,
  tradeSubscriptionsRequested: 0,
  tradeMessagesReceived: 0,
};
const recentFeedResponses = new Map();

// Launch + migration events are free. The key is only attached when you provide one.
const wsBase = process.env.PUMPPORTAL_WS_URL || "wss://pumpportal.fun/api/data";
const apiUrl = config.apiKey ? `${wsBase}?api-key=${encodeURIComponent(config.apiKey)}` : wsBase;
const haltFile = ".halt";

const cfgFor = (laneId) => (config.lanes[laneId] ?? config.lanes.fresh).cfg;
const laneName = (laneId) => LANE_LABELS[laneId] ?? laneId;

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${message}`);
  if (process.send) process.send({ type: "log", timestamp, message });
}

function persistState() {
  saveState(state);
  saveLaneState(laneState);
  stateDirty = false;
  lastStateWriteAt = Date.now();
}

function rememberScreenedMigration(mint) {
  state.screenedMigrationMints.push(mint);
  if (state.screenedMigrationMints.length > 20_000) {
    state.screenedMigrationMints.splice(0, state.screenedMigrationMints.length - 20_000);
  }
}

function markStateDirty() {
  stateDirty = true;
}

// ---------- Lane helpers ----------
function findPosition(mint) {
  for (const lane of LANE_IDS) {
    const position = accounts[lane].positions[mint];
    if (position) return { lane, position, account: accounts[lane] };
  }
  return null;
}

function countLane(lane) {
  let n = 0;
  for (const candidate of candidates.values()) if (candidate.lane === lane) n += 1;
  return n;
}

function bump(lane, stat) {
  laneStats[lane][stat] += 1;
  if (stat in screenerStats) screenerStats[stat] += 1;
}

function setCooldown(lane, mint, now) {
  const cooldowns = laneState.cooldowns[lane];
  cooldowns[mint] = now;
  const keys = Object.keys(cooldowns);
  if (keys.length > 5000) for (const key of keys.slice(0, 1000)) delete cooldowns[key];
}

function ageLabel(seconds) {
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function screenerNote(level, message, mint = "") {
  if (process.send) {
    process.send({
      type: "screener-debug",
      entry: { timestamp: new Date().toISOString(), level, message, mint },
    });
  }
}

// Counts a rejection in the lane's funnel and writes it to the journal (data/journal.jsonl).
function recordReject(lane, category, mint, detail, extra = {}) {
  funnelByLane[lane][category] = (funnelByLane[lane][category] ?? 0) + 1;
  journal.write({ type: "reject", lane, category, mint, symbol: tokenNames.get(mint)?.symbol ?? "", detail, ...extra });
}

// `key` is a stable id for the gate a candidate is waiting on (used for the funnel);
// `text` is what the dashboard shows.
function candidateStageInfo(candidate) {
  const cfg = cfgFor(candidate.lane);
  if (candidate.blockedReason) return { key: "blocked", text: candidate.blockedReason };
  if (cfg.socialMode !== "off" && socialVerdict(cfg.socialMode, candidate.social) === "unknown") return { key: "social", text: "Menunggu data sosial" };
  if (candidate.noMarketCapData) return { key: "data", text: "Menunggu data market cap" };
  if (candidate.trades < cfg.minTrades) return { key: "trades", text: `Trade ${candidate.trades}/${cfg.minTrades}` };
  if (candidate.buys < cfg.minBuys) return { key: "buys", text: `Buy ${candidate.buys}/${cfg.minBuys}` };
  if (buyerCount(candidate) < cfg.minUniqueBuyers) return { key: "buyers", text: `Buyer unik ${buyerCount(candidate)}/${cfg.minUniqueBuyers}` };
  if (!candidate.pulledBack) return { key: "pullback", text: `Menunggu pullback ${(cfg.pullbackPct * 100).toFixed(1)}%` };
  const rebound = candidate.lowMarketCapUsd > 0
    ? ((candidate.currentMarketCapUsd / candidate.lowMarketCapUsd) - 1) * 100
    : 0;
  if (rebound < cfg.bouncePct * 100) return { key: "rebound", text: `Menunggu pantulan ${rebound.toFixed(1)}/${(cfg.bouncePct * 100).toFixed(1)}%` };
  if (cfg.solanaRpcUrl && candidate.holders?.status !== "ok") {
    return { key: "holders", text: candidate.holders?.status === "error" ? "Data holder gagal; mencoba lagi" : "Menunggu data holder" };
  }
  if (candidate.scoreBlocked) return { key: "score", text: `Skor ${candidate.score.toFixed(2)} < ${cfg.minScore}` };
  return { key: "signal", text: "Sinyal entry; cek batas risiko" };
}

// The thresholds the dashboard needs to explain, in plain language, what a lane is waiting for.
// Prose belongs in the UI dictionary, so the numbers are published raw.
function laneThresholds(id) {
  const c = cfgFor(id);
  return {
    minMarketCapUsd: c.minMarketCapUsd,
    maxMarketCapUsd: c.maxMarketCapUsd,
    minLiquidityUsd: c.minLiquidityUsd,
    minVolumeH1Usd: c.minVolumeH1Usd,
    minTrades: c.minTrades,
    minBuys: c.minBuys,
    minUniqueBuyers: c.minUniqueBuyers,
    maxCandidateAgeSeconds: c.maxCandidateAgeSeconds,
    pullbackPct: c.pullbackPct,
    bouncePct: c.bouncePct,
    takeProfitPct: c.takeProfitPct,
    stopLossPct: c.stopLossPct,
    maxHoldSeconds: c.maxHoldSeconds,
    minScore: c.minScore,
    maxOpenPositions: c.maxOpenPositions,
    maxEntriesPerDay: c.maxEntriesPerDay,
    maxActiveCandidates: c.maxActiveCandidates,
    buyAmountSol: c.buyAmountSol,
    socialMode: c.socialMode,
  };
}

function laneSummary(id) {
  const account = accounts[id];
  let wins = 0;
  let losses = 0;
  let realizedPnlSol = 0;
  for (const trade of account.closedTrades) {
    if (trade.pnlSol > 0) wins += 1;
    else if (trade.pnlSol < 0) losses += 1;
    realizedPnlSol += Number(trade.pnlSol) || 0;
  }
  return {
    label: laneName(id),
    enabled: config.lanes[id].enabled,
    minAgeSeconds: config.lanes[id].minAgeSeconds ?? null,
    maxAgeSeconds: config.lanes[id].maxAgeSeconds ?? null,
    thresholds: laneThresholds(id),
    balanceSol: account.balanceSol,
    startBalanceSol: account.startBalanceSol ?? cfgFor(id).paperStartBalanceSol,
    openPositions: Object.keys(account.positions).length,
    closedTrades: account.closedTrades.length,
    wins,
    losses,
    realizedPnlSol,
    todayPnlSol: account.daily?.realizedPnlSol ?? 0,
    todayEntries: account.daily?.entries ?? 0,
    activeCandidates: countLane(id),
    ...laneStats[id],
    funnel: { ...funnelByLane[id] },
  };
}

function publishScreenerStatus() {
  if (!process.send) return;
  const activeCandidates = Array.from(candidates.values()).slice(-40).map((candidate) => {
    const stage = candidateStageInfo(candidate);
    return {
      mint: candidate.mint,
      lane: candidate.lane,
      name: candidate.name,
      symbol: candidate.symbol,
      dataSource: config.dataSource,
      currentPrice: candidate.currentPrice,
      currentMarketCapUsd: candidate.currentMarketCapUsd,
      peakMarketCapUsd: candidate.peakMarketCapUsd,
      lowMarketCapUsd: candidate.lowMarketCapUsd,
      trades: candidate.trades,
      buys: candidate.buys,
      uniqueBuyers: buyerCount(candidate),
      liquidityUsd: candidate.liquidityUsd ?? null,
      tokenAgeSeconds: candidate.tokenAgeSeconds,
      ageSeconds: Math.floor((Date.now() - candidate.createdAt) / 1000),
      stage: candidate.lane === "fresh" ? stage.text : `[${laneName(candidate.lane)}] ${stage.text}`,
      // stageKey is the stable gate id; the dashboard turns it into a plain sentence per language.
      stageKey: stage.key,
      score: candidate.score ?? null,
      lastTradeAt: candidate.lastTradeAt ?? candidate.createdAt,
    };
  });
  const combinedFunnel = {};
  for (const id of LANE_IDS) {
    for (const [category, count] of Object.entries(funnelByLane[id])) combinedFunnel[category] = (combinedFunnel[category] ?? 0) + count;
  }
  process.send({
    type: "screener-status",
    status: {
      scanned: screenerStats.scanned,
      rejected: screenerStats.rejected,
      entered: screenerStats.entered,
      expired: screenerStats.expired,
      scored: screenerStats.scored,
      scoreBlocked: screenerStats.scoreBlocked,
      devUnknown: screenerStats.devUnknown,
      funnel: combinedFunnel,
      lanes: Object.fromEntries(LANE_IDS.map((id) => [id, laneSummary(id)])),
      geckoCallsLastMinute: geckoBudget.used(),
      holderCheck: Boolean(config.solanaRpcUrl),
      tradeSubscriptionsRequested: screenerStats.tradeSubscriptionsRequested,
      tradeMessagesReceived: screenerStats.tradeMessagesReceived,
      activeCount: candidates.size,
      maxActive: config.maxActiveCandidates,
      candidates: activeCandidates,
      updatedAt: new Date().toISOString(),
    },
  });
}

function displayName(mint) {
  const info = tokenNames.get(mint) ?? findPosition(mint)?.position ?? {};
  return info.symbol ? `${info.symbol} (${mint})` : mint;
}

function send(payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    log(`[feed] Failed to send ${payload.method ?? "message"}: ${error.message}`);
    return false;
  }
}

function subscribeMint(mint) {
  if (config.tradeSource === "free") return; // free mode polls DexScreener instead of paid trade streams
  if (subscribedMints.has(mint)) return;
  if (!send({ method: "subscribeTokenTrade", keys: [mint] })) return;
  subscribedMints.add(mint);
  screenerStats.tradeSubscriptionsRequested += 1;
  if (screenerStats.tradeSubscriptionsRequested === 1 || screenerStats.tradeSubscriptionsRequested % 50 === 0) {
    log(`[feed] subscribeTokenTrade requests sent: ${screenerStats.tradeSubscriptionsRequested}.`);
  }
}

function unsubscribeMint(mint) {
  if (config.tradeSource === "free") return;
  if (!subscribedMints.has(mint)) return;
  subscribedMints.delete(mint);
  send({ method: "unsubscribeTokenTrade", keys: [mint] });
}

function resetDailyCountersIfNeeded(account) {
  const today = currentUtcDay();
  if (account.daily?.day !== today) {
    account.daily = { day: today, entries: 0, realizedPnlSol: 0 };
    persistState();
  }
}

function rememberTokenMetadata(event) {
  const mint = typeof event.mint === "string" ? event.mint : "";
  if (!mint) return;

  if (typeof event.uri === "string" && event.uri) {
    tokenUris.set(mint, event.uri);
    if (tokenUris.size > 80_000) tokenUris.delete(tokenUris.keys().next().value);
  }
  // The launch event carries the creator wallet; the dev book uses it to remember who launched what.
  if (typeof event.traderPublicKey === "string" && event.traderPublicKey) devBook.recordLaunch(event.traderPublicKey, mint);
  const existing = tokenNames.get(mint) ?? {};
  const name = typeof event.name === "string" ? event.name.slice(0, 80) : existing.name ?? "";
  const symbol = typeof event.symbol === "string" ? event.symbol.slice(0, 24) : existing.symbol ?? "";
  if (name || symbol) tokenNames.set(mint, { name, symbol });
  if (tokenNames.size > 10_000) tokenNames.delete(tokenNames.keys().next().value);
}

function makeCandidate({ lane, mint, name, symbol, pool, price, marketCapUsd, liquidityUsd = null, buyers = null, tokenAgeSeconds = null }) {
  return {
    mint,
    lane,
    name,
    symbol,
    createdAt: Date.now(),
    tokenAgeSeconds,
    trades: 0,
    buys: 0,
    buyers: new Set(),
    buyersOverride: buyers,
    currentPrice: price,
    currentMarketCapUsd: marketCapUsd,
    initialMarketCapChecked: marketCapUsd !== null,
    peakMarketCapUsd: marketCapUsd,
    lowMarketCapUsd: marketCapUsd,
    pulledBack: false,
    liquidityUsd,
    volumeH1Usd: null,
    holders: null,
    score: null,
    scoreBlocked: false,
    scoreCounted: false,
    scoreBlockedCounted: false,
    social: null,
    socialTried: false,
    pool,
  };
}

function onMigration(event) {
  const mint = typeof event.mint === "string" ? event.mint : "";
  if (!config.lanes.fresh.enabled) return;
  if (!mint || state.screenedMigrationMints.includes(mint) || findPosition(mint) || candidates.has(mint)) return;
  const cfg = cfgFor("fresh");
  bump("fresh", "scanned");
  devBook.recordMigration(mint);

  const firstPrice = priceFromEvent(event);
  const firstMarketCapUsd = firstPrice !== null && Number.isFinite(solUsdPrice) ? firstPrice * solUsdPrice : null;
  const info = tokenNames.get(mint) ?? {};
  const name = typeof event.name === "string" ? event.name.slice(0, 80) : info.name ?? "";
  const symbol = typeof event.symbol === "string" ? event.symbol.slice(0, 24) : info.symbol ?? "";
  if (firstMarketCapUsd !== null && (firstMarketCapUsd < cfg.minMarketCapUsd || firstMarketCapUsd > cfg.maxMarketCapUsd)) {
    bump("fresh", "rejected");
    rememberScreenedMigration(mint);
    markStateDirty();
    recordReject("fresh", "market_cap", mint, `market cap ${formatUsd(firstMarketCapUsd)} outside ${formatUsd(cfg.minMarketCapUsd)}-${formatUsd(cfg.maxMarketCapUsd)}`);
    screenerNote("filtered", `Dilewati: market cap ${formatUsd(firstMarketCapUsd)} di luar range ${formatUsd(cfg.minMarketCapUsd)}–${formatUsd(cfg.maxMarketCapUsd)}.`, mint);
    publishScreenerStatus();
    return;
  }

  // Dev history is a cheap local lookup, so it runs before anything that costs an API call.
  const dev = devBook.assess(mint, cfg);
  if (dev.verdict === "unknown") screenerStats.devUnknown += 1;
  const devRejection = devReason(dev);
  if (devRejection) {
    bump("fresh", "rejected");
    rememberScreenedMigration(mint);
    markStateDirty();
    recordReject("fresh", "dev_history", mint, devRejection, { launches: dev.launches, migrated: dev.migrated, rugs: dev.rugs });
    log(`[skip] ${displayName(mint)} rejected: ${devRejection}.`);
    screenerNote("filtered", `Ditolak: riwayat dev buruk (${devRejection}).`, mint);
    publishScreenerStatus();
    return;
  }

  if (countLane("fresh") >= cfg.maxActiveCandidates) {
    bump("fresh", "rejected");
    rememberScreenedMigration(mint);
    markStateDirty();
    recordReject("fresh", "capacity", mint, `active candidate limit ${cfg.maxActiveCandidates} reached`);
    log(`[skip] migrated token ${mint} skipped; active candidate limit (${cfg.maxActiveCandidates}) reached.`);
    screenerNote("filtered", `Dilewati: kapasitas screening ${cfg.maxActiveCandidates} kandidat penuh.`, mint);
    publishScreenerStatus();
    return;
  }

  if (name || symbol) tokenNames.set(mint, { name, symbol });
  candidates.set(mint, makeCandidate({
    lane: "fresh",
    mint,
    name,
    symbol,
    pool: String(event.pool ?? event.poolAddress ?? event.newPool ?? event.new_pool ?? ""),
    price: firstPrice,
    marketCapUsd: firstMarketCapUsd,
  }));
  rememberScreenedMigration(mint);
  markStateDirty();
  subscribeMint(mint);
  resolveSocial(candidates.get(mint));
  log(`[migration] ${displayName(mint)}${firstMarketCapUsd ? ` mcap=${formatUsd(firstMarketCapUsd)}` : ""}`);
  screenerNote("candidate", `Migrasi ke pool AMM terdeteksi; mulai screening trade ${symbol || mint}.`, mint);
  publishScreenerStatus();
}

function formatUsd(value) {
  return Number.isFinite(value)
    ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "—";
}

function closePaperPosition(mint, price, marketCapUsd, reason) {
  const found = findPosition(mint);
  if (!found) return;
  const { lane, position, account } = found;
  const cfg = cfgFor(lane);
  const proceedsSol = estimateNetProceeds(position, price, cfg);
  const pnlSol = proceedsSol - position.costSol;
  account.balanceSol += proceedsSol;
  account.daily.realizedPnlSol += pnlSol;
  account.closedTrades.push({
    mint,
    lane,
    name: position.name,
    symbol: position.symbol,
    dataSource: position.dataSource,
    openedAt: position.openedAt,
    closedAt: Date.now(),
    entryPrice: position.entryPrice,
    exitPrice: price,
    entryMarketCapUsd: position.entryMarketCapUsd ?? null,
    exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
    costSol: position.costSol,
    proceedsSol,
    pnlSol,
    reason,
  });
  const cap = lane === "fresh" ? 5000 : 2000;
  if (account.closedTrades.length > cap) account.closedTrades.splice(0, account.closedTrades.length - cap);
  delete account.positions[mint];
  persistState();
  const exitCap = Number.isFinite(marketCapUsd) ? formatUsd(marketCapUsd) : formatUsd(position.lastMarketCapUsd);
  journal.write({
    type: "exit",
    lane,
    mint,
    symbol: position.symbol,
    reason,
    pnlSol: Number(pnlSol.toFixed(6)),
    heldSeconds: Math.round((Date.now() - position.openedAt) / 1000),
    entryMarketCapUsd: position.entryMarketCapUsd ?? null,
    exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
  });
  log(`[exit:${reason}]${lane === "fresh" ? "" : ` [${lane}]`} ${displayName(mint)} MC=${exitCap} pnl=${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL | balance=${account.balanceSol.toFixed(5)} SOL`);
  screenerNote("exit", `Paper exit ${reason} (${laneName(lane)}) pada market cap ${exitCap}; estimasi PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL.`, mint);
  unsubscribeMint(mint);
  publishScreenerStatus();
}

function openPaperPosition(candidate, price, marketCapUsd) {
  const lane = candidate.lane;
  const cfg = cfgFor(lane);
  const account = accounts[lane];
  resetDailyCountersIfNeeded(account);
  let blockedReason = "";
  if (fs.existsSync(haltFile)) blockedReason = "Entry tertahan: file .halt aktif";
  else if (account.daily.entries >= cfg.maxEntriesPerDay) blockedReason = `Entry tertahan: batas harian ${cfg.maxEntriesPerDay} tercapai`;
  else if (Object.keys(account.positions).length >= cfg.maxOpenPositions) blockedReason = `Entry tertahan: batas ${cfg.maxOpenPositions} posisi terbuka`;
  else if (account.balanceSol < cfg.buyAmountSol) blockedReason = "Entry tertahan: saldo paper tidak cukup";
  else if (account.daily.realizedPnlSol <= -cfg.maxDailyLossSol && cfg.maxDailyLossSol > 0) blockedReason = `Entry tertahan: batas rugi harian ${cfg.maxDailyLossSol} SOL tercapai`;
  if (blockedReason) {
    if (candidate.blockedReason !== blockedReason) {
      candidate.blockedReason = blockedReason;
      screenerNote("blocked", `${blockedReason}; kandidat tetap dipantau.`, candidate.mint);
      publishScreenerStatus();
    }
    return false;
  }
  candidate.blockedReason = "";

  const fee = cfg.paperFeeBps / 10_000;
  const slippage = cfg.paperSlippageBps / 10_000;
  const fillPrice = price * (1 + slippage);
  const tokenQuantity = (cfg.buyAmountSol * (1 - fee)) / fillPrice;
  const info = tokenNames.get(candidate.mint) ?? {};
  const position = {
    mint: candidate.mint,
    lane,
    name: info.name ?? "",
    symbol: info.symbol ?? "",
    openedAt: Date.now(),
    entryPrice: price,
    lastPrice: price,
    entryMarketCapUsd: marketCapUsd,
    lastMarketCapUsd: marketCapUsd,
    lastPriceAt: Date.now(),
    costSol: cfg.buyAmountSol,
    tokenQuantity,
    dataSource: config.dataSource,
  };
  account.balanceSol -= cfg.buyAmountSol;
  account.daily.entries += 1;
  account.positions[candidate.mint] = position;
  candidates.delete(candidate.mint);
  persistState();
  journal.write({
    type: "entry",
    lane,
    mint: candidate.mint,
    symbol: info.symbol ?? "",
    tokenAgeSeconds: candidate.tokenAgeSeconds,
    marketCapUsd,
    trades: candidate.trades,
    buys: candidate.buys,
    buyers: buyerCount(candidate),
    liquidityUsd: candidate.liquidityUsd,
    volumeH1Usd: candidate.volumeH1Usd,
    ...candidate.entryAnalysis,
  });
  log(`[paper-buy]${lane === "fresh" ? "" : ` [${lane}]`} ${displayName(candidate.mint)} MC=${formatUsd(marketCapUsd)} spend=${cfg.buyAmountSol.toFixed(5)} SOL | activity=${candidate.trades} trades/${buyerCount(candidate)} buyers${Number.isFinite(candidate.score) ? ` | score=${candidate.score.toFixed(2)}` : ""}`);
  bump(lane, "entered");
  screenerNote("entry", `Sinyal terpenuhi (${laneName(lane)}); paper entry ${candidate.symbol || candidate.mint} pada market cap ${formatUsd(marketCapUsd)}.`, candidate.mint);
  publishScreenerStatus();
  return true;
}

function onTokenTrade(event) {
  const mint = typeof event.mint === "string" ? event.mint : "";
  if (!mint) return;
  const price = priceFromEvent(event);
  if (price === null) return;
  applyUpdate(mint, price, Number.isFinite(solUsdPrice) ? price * solUsdPrice : null, Date.now(), {
    kind: "trade",
    txType: String(event.txType ?? "").toLowerCase(),
    buyer: typeof event.traderPublicKey === "string" ? event.traderPublicKey : "",
  });
}

function expireCandidate(mint, candidate) {
  candidates.delete(mint);
  bump(candidate.lane, "expired");
  if (!findPosition(mint)) unsubscribeMint(mint);
  const stage = candidateStageInfo(candidate);
  recordReject(candidate.lane, `expired:${stage.key}`, mint, stage.text, { peakMarketCapUsd: candidate.peakMarketCapUsd, marketCapUsd: candidate.currentMarketCapUsd });
  log(`[expire]${candidate.lane === "fresh" ? "" : ` [${candidate.lane}]`} ${displayName(mint)} did not meet entry criteria in time.`);
  screenerNote("expired", `Waktu screening habis (${laneName(candidate.lane)}); tahap terakhir: ${stage.text}.`, mint);
}

function rejectCandidate(candidate, category, detail, message) {
  candidates.delete(candidate.mint);
  bump(candidate.lane, "rejected");
  unsubscribeMint(candidate.mint);
  recordReject(candidate.lane, category, candidate.mint, detail);
  log(`[skip]${candidate.lane === "fresh" ? "" : ` [${candidate.lane}]`} ${displayName(candidate.mint)} rejected: ${detail}.`);
  screenerNote("filtered", message ?? `Ditolak: ${detail}.`, candidate.mint);
  publishScreenerStatus();
}

// A token that collapses by RUG_DROP_PCT from its observed peak while being screened counts
// as a rug against its creator (once per token).
function noteRugIfCollapsed(candidate) {
  const cfg = cfgFor(candidate.lane);
  if (!(candidate.peakMarketCapUsd > 0) || !Number.isFinite(candidate.currentMarketCapUsd)) return;
  if (candidate.currentMarketCapUsd <= candidate.peakMarketCapUsd * (1 - cfg.rugDropPct) && devBook.recordRug(candidate.mint)) {
    journal.write({ type: "rug", lane: candidate.lane, mint: candidate.mint, peakMarketCapUsd: candidate.peakMarketCapUsd, marketCapUsd: candidate.currentMarketCapUsd });
  }
}

function requestHolders(candidate) {
  const cfg = cfgFor(candidate.lane);
  const holders = candidate.holders;
  if (holders?.status === "pending") return;
  if (holders?.status === "error" && Date.now() < holders.retryAt) return;
  candidate.holders = { status: "pending" };
  fetchHolderStats(candidate.mint, cfg.solanaRpcUrl, {
    topCount: cfg.topHoldersCount,
    skipLargest: cfg.topHoldersSkipLargest,
  })
    .then((stats) => {
      candidate.holders = { status: "ok", ...stats };
      journal.write({ type: "holders", lane: candidate.lane, mint: candidate.mint, ...stats });
    })
    .catch((error) => {
      candidate.holders = { status: "error", retryAt: Date.now() + (error.rateLimited ? 30_000 : 10_000) };
      pollLog(`[holders] check failed for ${candidate.mint.slice(0, 6)}..: ${error.message}`);
    });
}

// Gates that run only once a candidate already has an entry signal, cheapest first, so paid or
// rate-limited lookups (holders RPC) are never spent on tokens that would not be bought anyway.
// Returns true when the candidate may be bought now.
function passesEntryPipeline(candidate) {
  const cfg = cfgFor(candidate.lane);
  const dev = devBook.assess(candidate.mint, cfg);
  const devRejection = devReason(dev);
  if (devRejection) {
    rejectCandidate(candidate, "dev_history", devRejection, `Ditolak: riwayat dev buruk (${devRejection}).`);
    return false;
  }

  const liquidityRejection = liquidityReason(candidate, cfg);
  if (liquidityRejection) {
    rejectCandidate(candidate, "liquidity", liquidityRejection, `Ditolak: likuiditas terlalu kecil (${liquidityRejection}).`);
    return false;
  }

  const volumeRejection = volumeReason(candidate, cfg);
  if (volumeRejection) {
    rejectCandidate(candidate, "volume", volumeRejection, `Ditolak: volume 1 jam terlalu kecil (${volumeRejection}).`);
    return false;
  }

  if (cfg.solanaRpcUrl) {
    if (candidate.holders?.status !== "ok") {
      requestHolders(candidate); // result is picked up on a later update
      return false;
    }
    const holderRejection = holderReason(candidate.holders, cfg);
    if (holderRejection) {
      rejectCandidate(candidate, "holders", holderRejection, `Ditolak: holder terlalu terkonsentrasi (${holderRejection}).`);
      return false;
    }
  }

  const { score, parts } = scoreCandidate(candidate, cfg, { dev, holders: candidate.holders });
  candidate.score = score;
  if (!candidate.scoreCounted) {
    candidate.scoreCounted = true;
    bump(candidate.lane, "scored");
  }
  if (score < cfg.minScore) {
    candidate.scoreBlocked = true;
    if (!candidate.scoreBlockedCounted) {
      candidate.scoreBlockedCounted = true;
      bump(candidate.lane, "scoreBlocked");
      journal.write({ type: "score_block", lane: candidate.lane, mint: candidate.mint, symbol: candidate.symbol, score, minScore: cfg.minScore, parts });
      screenerNote("blocked", `Skor ${score.toFixed(2)} di bawah batas ${cfg.minScore}; kandidat tetap dipantau.`, candidate.mint);
    }
    return false;
  }
  candidate.scoreBlocked = false;
  candidate.entryAnalysis = {
    score,
    parts,
    dev: dev.verdict,
    topHoldersPct: candidate.holders?.status === "ok" ? candidate.holders.topPct : null,
  };
  return true;
}

// Shared by both data sources. activity.kind === "trade"    -> one PumpPortal trade event
//                               activity.kind === "snapshot" -> polled DexScreener totals
function applyUpdate(mint, price, marketCapUsd, now, activity) {
  const candidate = candidates.get(mint);
  if (candidate) {
    const cfg = cfgFor(candidate.lane);
    candidate.currentPrice = price;
    candidate.noMarketCapData = false;
    if (!Number.isFinite(marketCapUsd) && Number.isFinite(solUsdPrice)) marketCapUsd = price * solUsdPrice;
    if (Number.isFinite(marketCapUsd)) candidate.currentMarketCapUsd = marketCapUsd;
    if (activity.kind === "trade") candidate.lastTradeAt = now;
    if (now - candidate.createdAt > cfg.maxCandidateAgeSeconds * 1000) {
      expireCandidate(mint, candidate);
    } else {
      if (activity.kind === "trade") {
        candidate.trades += 1;
        if (activity.txType === "buy") {
          candidate.buys += 1;
          if (activity.buyer) candidate.buyers.add(activity.buyer);
        }
      } else if (activity.rolling) {
        // Rolling window (last hour): the current value is the truth, it can go down as well as up.
        if (activity.trades > candidate.trades) candidate.lastTradeAt = now;
        candidate.trades = activity.trades;
        candidate.buys = activity.buys;
      } else {
        if (activity.trades > candidate.trades) candidate.lastTradeAt = now;
        candidate.trades = Math.max(candidate.trades, activity.trades);
        candidate.buys = Math.max(candidate.buys, activity.buys);
      }
      if (Number.isFinite(candidate.currentMarketCapUsd)) {
        updateLevels(candidate, candidate.currentMarketCapUsd, cfg);
        noteRugIfCollapsed(candidate);
      }

      if (!candidate.initialMarketCapChecked && Number.isFinite(candidate.currentMarketCapUsd)) {
        candidate.initialMarketCapChecked = true;
        const initialCap = candidate.currentMarketCapUsd;
        if (initialCap < cfg.minMarketCapUsd || initialCap > cfg.maxMarketCapUsd) {
          candidates.delete(mint);
          bump(candidate.lane, "rejected");
          unsubscribeMint(mint);
          recordReject(candidate.lane, "market_cap", mint, `market cap ${formatUsd(initialCap)} outside ${formatUsd(cfg.minMarketCapUsd)}-${formatUsd(cfg.maxMarketCapUsd)}`);
          screenerNote("filtered", `Dilewati: market cap ${formatUsd(initialCap)} di luar range ${formatUsd(cfg.minMarketCapUsd)}–${formatUsd(cfg.maxMarketCapUsd)}.`, mint);
          publishScreenerStatus();
        }
      }
      if (candidates.has(mint) && shouldEnter(candidate, candidate.currentMarketCapUsd, cfg) && socialAllows(candidate) && passesEntryPipeline(candidate)) {
        openPaperPosition(candidate, price, candidate.currentMarketCapUsd);
      }
    }
  }

  const found = findPosition(mint);
  if (found) {
    const { position, lane } = found;
    position.lastPrice = price;
    if (Number.isFinite(marketCapUsd)) position.lastMarketCapUsd = marketCapUsd;
    position.lastPriceAt = now;
    const reason = exitReason(position, price, now, cfgFor(lane));
    if (reason) closePaperPosition(mint, price, marketCapUsd, reason);
    else markStateDirty();
  }
}

// ---------- Social filter ----------
async function resolveSocial(candidate) {
  const cfg = candidate ? cfgFor(candidate.lane) : null;
  if (!candidate || cfg.socialMode === "off" || candidate.socialTried) return;
  candidate.socialTried = true;
  const uri = tokenUris.get(candidate.mint);
  if (!uri) return; // launch not seen by this bot; DexScreener info may still fill it in later
  try {
    const meta = await fetchTokenMetadata(uri, fetch, config.metadataHosts);
    candidate.social = mergeSocials(candidate.social, parseSocials(meta) ?? { twitter: "", telegram: "", website: "" });
    publishScreenerStatus();
  } catch (error) {
    if (error.permanent) {
      // e.g. host not on the allowlist: retrying cannot help. Leave the social data unknown;
      // in free mode DexScreener may still fill it in.
      pollLog(`[social] metadata skipped for ${candidate.mint.slice(0, 6)}..: ${error.message}`);
      return;
    }
    candidate.socialTried = false; // allow a retry on a later poll
    candidate.socialRetryAt = Date.now() + 10_000;
    pollLog(`[social] metadata fetch failed for ${candidate.mint.slice(0, 6)}..: ${error.message}`);
  }
}

// true = allowed to enter. "fail" removes the candidate right away; "unknown" keeps waiting.
function socialAllows(candidate) {
  const cfg = cfgFor(candidate.lane);
  if (cfg.socialMode === "off") return true;
  const verdict = socialVerdict(cfg.socialMode, candidate.social);
  if (verdict === "pass") return true;
  if (verdict === "fail") {
    const requirement = cfg.socialMode === "twitter"
      ? "tautan X/Twitter"
      : cfg.socialMode === "multiple" ? "minimal dua jenis tautan sosial" : "minimal satu tautan sosial";
    rejectCandidate(candidate, "social", `missing ${requirement} in token metadata`, `Ditolak: perlu ${requirement} di metadata token.`);
  } else if (!candidate.socialTried && Date.now() >= (candidate.socialRetryAt ?? 0)) {
    resolveSocial(candidate);
  }
  return false;
}

// ---------- Free data source: DexScreener (bulk) + GeckoTerminal (unique buyers, discovery) ----------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pollLog(message) {
  const now = Date.now();
  if (now - lastPollErrorLogAt < 15_000) return;
  lastPollErrorLogAt = now;
  log(message);
}

function handleSnapshot(mint, snap) {
  if (Number.isFinite(snap.solUsd) && snap.solUsd > 0) solUsdPrice = snap.solUsd;
  const candidate = candidates.get(mint);
  const lane = candidate?.lane ?? findPosition(mint)?.lane ?? "fresh";
  const cfg = cfgFor(lane);

  let price = snap.price;
  let marketCapUsd = snap.marketCapUsd;
  if (cfg.useReportedMarketCap) {
    // Older tokens do not have the 1B Pump.fun supply, so use the market cap DexScreener reports. If it
    // is missing, skip the update: mixing two different market-cap definitions would corrupt PnL.
    if (!Number.isFinite(snap.reportedMarketCapUsd) || !(snap.solUsd > 0)) {
      if (candidate) candidate.noMarketCapData = true;
      return;
    }
    marketCapUsd = snap.reportedMarketCapUsd;
    price = marketCapUsd / snap.solUsd;
  }

  if (candidate) {
    candidate.lastPolledAt = Date.now();
    if (snap.pool && candidate.lane === "fresh") candidate.pool = snap.pool;
    if (snap.socials) candidate.social = mergeSocials(candidate.social, snap.socials);
    if (snap.liquidityUsd > 0) candidate.liquidityUsd = snap.liquidityUsd; // 0 means "not reported"
    if (snap.volumeH1 > 0) candidate.volumeH1Usd = snap.volumeH1;
    if (snap.trades > candidate.trades) screenerStats.tradeMessagesReceived += snap.trades - candidate.trades;
    if (!polledMints.has(mint)) {
      polledMints.add(mint);
      screenerStats.tradeSubscriptionsRequested += 1;
    }
  }
  const activity = cfg.activityWindow === "h1"
    ? { kind: "snapshot", trades: snap.tradesH1, buys: snap.buysH1, rolling: true }
    : { kind: "snapshot", trades: snap.trades, buys: snap.buys };
  applyUpdate(mint, price, marketCapUsd, Date.now(), activity);
}

// Fresh lane only: counts unique buyers from the pool's recent trades (one pool per call).
async function checkUniqueBuyers() {
  const now = Date.now();
  if (now < geckoBackoffUntil) return;
  let target = null;
  for (const candidate of candidates.values()) {
    if (candidate.lane !== "fresh") continue;
    const cfg = cfgFor("fresh");
    if (!candidate.pool || candidate.buyers.size >= cfg.minUniqueBuyers) continue;
    if (candidate.trades < cfg.minTrades || candidate.buys < cfg.minBuys) continue;
    if (now - (candidate.lastBuyerCheckAt ?? 0) < config.buyerCheckIntervalMs) continue;
    if (!target || (candidate.lastBuyerCheckAt ?? 0) < (target.lastBuyerCheckAt ?? 0)) target = candidate;
  }
  if (!target) return;
  if (!geckoBudget.tryTake()) return;
  target.lastBuyerCheckAt = now;
  try {
    const buyers = await fetchUniqueBuyers(target.pool, target.createdAt - 10_000);
    for (const wallet of buyers) target.buyers.add(wallet);
  } catch (error) {
    if (error.rateLimited) geckoBackoffUntil = Date.now() + 30_000;
    pollLog(`[feed] GeckoTerminal buyer check failed: ${error.message}`);
  }
}

async function pollOnce() {
  if (Date.now() < pollBackoffUntil) return;
  const now = Date.now();
  const wanted = new Set();
  for (const id of LANE_IDS) for (const mint of Object.keys(accounts[id].positions)) wanted.add(mint); // open positions first
  for (const [mint, candidate] of candidates) {
    if (now - (candidate.lastPolledAt ?? 0) >= cfgFor(candidate.lane).pollIntervalMs) wanted.add(mint);
  }
  const mints = [...wanted].filter((mint) => !mint.startsWith("DEMO-"));
  for (let i = 0; i < mints.length; i += 30) {
    try {
      const snapshots = await fetchDexSnapshots(mints.slice(i, i + 30));
      for (const [mint, snap] of snapshots) handleSnapshot(mint, snap);
    } catch (error) {
      if (error.rateLimited) pollBackoffUntil = Date.now() + 15_000;
      pollLog(`[feed] DexScreener poll failed: ${error.message}`);
      break;
    }
    if (i + 30 < mints.length) await sleep(250); // stay well under the free rate limit
  }
  await checkUniqueBuyers();
}

function startPolling() {
  if (config.tradeSource !== "free") {
    const refreshSolUsd = async () => {
      if (stopping) return;
      try {
        solUsdPrice = await fetchSolUsdPrice();
      } catch (error) {
        pollLog(`[feed] SOL/USD price refresh failed: ${error.message}`);
      }
      if (!stopping) solUsdTimer = setTimeout(refreshSolUsd, 30_000);
    };
    refreshSolUsd();
    return;
  }
  const loop = async () => {
    if (stopping) return;
    try {
      await pollOnce();
    } catch (error) {
      pollLog(`[feed] poll error: ${error.message}`);
    }
    if (!stopping) pollTimer = setTimeout(loop, config.pollIntervalMs);
  };
  pollTimer = setTimeout(loop, 1500);
  log(`[feed] Free data mode: DexScreener polling every ${config.pollIntervalMs / 1000}s (no paid PumpPortal trade stream).`);
}

// ---------- Age lanes: discovery of tokens that are already trading ----------
// Returns true when the pool became a new candidate.
function considerPool(pool, now) {
  const verdict = assessPool(pool, config.lanes);
  if (!verdict) return false;
  const lane = verdict.lane;
  if (candidates.has(pool.mint) || findPosition(pool.mint)) return false;
  if (now - (laneState.cooldowns[lane][pool.mint] ?? 0) < LANE_COOLDOWN_MS[lane]) return false;
  setCooldown(lane, pool.mint, now);
  markStateDirty();
  bump(lane, "scanned");
  if (pool.symbol) tokenNames.set(pool.mint, { name: pool.symbol, symbol: pool.symbol });

  if (verdict.reject) {
    bump(lane, "rejected");
    recordReject(lane, verdict.reject.category, pool.mint, verdict.reject.detail, { tokenAgeSeconds: pool.ageSeconds });
    return false;
  }
  const cfg = cfgFor(lane);
  if (countLane(lane) >= cfg.maxActiveCandidates) {
    bump(lane, "rejected");
    recordReject(lane, "capacity", pool.mint, `active candidate limit ${cfg.maxActiveCandidates} reached`);
    return false;
  }
  const price = pool.marketCapUsd !== null && Number.isFinite(solUsdPrice) ? pool.marketCapUsd / solUsdPrice : null;
  const candidate = makeCandidate({
    lane,
    mint: pool.mint,
    name: pool.symbol,
    symbol: pool.symbol,
    pool: pool.pool,
    price,
    marketCapUsd: pool.marketCapUsd,
    liquidityUsd: pool.liquidityUsd,
    buyers: pool.buyersH1,
    tokenAgeSeconds: pool.ageSeconds,
  });
  candidate.volumeH1Usd = pool.volumeH1Usd;
  candidates.set(pool.mint, candidate);
  log(`[${lane}] Found ${pool.symbol || pool.mint} (age ${ageLabel(pool.ageSeconds)}, mcap ${formatUsd(pool.marketCapUsd)}, liquidity ${formatUsd(pool.liquidityUsd)}); screening it.`);
  screenerNote("candidate", `Token ${laneName(lane)} ditemukan (umur ${ageLabel(pool.ageSeconds)}); mulai screening ${pool.symbol || pool.mint}.`, pool.mint);
  publishScreenerStatus();
  return true;
}

async function discoverOnce() {
  if (Date.now() < geckoBackoffUntil) return;
  if (!geckoBudget.tryTake()) return;
  const job = DISCOVERY_JOBS[discoveryJobIndex % DISCOVERY_JOBS.length];
  discoveryJobIndex += 1;
  let rows;
  try {
    rows = await fetchGeckoPools(job);
  } catch (error) {
    if (error.rateLimited) geckoBackoffUntil = Date.now() + 60_000;
    pollLog(`[discovery] GeckoTerminal ${job.kind} page ${job.page} failed: ${error.message}`);
    return;
  }
  const now = Date.now();
  for (const row of rows) {
    const pool = parseGeckoPool(row, now);
    if (pool) considerPool(pool, now);
  }
}

// Keeps the age-lane candidates' liquidity, volume and 1h unique-buyer count fresh (30 pools per call).
async function refreshAgedCandidates() {
  if (Date.now() < geckoBackoffUntil) return;
  const targets = [];
  for (const candidate of candidates.values()) if (candidate.lane !== "fresh" && candidate.pool) targets.push(candidate);
  if (!targets.length) return;
  targets.sort((a, b) => (a.lastRefreshAt ?? 0) - (b.lastRefreshAt ?? 0));
  const batch = targets.slice(0, 30);
  if (!geckoBudget.tryTake()) return;
  try {
    const rows = await fetchGeckoPoolsMulti(batch.map((candidate) => candidate.pool));
    const byPool = new Map();
    for (const row of rows) {
      const pool = parseGeckoPool(row);
      if (pool?.pool) byPool.set(pool.pool, pool);
    }
    const now = Date.now();
    for (const candidate of batch) {
      candidate.lastRefreshAt = now;
      const pool = byPool.get(candidate.pool);
      if (!pool) continue;
      if (Number.isFinite(pool.buyersH1)) candidate.buyersOverride = pool.buyersH1;
      if (Number.isFinite(pool.liquidityUsd)) candidate.liquidityUsd = pool.liquidityUsd;
      if (Number.isFinite(pool.volumeH1Usd)) candidate.volumeH1Usd = pool.volumeH1Usd;
    }
  } catch (error) {
    if (error.rateLimited) geckoBackoffUntil = Date.now() + 60_000;
    pollLog(`[discovery] GeckoTerminal refresh failed: ${error.message}`);
  }
}

function startDiscovery() {
  const active = AGE_LANE_IDS.filter((id) => config.lanes[id].enabled);
  if (!active.length) return;
  const tick = async () => {
    if (stopping) return;
    try {
      await discoverOnce();
    } catch (error) {
      pollLog(`[discovery] error: ${error.message}`);
    }
    if (!stopping) discoveryTimer = setTimeout(tick, config.discoveryTickMs);
  };
  discoveryTimer = setTimeout(tick, Math.min(5000, config.discoveryTickMs));
  refreshTimer = setInterval(() => {
    refreshAgedCandidates().catch((error) => pollLog(`[discovery] refresh error: ${error.message}`));
  }, config.geckoRefreshMs);
  log(`[discovery] Looking for already-trading tokens (${active.map(laneName).join(" + ")}) via GeckoTerminal: one call every ${config.discoveryTickMs / 1000}s, budget ${config.geckoCallsPerMinute}/min shared with buyer checks.`);
}

function onMessage(data) {
  let event;
  try {
    event = JSON.parse(data.toString());
  } catch {
    log("[feed] Ignored malformed websocket message.");
    return;
  }
  if (!event || typeof event !== "object") return;
  const txType = String(event.txType ?? "").toLowerCase();
  if (txType === "create") rememberTokenMetadata(event);
  else if (
    txType === "migrate"
    || txType === "migration"
    || (
      typeof event.mint === "string"
      && Boolean(event.pool ?? event.poolAddress ?? event.newPool ?? event.new_pool)
      && txType !== "buy"
      && txType !== "sell"
    )
  ) onMigration(event);
  else if (txType === "buy" || txType === "sell") {
    screenerStats.tradeMessagesReceived += 1;
    onTokenTrade(event);
  } else {
    const payload = (config.apiKey ? JSON.stringify(event).replaceAll(config.apiKey, "[API KEY REDACTED]") : JSON.stringify(event)).slice(0, 500);
    const level = /error|failed|unauthorized|\b40[13]\b|insufficient|fund|invalid|denied/i.test(payload) ? "error" : "info";
    const key = `${level}|${payload}`;
    const now = Date.now();
    const previousAt = recentFeedResponses.get(key) ?? 0;
    if (now - previousAt >= 30_000) {
      recentFeedResponses.set(key, now);
      if (recentFeedResponses.size > 100) recentFeedResponses.delete(recentFeedResponses.keys().next().value);
      log(`[feed] PumpPortal response${txType ? ` (${txType})` : ""}: ${payload}`);
      screenerNote(level, `PumpPortal response${txType ? ` (${txType})` : ""}: ${payload}`);
    }
  }
}

function connect() {
  if (stopping) return;
  socket = new WebSocket(apiUrl);
  socket.on("open", () => {
    reconnectDelayMs = 1000;
    subscribedMints.clear();
    send({ method: "subscribeNewToken" });
    send({ method: "subscribeMigration" });
    for (const mint of candidates.keys()) subscribeMint(mint);
    for (const id of LANE_IDS) for (const mint of Object.keys(accounts[id].positions)) subscribeMint(mint);
    if (process.send) process.send({ type: "feed", connected: true, source: "pumpportal" });
    log(`[feed] Connected to PumpPortal; listening for token launches and AMM migrations (trade data: ${config.tradeSource}).`);
  });
  socket.on("message", onMessage);
  socket.on("error", (error) => log(`[feed] ${error.message}`));
  socket.on("close", () => {
    subscribedMints.clear();
    if (process.send) process.send({ type: "feed", connected: false, source: "pumpportal" });
    if (stopping) return;
    log(`[feed] Disconnected; reconnecting in ${reconnectDelayMs / 1000}s.`);
    reconnectTimer = setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  });
}

function sweep() {
  const now = Date.now();
  for (const [mint, candidate] of candidates) {
    if (now - candidate.createdAt > cfgFor(candidate.lane).maxCandidateAgeSeconds * 1000) expireCandidate(mint, candidate);
  }
  for (const lane of LANE_IDS) {
    const cfg = cfgFor(lane);
    for (const [mint, position] of Object.entries(accounts[lane].positions)) {
      if (!Number.isFinite(position.lastPriceAt) || now - position.lastPriceAt > 30_000) {
        // No fresh price (e.g. token not indexed anymore): do not keep a paper position open forever.
        if (Number.isFinite(position.lastPrice) && now - position.openedAt >= cfg.maxHoldSeconds * 3000) {
          log(`[stale] ${displayName(mint)} had no fresh price; closing at last known price.`);
          closePaperPosition(mint, position.lastPrice, position.lastMarketCapUsd, "max-hold-stale");
        }
        continue;
      }
      const reason = exitReason(position, position.lastPrice, now, cfg);
      if (reason) closePaperPosition(mint, position.lastPrice, position.lastMarketCapUsd, reason);
    }
  }
  if (stateDirty && now - lastStateWriteAt >= 5000) persistState();
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(sweepTimer);
  clearInterval(screenerTimer);
  clearInterval(devBookTimer);
  clearInterval(refreshTimer);
  clearTimeout(discoveryTimer);
  clearTimeout(pollTimer);
  clearTimeout(solUsdTimer);
  persistState();
  devBook.save();
  journal.stop();
  socket?.close();
  log("[shutdown] Paper state saved.");
  if (process.connected) process.disconnect();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("message", (message) => {
  if (!message || message.type !== "update-settings" || !message.settings) return;
  try {
    config = loadConfig({
      ...process.env,
      ...message.settings,
      MODE: "paper",
      BOT_FEED_MODE: config.dataSource,
      PUMPPORTAL_API_KEY: config.apiKey,
      TRADE_SOURCE: config.tradeSource,
      SOCIAL_MODE: message.settings.SOCIAL_MODE ?? config.socialMode,
    });
    log("[settings] Strategi diperbarui tanpa restart bot (lane Fresh; lane Young/Veteran memakai env YOUNG_* / VETERAN_*).");
    if (process.send) process.send({ type: "settings-applied" });
  } catch (error) {
    log(`[settings error] ${error.message}`);
    if (process.send) process.send({ type: "settings-error", error: error.message });
  }
});

const fresh = cfgFor("fresh");
log(`[start] mode=${config.mode} balance=${state.balanceSol.toFixed(5)} SOL buy=${fresh.buyAmountSol} SOL MC=${formatUsd(fresh.minMarketCapUsd)}–${formatUsd(fresh.maxMarketCapUsd)} TP=${(fresh.takeProfitPct * 100).toFixed(1)}% SL=${(fresh.stopLossPct * 100).toFixed(1)}%`);
log(`[strategy] pullback=${(fresh.pullbackPct * 100).toFixed(1)}% bounce=${(fresh.bouncePct * 100).toFixed(1)}% | paper fills include ${config.paperFeeBps} bps fee and ${config.paperSlippageBps} bps slippage per side.`);
for (const id of LANE_IDS) {
  const lane = config.lanes[id];
  const status = lane.enabled ? "ON" : lane.requested ? "OFF (needs TRADE_SOURCE=free)" : "OFF";
  const c = lane.cfg;
  log(`[lanes] ${lane.label}: ${status}${lane.enabled ? ` | mcap ${formatUsd(c.minMarketCapUsd)}-${formatUsd(c.maxMarketCapUsd)} | liquidity >= ${formatUsd(c.minLiquidityUsd)} | balance ${accounts[id].balanceSol.toFixed(4)} SOL` : ""}`);
}
log(`[pipeline] dev filter (max ${config.maxDevRugs} rug / ${config.maxDevLaunches} launches) > liquidity > volume > holders ${config.solanaRpcUrl ? `top ${config.topHoldersCount} <= ${config.maxTopHoldersPct}%` : "(off: no SOLANA_RPC_URL)"} > score | journal: data/journal.jsonl`);
for (const id of LANE_IDS) resetDailyCountersIfNeeded(accounts[id]);
journal.start();
devBookTimer = setInterval(() => devBook.save(), 60_000);
connect();
startPolling();
startDiscovery();
sweepTimer = setInterval(sweep, 2000);
screenerTimer = setInterval(publishScreenerStatus, 1000);
if (process.send) process.send({ type: "status", status: "running" });
