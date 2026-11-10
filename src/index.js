import "dotenv/config";
import fs from "node:fs";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { currentUtcDay, loadState, saveState } from "./state.js";
import { estimateNetProceeds, exitReason, priceFromEvent, shouldEnter, updateLevels } from "./strategy.js";
import { fetchDexSnapshots, fetchSolUsdPrice, fetchUniqueBuyers } from "./pricefeed.js";
import { fetchTokenMetadata, mergeSocials, parseSocials, socialVerdict } from "./social.js";
import { createDevBook } from "./devbook.js";
import { createJournal } from "./journal.js";
import { fetchHolderStats } from "./holders.js";
import { devReason, holderReason, liquidityReason } from "./filters.js";
import { scoreCandidate } from "./analyst.js";

let config = loadConfig();
const state = loadState(config.paperStartBalanceSol);
const journal = createJournal();
const devBook = createDevBook();
const candidates = new Map();
const subscribedMints = new Set();
const tokenNames = new Map();
const tokenUris = new Map(); // mint -> metadata uri, remembered from launch events (bounded)
const funnel = {}; // rejection / expiry category -> count since this run started
let socket;
let reconnectTimer;
let reconnectDelayMs = 1000;
let stopping = false;
let stateDirty = false;
let lastStateWriteAt = 0;
let sweepTimer;
let screenerTimer;
let devBookTimer;
let pollTimer;
let solUsdTimer;
let pollBackoffUntil = 0;
let geckoBackoffUntil = 0;
let lastPollErrorLogAt = 0;
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

