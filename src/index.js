import "dotenv/config";
import fs from "node:fs";
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { currentUtcDay, loadState, saveState } from "./state.js";
import { estimateNetProceeds, exitReason, priceFromEvent, shouldEnter } from "./strategy.js";

let config = loadConfig();
const state = loadState(config.paperStartBalanceSol);
const candidates = new Map();
const subscribedMints = new Set();
const tokenNames = new Map();
let socket;
let reconnectTimer;
let reconnectDelayMs = 1000;
let stopping = false;
let stateDirty = false;
let lastStateWriteAt = 0;
let sweepTimer;
let screenerTimer;
const screenerStats = {
  scanned: 0,
  rejected: 0,
  entered: 0,
  expired: 0,
  tradeSubscriptionsRequested: 0,
  tradeMessagesReceived: 0,
};
const recentFeedResponses = new Map();

const apiUrl = `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(config.apiKey)}`;
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

function candidateStage(candidate) {
  if (candidate.blockedReason) return candidate.blockedReason;
  if (candidate.trades < config.minTrades) return `Trade ${candidate.trades}/${config.minTrades}`;
  if (candidate.buys < config.minBuys) return `Buy ${candidate.buys}/${config.minBuys}`;
  if (candidate.buyers.size < config.minUniqueBuyers) return `Buyer unik ${candidate.buyers.size}/${config.minUniqueBuyers}`;
  if (!candidate.pulledBack) return `Menunggu pullback ${(config.pullbackPct * 100).toFixed(1)}%`;
  const rebound = candidate.lowPrice > 0 ? ((candidate.currentPrice / candidate.lowPrice) - 1) * 100 : 0;
  if (rebound < config.bouncePct * 100) return `Menunggu pantulan ${rebound.toFixed(1)}/${(config.bouncePct * 100).toFixed(1)}%`;
  return "Sinyal entry; cek batas risiko";
}

function publishScreenerStatus() {
  if (!process.send) return;
  const activeCandidates = Array.from(candidates.values()).slice(-40).map((candidate) => ({
    mint: candidate.mint,
    name: candidate.name,
    symbol: candidate.symbol,
    dataSource: config.dataSource,
    currentPrice: candidate.currentPrice,
    peakPrice: candidate.peakPrice,
    lowPrice: candidate.lowPrice,
    trades: candidate.trades,
    buys: candidate.buys,
    uniqueBuyers: candidate.buyers.size,
    ageSeconds: Math.floor((Date.now() - candidate.createdAt) / 1000),
    stage: candidateStage(candidate),
    lastTradeAt: candidate.lastTradeAt ?? candidate.createdAt,
  }));
  process.send({
    type: "screener-status",
    status: {
      scanned: screenerStats.scanned,
      rejected: screenerStats.rejected,
      entered: screenerStats.entered,
      expired: screenerStats.expired,
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
  if (subscribedMints.has(mint)) return;
  if (!send({ method: "subscribeTokenTrade", keys: [mint] })) return;
  subscribedMints.add(mint);
  screenerStats.tradeSubscriptionsRequested += 1;
  if (screenerStats.tradeSubscriptionsRequested === 1 || screenerStats.tradeSubscriptionsRequested % 50 === 0) {
    log(`[feed] subscribeTokenTrade requests sent: ${screenerStats.tradeSubscriptionsRequested}.`);
  }
}

function unsubscribeMint(mint) {
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

  const firstPrice = priceFromEvent(event);
  const info = tokenNames.get(mint) ?? {};
  const name = typeof event.name === "string" ? event.name.slice(0, 80) : info.name ?? "";
  const symbol = typeof event.symbol === "string" ? event.symbol.slice(0, 24) : info.symbol ?? "";
  if (firstPrice !== null && (firstPrice < config.minMarketCapSol || firstPrice > config.maxMarketCapSol)) {
    screenerStats.rejected += 1;
    rememberScreenedMigration(mint);
    markStateDirty();
    screenerNote("filtered", "Dilewati: market cap " + firstPrice.toFixed(3) + " SOL di luar range " + config.minMarketCapSol + "–" + config.maxMarketCapSol + " SOL.", mint);
    publishScreenerStatus();
    return;
  }
  if (candidates.size >= config.maxActiveCandidates) {
    screenerStats.rejected += 1;
    rememberScreenedMigration(mint);
    markStateDirty();
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
    peakPrice: firstPrice,
    lowPrice: firstPrice,
    pulledBack: false,
    pool: String(event.pool ?? event.poolAddress ?? event.newPool ?? event.new_pool ?? ""),
  });
  rememberScreenedMigration(mint);
  markStateDirty();
  subscribeMint(mint);
  log(`[migration] ${displayName(mint)}${firstPrice ? ` mcap=${firstPrice.toFixed(3)} SOL` : ""}`);
  screenerNote("candidate", `Migrasi ke pool AMM terdeteksi; mulai screening trade ${symbol || mint}.`, mint);
  publishScreenerStatus();
}

function closePaperPosition(mint, price, reason) {
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
    costSol: position.costSol,
    proceedsSol,
    pnlSol,
    reason,
  });
  if (state.closedTrades.length > 5000) state.closedTrades.splice(0, state.closedTrades.length - 5000);
  delete state.positions[mint];
  persistState();
  log(`[exit:${reason}] ${displayName(mint)} pnl=${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL | balance=${state.balanceSol.toFixed(5)} SOL`);
  screenerNote("exit", `Paper exit ${reason}; estimasi PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL.`, mint);
  unsubscribeMint(mint);
  publishScreenerStatus();
}

