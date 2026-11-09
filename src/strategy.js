export function priceFromEvent(event) {
  const marketCap = Number(event.marketCapSol);
  if (Number.isFinite(marketCap) && marketCap > 0) return marketCap;

  const solAmount = Number(event.solAmount);
  const tokenAmount = Number(event.tokenAmount);
  if (Number.isFinite(solAmount) && solAmount > 0 && Number.isFinite(tokenAmount) && tokenAmount > 0) {
    return solAmount / tokenAmount;
  }
  return null;
}

export function shouldEnter(candidate, marketCapUsd, config) {
  if (!candidate.pulledBack || candidate.trades < config.minTrades) return false;
  if (candidate.buys < config.minBuys || candidate.buyers.size < config.minUniqueBuyers) return false;
  if (!Number.isFinite(marketCapUsd) || marketCapUsd < config.minMarketCapUsd || marketCapUsd > config.maxMarketCapUsd) return false;
  return marketCapUsd >= candidate.lowMarketCapUsd * (1 + config.bouncePct);
}

export function estimateNetProceeds(position, currentPrice, config) {
  const fee = config.paperFeeBps / 10_000;
  const slippage = config.paperSlippageBps / 10_000;
  return position.tokenQuantity * currentPrice * (1 - slippage) * (1 - fee);
}

export function exitReason(position, currentPrice, now, config) {
  const netProceeds = estimateNetProceeds(position, currentPrice, config);
  if (netProceeds >= position.costSol * (1 + config.takeProfitPct)) return "take-profit";
  if (netProceeds <= position.costSol * (1 - config.stopLossPct)) return "stop-loss";
  if (now - position.openedAt >= config.maxHoldSeconds * 1000) return "max-hold";
  return null;
}
