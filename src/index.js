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

function rememberMint(mint) {
  state.seenMints.push(mint);
  if (state.seenMints.length > 20_000) state.seenMints.splice(0, state.seenMints.length - 20_000);
}

function markStateDirty() {
  stateDirty = true;
}

function displayName(mint) {
  const info = tokenNames.get(mint) ?? state.positions[mint] ?? {};
  return info.symbol ? `${info.symbol} (${mint})` : mint;
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function subscribeMint(mint) {
  if (subscribedMints.has(mint)) return;
  subscribedMints.add(mint);
  send({ method: "subscribeTokenTrade", keys: [mint] });
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

function onNewToken(event) {
  const mint = typeof event.mint === "string" ? event.mint : "";
  if (!mint || state.seenMints.includes(mint) || state.positions[mint] || candidates.has(mint)) return;

  const firstPrice = priceFromEvent(event);
  if (firstPrice !== null && (firstPrice < config.minMarketCapSol || firstPrice > config.maxMarketCapSol)) {
    rememberMint(mint);
    markStateDirty();
    return;
  }
  if (candidates.size >= config.maxActiveCandidates) {
    rememberMint(mint);
    markStateDirty();
    log(`[skip] ${mint} skipped; active candidate limit (${config.maxActiveCandidates}) reached.`);
    return;
  }

  const name = typeof event.name === "string" ? event.name.slice(0, 80) : "";
  const symbol = typeof event.symbol === "string" ? event.symbol.slice(0, 24) : "";
  tokenNames.set(mint, { name, symbol });
  candidates.set(mint, {
    mint,
    createdAt: Date.now(),
    trades: 0,
    buys: 0,
    buyers: new Set(),
    peakPrice: firstPrice,
    lowPrice: firstPrice,
    pulledBack: false,
  });
  rememberMint(mint);
  markStateDirty();
  subscribeMint(mint);
  log(`[launch] ${displayName(mint)}${firstPrice ? ` mcap=${firstPrice.toFixed(3)} SOL` : ""}`);
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
  unsubscribeMint(mint);
}

function openPaperPosition(candidate, price) {
  resetDailyCountersIfNeeded();
  if (fs.existsSync(haltFile)) {
    log(`[halt] Entry skipped for ${displayName(candidate.mint)}; remove ${haltFile} to resume entries.`);
    return;
  }
  if (state.daily.entries >= config.maxEntriesPerDay) return;
  if (Object.keys(state.positions).length >= config.maxOpenPositions) return;
  if (state.balanceSol < config.buyAmountSol) return;
  if (state.daily.realizedPnlSol <= -config.maxDailyLossSol && config.maxDailyLossSol > 0) return;

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
  };
  state.balanceSol -= config.buyAmountSol;
  state.daily.entries += 1;
  state.positions[candidate.mint] = position;
  candidates.delete(candidate.mint);
  persistState();
  log(`[paper-buy] ${displayName(candidate.mint)} price=${price.toFixed(6)} spend=${config.buyAmountSol.toFixed(5)} SOL | activity=${candidate.trades} trades/${candidate.buyers.size} buyers`);
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
    if (now - candidate.createdAt > config.maxCandidateAgeSeconds * 1000) {
      candidates.delete(mint);
      if (!state.positions[mint]) unsubscribeMint(mint);
      log(`[expire] ${displayName(mint)} did not meet entry criteria in time.`);
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
  if (txType === "create") onNewToken(event);
  else onTokenTrade(event);
}

function connect() {
  if (stopping) return;
  socket = new WebSocket(apiUrl);
  socket.on("open", () => {
    reconnectDelayMs = 1000;
    subscribedMints.clear();
    send({ method: "subscribeNewToken" });
    for (const mint of candidates.keys()) subscribeMint(mint);
    for (const mint of Object.keys(state.positions)) subscribeMint(mint);
    if (process.send) process.send({ type: "feed", connected: true });
    log("[feed] Connected to PumpPortal; listening for new Pump.fun launches.");
  });
  socket.on("message", onMessage);
  socket.on("error", (error) => log(`[feed] ${error.message}`));
  socket.on("close", () => {
    subscribedMints.clear();
    if (process.send) process.send({ type: "feed", connected: false });
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
      if (!state.positions[mint]) unsubscribeMint(mint);
      log(`[expire] ${displayName(mint)} did not meet entry criteria in time.`);
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
  persistState();
  socket?.close();
  log("[shutdown] Paper state saved.");
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
if (process.send) process.send({ type: "status", status: "running" });