function openPaperPosition(candidate, price) {
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
  log(`[paper-buy] ${displayName(candidate.mint)} price=${price.toFixed(6)} spend=${config.buyAmountSol.toFixed(5)} SOL | activity=${candidate.trades} trades/${candidate.buyers.size} buyers`);
  screenerStats.entered += 1;
  screenerNote("entry", `Sinyal terpenuhi; paper entry ${candidate.symbol || candidate.mint} pada harga ${price.toFixed(6)}.`, candidate.mint);
  publishScreenerStatus();
  return true;
}

function onTokenTrade(event) {
  const mint = typeof event.mint === "string" ? event.mint : "";
  if (!mint) return;
  const price = priceFromEvent(event);
  if (price === null) return;
  const now = Date.now();
  const txType = String(event.txType ?? "").toLowerCase();

  const candidate = candidates.get(mint);
  if (candidate) {
    candidate.currentPrice = price;
    candidate.lastTradeAt = now;
    if (now - candidate.createdAt > config.maxCandidateAgeSeconds * 1000) {
      candidates.delete(mint);
      screenerStats.expired += 1;
      if (!state.positions[mint]) unsubscribeMint(mint);
      log(`[expire] ${displayName(mint)} did not meet entry criteria in time.`);
      screenerNote("expired", `Waktu screening habis; tahap terakhir: ${candidateStage(candidate)}.`, mint);
    } else {
      candidate.trades += 1;
      if (txType === "buy") {
        candidate.buys += 1;
        if (typeof event.traderPublicKey === "string") candidate.buyers.add(event.traderPublicKey);
      }
      if (candidate.peakPrice === null || price > candidate.peakPrice) candidate.peakPrice = price;
      if (candidate.lowPrice === null || price < candidate.lowPrice) candidate.lowPrice = price;
      if (candidate.peakPrice > 0 && price <= candidate.peakPrice * (1 - config.pullbackPct)) {
        candidate.pulledBack = true;
      }
      if (candidate.pulledBack && price < candidate.lowPrice) candidate.lowPrice = price;

      if (shouldEnter(candidate, price, config)) openPaperPosition(candidate, price);
    }
  }

  const position = state.positions[mint];
  if (position) {
    position.lastPrice = price;
    position.lastPriceAt = now;
    const reason = exitReason(position, price, now, config);
    if (reason) closePaperPosition(mint, price, reason);
    else markStateDirty();
  }
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
    const payload = JSON.stringify(event).replaceAll(config.apiKey, "[API KEY REDACTED]").slice(0, 500);
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
    log("[feed] Connected to PumpPortal; listening for token launches and AMM migrations.");
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
    if (now - candidate.createdAt > config.maxCandidateAgeSeconds * 1000) {
      candidates.delete(mint);
      screenerStats.expired += 1;
      if (!state.positions[mint]) unsubscribeMint(mint);
      log(`[expire] ${displayName(mint)} did not meet entry criteria in time.`);
      screenerNote("expired", `Waktu screening habis; tahap terakhir: ${candidateStage(candidate)}.`, mint);
    }
  }
  for (const [mint, position] of Object.entries(state.positions)) {
    if (!Number.isFinite(position.lastPriceAt) || now - position.lastPriceAt > 30_000) continue;
    const reason = exitReason(position, position.lastPrice, now, config);
    if (reason) closePaperPosition(mint, position.lastPrice, reason);
  }
  if (stateDirty && now - lastStateWriteAt >= 5000) persistState();
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(sweepTimer);
  clearInterval(screenerTimer);
  persistState();
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
    });
    log("[settings] Strategi diperbarui tanpa restart bot.");
    if (process.send) process.send({ type: "settings-applied" });
  } catch (error) {
    log(`[settings error] ${error.message}`);
    if (process.send) process.send({ type: "settings-error", error: error.message });
  }
});

log(`[start] mode=${config.mode} balance=${state.balanceSol.toFixed(5)} SOL buy=${config.buyAmountSol} SOL TP=${(config.takeProfitPct * 100).toFixed(1)}% SL=${(config.stopLossPct * 100).toFixed(1)}%`);
log(`[strategy] pullback=${(config.pullbackPct * 100).toFixed(1)}% bounce=${(config.bouncePct * 100).toFixed(1)}% | paper fills include ${config.paperFeeBps} bps fee and ${config.paperSlippageBps} bps slippage per side.`);
if (state.daily?.day !== currentUtcDay()) resetDailyCountersIfNeeded();
connect();
sweepTimer = setInterval(sweep, 2000);
screenerTimer = setInterval(publishScreenerStatus, 1000);
if (process.send) process.send({ type: "status", status: "running" });
