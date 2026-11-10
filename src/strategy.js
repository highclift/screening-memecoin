// Pump.fun tokens have a fixed supply of 1,000,000,000 whole tokens.
export const SUPPLY = 1_000_000_000;

// "Price" in this bot is the token's market cap in SOL (the unit PumpPortal reports as
// `marketCapSol`). The fallback derives the same unit from a trade's SOL / token amounts,
// so both paths can be mixed without corrupting peak/low tracking.
export function priceFromEvent(event) {
  const marketCap = Number(event.marketCapSol);
  if (Number.isFinite(marketCap) && marketCap > 0) return marketCap;

  const solAmount = Number(event.solAmount);
  const tokenAmount = Number(event.tokenAmount);
  if (Number.isFinite(solAmount) && solAmount > 0 && Number.isFinite(tokenAmount) && tokenAmount > 0) {
    return (solAmount / tokenAmount) * SUPPLY;
  }
  return null;
}

// Tracks the local peak and the low that follows a pullback.
//  - A new high resets the pullback state: the bot waits for a fresh drop from that peak.
//  - The low is only tracked after the pullback has triggered, so the rebound is measured
//    from the bottom of the dip and not from some earlier low before the peak.
export function updateLevels(candidate, marketCapUsd, config) {
  if (!Number.isFinite(marketCapUsd)) return;

  if (!Number.isFinite(candidate.peakMarketCapUsd) || marketCapUsd > candidate.peakMarketCapUsd) {
    candidate.peakMarketCapUsd = marketCapUsd;
    candidate.pulledBack = false;
    candidate.lowMarketCapUsd = marketCapUsd;
    return;
  }

  if (!candidate.pulledBack) {
    if (candidate.peakMarketCapUsd > 0
      && marketCapUsd <= candidate.peakMarketCapUsd * (1 - config.pullbackPct)) {
      candidate.pulledBack = true;
      candidate.lowMarketCapUsd = marketCapUsd;
    }
  } else if (!Number.isFinite(candidate.lowMarketCapUsd) || marketCapUsd < candidate.lowMarketCapUsd) {
    candidate.lowMarketCapUsd = marketCapUsd;
  }
}

// Unique buyers: normally the set collected by this bot; the age lanes get a count from
// GeckoTerminal instead (`buyersOverride`).
export function buyerCount(candidate) {
  return Number.isFinite(candidate.buyersOverride) ? candidate.buyersOverride : candidate.buyers.size;
}

export function shouldEnter(candidate, marketCapUsd, config) {
  if (!candidate.pulledBack || candidate.trades < config.minTrades) return false;
  if (candidate.buys < config.minBuys || buyerCount(candidate) < config.minUniqueBuyers) return false;
  if (!Number.isFinite(marketCapUsd) || marketCapUsd < config.minMarketCapUsd || marketCapUsd > config.maxMarketCapUsd) return false;
  if (!(candidate.lowMarketCapUsd > 0)) return false;
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