function log(message) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} ${message}`);
  if (process.send) process.send({ type: "log", timestamp, message });
}

function persistState() {
  saveState(state);
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

function screenerNote(level, message, mint = "") {
  if (process.send) {
    process.send({
      type: "screener-debug",
      entry: { timestamp: new Date().toISOString(), level, message, mint },
    });
  }
}

// Counts a rejection in the funnel and writes it to the journal (data/journal.jsonl).
function recordReject(category, mint, detail, extra = {}) {
  funnel[category] = (funnel[category] ?? 0) + 1;
  journal.write({ type: "reject", category, mint, symbol: tokenNames.get(mint)?.symbol ?? "", detail, ...extra });
}

// `key` is a stable id for the gate a candidate is waiting on (used for the funnel);
// `text` is what the dashboard shows.
function candidateStageInfo(candidate) {
  if (candidate.blockedReason) return { key: "blocked", text: candidate.blockedReason };
  if (config.socialMode !== "off" && socialVerdict(config.socialMode, candidate.social) === "unknown") return { key: "social", text: "Menunggu data sosial" };
  if (candidate.trades < config.minTrades) return { key: "trades", text: `Trade ${candidate.trades}/${config.minTrades}` };
  if (candidate.buys < config.minBuys) return { key: "buys", text: `Buy ${candidate.buys}/${config.minBuys}` };
  if (candidate.buyers.size < config.minUniqueBuyers) return { key: "buyers", text: `Buyer unik ${candidate.buyers.size}/${config.minUniqueBuyers}` };
  if (!candidate.pulledBack) return { key: "pullback", text: `Menunggu pullback ${(config.pullbackPct * 100).toFixed(1)}%` };
  const rebound = candidate.lowMarketCapUsd > 0
    ? ((candidate.currentMarketCapUsd / candidate.lowMarketCapUsd) - 1) * 100
    : 0;
  if (rebound < config.bouncePct * 100) return { key: "rebound", text: `Menunggu pantulan ${rebound.toFixed(1)}/${(config.bouncePct * 100).toFixed(1)}%` };
  if (config.solanaRpcUrl && candidate.holders?.status !== "ok") {
    return { key: "holders", text: candidate.holders?.status === "error" ? "Data holder gagal; mencoba lagi" : "Menunggu data holder" };
  }
  if (candidate.scoreBlocked) return { key: "score", text: `Skor ${candidate.score.toFixed(2)} < ${config.minScore}` };
  return { key: "signal", text: "Sinyal entry; cek batas risiko" };
}

function candidateStage(candidate) {
  return candidateStageInfo(candidate).text;
}

function publishScreenerStatus() {
  if (!process.send) return;
  const activeCandidates = Array.from(candidates.values()).slice(-40).map((candidate) => ({
    mint: candidate.mint,
    name: candidate.name,
    symbol: candidate.symbol,
    dataSource: config.dataSource,
    currentPrice: candidate.currentPrice,
    currentMarketCapUsd: candidate.currentMarketCapUsd,
    peakMarketCapUsd: candidate.peakMarketCapUsd,
    lowMarketCapUsd: candidate.lowMarketCapUsd,
    trades: candidate.trades,
    buys: candidate.buys,
    uniqueBuyers: candidate.buyers.size,
    ageSeconds: Math.floor((Date.now() - candidate.createdAt) / 1000),
    stage: candidateStage(candidate),
    score: candidate.score ?? null,
    lastTradeAt: candidate.lastTradeAt ?? candidate.createdAt,
  }));
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
      funnel: { ...funnel },
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
  const info = tokenNames.get(mint) ?? state.positions[mint] ?? {};
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

function resetDailyCountersIfNeeded() {
  const today = currentUtcDay();
  if (state.daily?.day !== today) {
    state.daily = { day: today, entries: 0, realizedPnlSol: 0 };
    saveState(state);
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

function onMigration(event) {
  const mint = typeof event.mint === "string" ? event.mint : "";
  if (!mint || state.screenedMigrationMints.includes(mint) || state.positions[mint] || candidates.has(mint)) return;
  screenerStats.scanned += 1;
  devBook.recordMigration(mint);

  const firstPrice = priceFromEvent(event);
  const firstMarketCapUsd = firstPrice !== null && Number.isFinite(solUsdPrice) ? firstPrice * solUsdPrice : null;
  const info = tokenNames.get(mint) ?? {};
  const name = typeof event.name === "string" ? event.name.slice(0, 80) : info.name ?? "";
  const symbol = typeof event.symbol === "string" ? event.symbol.slice(0, 24) : info.symbol ?? "";
  if (firstMarketCapUsd !== null && (firstMarketCapUsd < config.minMarketCapUsd || firstMarketCapUsd > config.maxMarketCapUsd)) {
    screenerStats.rejected += 1;
    rememberScreenedMigration(mint);
    markStateDirty();
    recordReject("market_cap", mint, `market cap ${formatUsd(firstMarketCapUsd)} outside ${formatUsd(config.minMarketCapUsd)}-${formatUsd(config.maxMarketCapUsd)}`);
    screenerNote("filtered", `Dilewati: market cap ${formatUsd(firstMarketCapUsd)} di luar range ${formatUsd(config.minMarketCapUsd)}–${formatUsd(config.maxMarketCapUsd)}.`, mint);
    publishScreenerStatus();
    return;
  }

  // Dev history is a cheap local lookup, so it runs before anything that costs an API call.
  const dev = devBook.assess(mint, config);
  if (dev.verdict === "unknown") screenerStats.devUnknown += 1;
  const devRejection = devReason(dev);
  if (devRejection) {
    screenerStats.rejected += 1;
    rememberScreenedMigration(mint);
    markStateDirty();
    recordReject("dev_history", mint, devRejection, { launches: dev.launches, migrated: dev.migrated, rugs: dev.rugs });
    log(`[skip] ${displayName(mint)} rejected: ${devRejection}.`);
    screenerNote("filtered", `Ditolak: riwayat dev buruk (${devRejection}).`, mint);
    publishScreenerStatus();
    return;
  }

  if (candidates.size >= config.maxActiveCandidates) {
    screenerStats.rejected += 1;
    rememberScreenedMigration(mint);
    markStateDirty();
    recordReject("capacity", mint, `active candidate limit ${config.maxActiveCandidates} reached`);
    log(`[skip] migrated token ${mint} skipped; active candidate limit (${config.maxActiveCandidates}) reached.`);
    screenerNote("filtered", `Dilewati: kapasitas screening ${config.maxActiveCandidates} kandidat penuh.`, mint);
    publishScreenerStatus();
    return;
  }

  if (name || symbol) tokenNames.set(mint, { name, symbol });
  candidates.set(mint, {
    mint,
    name,
    symbol,
    createdAt: Date.now(),
    trades: 0,
    buys: 0,
    buyers: new Set(),
    currentPrice: firstPrice,
    currentMarketCapUsd: firstMarketCapUsd,
    initialMarketCapChecked: firstMarketCapUsd !== null,
    peakMarketCapUsd: firstMarketCapUsd,
    lowMarketCapUsd: firstMarketCapUsd,
    pulledBack: false,
    liquidityUsd: null,
    holders: null,
    score: null,
    scoreBlocked: false,
    scoreCounted: false,
    scoreBlockedCounted: false,
    social: null,
    socialTried: false,
    pool: String(event.pool ?? event.poolAddress ?? event.newPool ?? event.new_pool ?? ""),
  });
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
  const position = state.positions[mint];
  if (!position) return;
  const proceedsSol = estimateNetProceeds(position, price, config);
  const pnlSol = proceedsSol - position.costSol;
  state.balanceSol += proceedsSol;
  state.daily.realizedPnlSol += pnlSol;
  state.closedTrades.push({
    mint,
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
  if (state.closedTrades.length > 5000) state.closedTrades.splice(0, state.closedTrades.length - 5000);
  delete state.positions[mint];
  persistState();
  const exitCap = Number.isFinite(marketCapUsd) ? formatUsd(marketCapUsd) : formatUsd(position.lastMarketCapUsd);
  journal.write({
    type: "exit",
    mint,
    symbol: position.symbol,
    reason,
    pnlSol: Number(pnlSol.toFixed(6)),
    heldSeconds: Math.round((Date.now() - position.openedAt) / 1000),
    entryMarketCapUsd: position.entryMarketCapUsd ?? null,
    exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
  });
  log(`[exit:${reason}] ${displayName(mint)} MC=${exitCap} pnl=${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL | balance=${state.balanceSol.toFixed(5)} SOL`);
  screenerNote("exit", `Paper exit ${reason} pada market cap ${exitCap}; estimasi PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL.`, mint);
  unsubscribeMint(mint);
  publishScreenerStatus();
}

function openPaperPosition(candidate, price, marketCapUsd) {
  resetDailyCountersIfNeeded();
  let blockedReason = "";
  if (fs.existsSync(haltFile)) blockedReason = "Entry tertahan: file .halt aktif";
  else if (state.daily.entries >= config.maxEntriesPerDay) blockedReason = `Entry tertahan: batas harian ${config.maxEntriesPerDay} tercapai`;
  else if (Object.keys(state.positions).length >= config.maxOpenPositions) blockedReason = `Entry tertahan: batas ${config.maxOpenPositions} posisi terbuka`;
  else if (state.balanceSol < config.buyAmountSol) blockedReason = "Entry tertahan: saldo paper tidak cukup";
  else if (state.daily.realizedPnlSol <= -config.maxDailyLossSol && config.maxDailyLossSol > 0) blockedReason = `Entry tertahan: batas rugi harian ${config.maxDailyLossSol} SOL tercapai`;
  if (blockedReason) {
    if (candidate.blockedReason !== blockedReason) {
      candidate.blockedReason = blockedReason;
      screenerNote("blocked", `${blockedReason}; kandidat tetap dipantau.`, candidate.mint);
      publishScreenerStatus();
    }
    return false;
  }
  candidate.blockedReason = "";

  const fee = config.paperFeeBps / 10_000;
  const slippage = config.paperSlippageBps / 10_000;
  const fillPrice = price * (1 + slippage);
  const tokenQuantity = (config.buyAmountSol * (1 - fee)) / fillPrice;
  const info = tokenNames.get(candidate.mint) ?? {};
  const position = {
    mint: candidate.mint,
    name: info.name ?? "",
    symbol: info.symbol ?? "",
    openedAt: Date.now(),
    entryPrice: price,
    lastPrice: price,
    entryMarketCapUsd: marketCapUsd,
    lastMarketCapUsd: marketCapUsd,
    lastPriceAt: Date.now(),
    costSol: config.buyAmountSol,
    tokenQuantity,
    dataSource: config.dataSource,
  };
  state.balanceSol -= config.buyAmountSol;
  state.daily.entries += 1;
  state.positions[candidate.mint] = position;
  candidates.delete(candidate.mint);
  persistState();
  journal.write({
    type: "entry",
    mint: candidate.mint,
    symbol: info.symbol ?? "",
    marketCapUsd,
    trades: candidate.trades,
    buys: candidate.buys,
    buyers: candidate.buyers.size,
    liquidityUsd: candidate.liquidityUsd,
    ...candidate.entryAnalysis,
  });
  log(`[paper-buy] ${displayName(candidate.mint)} MC=${formatUsd(marketCapUsd)} spend=${config.buyAmountSol.toFixed(5)} SOL | activity=${candidate.trades} trades/${candidate.buyers.size} buyers${Number.isFinite(candidate.score) ? ` | score=${candidate.score.toFixed(2)}` : ""}`);
  screenerStats.entered += 1;
  screenerNote("entry", `Sinyal terpenuhi; paper entry ${candidate.symbol || candidate.mint} pada market cap ${formatUsd(marketCapUsd)}.`, candidate.mint);
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
  screenerStats.expired += 1;
  if (!state.positions[mint]) unsubscribeMint(mint);
  const stage = candidateStageInfo(candidate);
  recordReject(`expired:${stage.key}`, mint, stage.text, { peakMarketCapUsd: candidate.peakMarketCapUsd, marketCapUsd: candidate.currentMarketCapUsd });
  log(`[expire] ${displayName(mint)} did not meet entry criteria in time.`);
  screenerNote("expired", `Waktu screening habis; tahap terakhir: ${stage.text}.`, mint);
}

function rejectCandidate(candidate, category, detail, message) {
  candidates.delete(candidate.mint);
  screenerStats.rejected += 1;
  unsubscribeMint(candidate.mint);
  recordReject(category, candidate.mint, detail);
  log(`[skip] ${displayName(candidate.mint)} rejected: ${detail}.`);
  screenerNote("filtered", message ?? `Ditolak: ${detail}.`, candidate.mint);
  publishScreenerStatus();
}

// A token that collapses by RUG_DROP_PCT from its observed peak while being screened counts
// as a rug against its creator (once per token).
function noteRugIfCollapsed(candidate) {
  if (!(candidate.peakMarketCapUsd > 0) || !Number.isFinite(candidate.currentMarketCapUsd)) return;
  if (candidate.currentMarketCapUsd <= candidate.peakMarketCapUsd * (1 - config.rugDropPct) && devBook.recordRug(candidate.mint)) {
    journal.write({ type: "rug", mint: candidate.mint, peakMarketCapUsd: candidate.peakMarketCapUsd, marketCapUsd: candidate.currentMarketCapUsd });
  }
}

function requestHolders(candidate) {
  const holders = candidate.holders;
  if (holders?.status === "pending") return;
  if (holders?.status === "error" && Date.now() < holders.retryAt) return;
  candidate.holders = { status: "pending" };
  fetchHolderStats(candidate.mint, config.solanaRpcUrl, {
    topCount: config.topHoldersCount,
    skipLargest: config.topHoldersSkipLargest,
  })
    .then((stats) => {
      candidate.holders = { status: "ok", ...stats };
      journal.write({ type: "holders", mint: candidate.mint, ...stats });
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
  const dev = devBook.assess(candidate.mint, config);
  const devRejection = devReason(dev);
  if (devRejection) {
    rejectCandidate(candidate, "dev_history", devRejection, `Ditolak: riwayat dev buruk (${devRejection}).`);
    return false;
  }

  const liquidityRejection = liquidityReason(candidate, config);
  if (liquidityRejection) {
    rejectCandidate(candidate, "liquidity", liquidityRejection, `Ditolak: likuiditas terlalu kecil (${liquidityRejection}).`);
    return false;
  }

  if (config.solanaRpcUrl) {
    if (candidate.holders?.status !== "ok") {
      requestHolders(candidate); // result is picked up on a later update
      return false;
    }
    const holderRejection = holderReason(candidate.holders, config);
    if (holderRejection) {
      rejectCandidate(candidate, "holders", holderRejection, `Ditolak: holder terlalu terkonsentrasi (${holderRejection}).`);
      return false;
    }
  }

  const { score, parts } = scoreCandidate(candidate, config, { dev, holders: candidate.holders });
  candidate.score = score;
  if (!candidate.scoreCounted) {
    candidate.scoreCounted = true;
    screenerStats.scored += 1;
  }
  if (score < config.minScore) {
    candidate.scoreBlocked = true;
    if (!candidate.scoreBlockedCounted) {
      candidate.scoreBlockedCounted = true;
      screenerStats.scoreBlocked += 1;
      journal.write({ type: "score_block", mint: candidate.mint, symbol: candidate.symbol, score, minScore: config.minScore, parts });
      screenerNote("blocked", `Skor ${score.toFixed(2)} di bawah batas ${config.minScore}; kandidat tetap dipantau.`, candidate.mint);
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
    candidate.currentPrice = price;
    if (!Number.isFinite(marketCapUsd) && Number.isFinite(solUsdPrice)) marketCapUsd = price * solUsdPrice;
    if (Number.isFinite(marketCapUsd)) candidate.currentMarketCapUsd = marketCapUsd;
    if (activity.kind === "trade") candidate.lastTradeAt = now;
    if (now - candidate.createdAt > config.maxCandidateAgeSeconds * 1000) {
      expireCandidate(mint, candidate);
    } else {
      if (activity.kind === "trade") {
        candidate.trades += 1;
        if (activity.txType === "buy") {
          candidate.buys += 1;
          if (activity.buyer) candidate.buyers.add(activity.buyer);
        }
      } else {
        if (activity.trades > candidate.trades) candidate.lastTradeAt = now;
        candidate.trades = Math.max(candidate.trades, activity.trades);
        candidate.buys = Math.max(candidate.buys, activity.buys);
      }
      if (Number.isFinite(candidate.currentMarketCapUsd)) {
        updateLevels(candidate, candidate.currentMarketCapUsd, config);
        noteRugIfCollapsed(candidate);
      }

      if (!candidate.initialMarketCapChecked && Number.isFinite(candidate.currentMarketCapUsd)) {
        candidate.initialMarketCapChecked = true;
        const initialCap = candidate.currentMarketCapUsd;
        if (initialCap < config.minMarketCapUsd || initialCap > config.maxMarketCapUsd) {
          candidates.delete(mint);
          screenerStats.rejected += 1;
          unsubscribeMint(mint);
          recordReject("market_cap", mint, `market cap ${formatUsd(initialCap)} outside ${formatUsd(config.minMarketCapUsd)}-${formatUsd(config.maxMarketCapUsd)}`);
          screenerNote("filtered", `Dilewati: market cap ${formatUsd(initialCap)} di luar range ${formatUsd(config.minMarketCapUsd)}–${formatUsd(config.maxMarketCapUsd)}.`, mint);
          publishScreenerStatus();
        }
      }
      if (candidates.has(mint) && shouldEnter(candidate, candidate.currentMarketCapUsd, config) && socialAllows(candidate) && passesEntryPipeline(candidate)) {
        openPaperPosition(candidate, price, candidate.currentMarketCapUsd);
      }
    }
  }

  const position = state.positions[mint];
  if (position) {
    position.lastPrice = price;
    if (Number.isFinite(marketCapUsd)) position.lastMarketCapUsd = marketCapUsd;
    position.lastPriceAt = now;
    const reason = exitReason(position, price, now, config);
    if (reason) closePaperPosition(mint, price, marketCapUsd, reason);
    else markStateDirty();
  }
}

// ---------- Social filter ----------
async function resolveSocial(candidate) {
  if (!candidate || config.socialMode === "off" || candidate.socialTried) return;
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
  if (config.socialMode === "off") return true;
  const verdict = socialVerdict(config.socialMode, candidate.social);
  if (verdict === "pass") return true;
  if (verdict === "fail") {
    const requirement = config.socialMode === "twitter"
      ? "tautan X/Twitter"
      : config.socialMode === "multiple" ? "minimal dua jenis tautan sosial" : "minimal satu tautan sosial";
    rejectCandidate(candidate, "social", `missing ${requirement} in token metadata`, `Ditolak: perlu ${requirement} di metadata token.`);
  } else if (!candidate.socialTried && Date.now() >= (candidate.socialRetryAt ?? 0)) {
    resolveSocial(candidate);
  }
  return false;
}

// ---------- Free data source: DexScreener (bulk) + GeckoTerminal (unique buyers) ----------
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
  if (candidate) {
    if (snap.pool) candidate.pool = snap.pool;
    if (snap.socials) candidate.social = mergeSocials(candidate.social, snap.socials);
    if (snap.liquidityUsd > 0) candidate.liquidityUsd = snap.liquidityUsd; // 0 means "not reported"
    if (snap.trades > candidate.trades) screenerStats.tradeMessagesReceived += snap.trades - candidate.trades;
    if (!polledMints.has(mint)) {
      polledMints.add(mint);
      screenerStats.tradeSubscriptionsRequested += 1;
    }
  }
  applyUpdate(mint, snap.price, snap.marketCapUsd, Date.now(), { kind: "snapshot", trades: snap.trades, buys: snap.buys });
}

async function checkUniqueBuyers() {
  const now = Date.now();
  if (now < geckoBackoffUntil) return;
  let target = null;
  for (const candidate of candidates.values()) {
    if (!candidate.pool || candidate.buyers.size >= config.minUniqueBuyers) continue;
    if (candidate.trades < config.minTrades || candidate.buys < config.minBuys) continue;
    if (now - (candidate.lastBuyerCheckAt ?? 0) < config.buyerCheckIntervalMs) continue;
    if (!target || (candidate.lastBuyerCheckAt ?? 0) < (target.lastBuyerCheckAt ?? 0)) target = candidate;
  }
  if (!target) return;
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
  const mints = [...new Set([...Object.keys(state.positions), ...candidates.keys()])]
    .filter((mint) => !mint.startsWith("DEMO-"));
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
    for (const mint of Object.keys(state.positions)) subscribeMint(mint);
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
    if (now - candidate.createdAt > config.maxCandidateAgeSeconds * 1000) expireCandidate(mint, candidate);
  }
  for (const [mint, position] of Object.entries(state.positions)) {
    if (!Number.isFinite(position.lastPriceAt) || now - position.lastPriceAt > 30_000) {
      // No fresh price (e.g. token not indexed anymore): do not keep a paper position open forever.
      if (Number.isFinite(position.lastPrice) && now - position.openedAt >= config.maxHoldSeconds * 3000) {
        log(`[stale] ${displayName(mint)} had no fresh price; closing at last known price.`);
        closePaperPosition(mint, position.lastPrice, position.lastMarketCapUsd, "max-hold-stale");
      }
      continue;
    }
    const reason = exitReason(position, position.lastPrice, now, config);
    if (reason) closePaperPosition(mint, position.lastPrice, position.lastMarketCapUsd, reason);
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
    log("[settings] Strategi diperbarui tanpa restart bot.");
    if (process.send) process.send({ type: "settings-applied" });
  } catch (error) {
    log(`[settings error] ${error.message}`);
    if (process.send) process.send({ type: "settings-error", error: error.message });
  }
});

log(`[start] mode=${config.mode} balance=${state.balanceSol.toFixed(5)} SOL buy=${config.buyAmountSol} SOL MC=${formatUsd(config.minMarketCapUsd)}–${formatUsd(config.maxMarketCapUsd)} TP=${(config.takeProfitPct * 100).toFixed(1)}% SL=${(config.stopLossPct * 100).toFixed(1)}%`);
log(`[strategy] pullback=${(config.pullbackPct * 100).toFixed(1)}% bounce=${(config.bouncePct * 100).toFixed(1)}% | paper fills include ${config.paperFeeBps} bps fee and ${config.paperSlippageBps} bps slippage per side.`);
log(`[pipeline] dev filter (max ${config.maxDevRugs} rug / ${config.maxDevLaunches} launches) > liquidity >= $${config.minLiquidityUsd} > holders ${config.solanaRpcUrl ? `top ${config.topHoldersCount} <= ${config.maxTopHoldersPct}%` : "(off: no SOLANA_RPC_URL)"} > score >= ${config.minScore} | journal: data/journal.jsonl`);
if (state.daily?.day !== currentUtcDay()) resetDailyCountersIfNeeded();
journal.start();
devBookTimer = setInterval(() => devBook.save(), 60_000);
connect();
startPolling();
sweepTimer = setInterval(sweep, 2000);
screenerTimer = setInterval(publishScreenerStatus, 1000);
if (process.send) process.send({ type: "status", status: "running" });
