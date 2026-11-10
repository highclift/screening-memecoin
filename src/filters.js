// Pure filter rules. Each returns a human-readable rejection reason, or null when the
// candidate passes (or when the data needed for the rule is unknown: unknown never rejects).

export function liquidityReason(candidate, config) {
  if (!(config.minLiquidityUsd > 0)) return null;
  if (!Number.isFinite(candidate.liquidityUsd)) return null;
  if (candidate.liquidityUsd < config.minLiquidityUsd) {
    return `liquidity $${Math.round(candidate.liquidityUsd).toLocaleString("en-US")} below $${Math.round(config.minLiquidityUsd).toLocaleString("en-US")}`;
  }
  return null;
}

export function volumeReason(candidate, config) {
  if (!(config.minVolumeH1Usd > 0) || !Number.isFinite(candidate.volumeH1Usd)) return null;
  if (candidate.volumeH1Usd < config.minVolumeH1Usd) {
    return `1h volume $${Math.round(candidate.volumeH1Usd).toLocaleString("en-US")} below $${Math.round(config.minVolumeH1Usd).toLocaleString("en-US")}`;
  }
  return null;
}

export function holderReason(holders, config) {
  if (!holders || holders.status !== "ok" || !Number.isFinite(holders.topPct)) return null;
  if (holders.topPct > config.maxTopHoldersPct) {
    return `top ${config.topHoldersCount} holders own ${holders.topPct.toFixed(1)}% (limit ${config.maxTopHoldersPct}%)`;
  }
  return null;
}

export function devReason(assessment) {
  return assessment?.verdict === "reject" ? assessment.reason : null;
}
