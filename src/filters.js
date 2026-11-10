// Bot 2's hard gates: the pure yes/no rules that come before any scoring.
//
// These are safety floors, not strategy. A coin that fails one of them cannot be paper-traded
// honestly at all (no liquidity to sell into, nothing trading, a creator who already rugged), so no
// score can rescue it. Everything that IS strategy — is this coin about to pump? — is scored in
// signals.js and decided by the bots themselves.
//
// Each rule returns { category, detail } for a rejection, or null when the coin passes. Unknown
// data never rejects: it comes back as the `no_data` wait below instead.

export const GATE_DEFAULTS = {
  minLiquidityUsd: 5_000, // below this a paper exit is fiction
  minLiquidityRatio: 0.015, // liquidity vs market cap: a $5M coin with a $10k pool is a trap
  minTradesH1: 15, // fewer than this in an hour is a dead coin, not a quiet one
  minVolumeH1Usd: 2_000,
  minMarketCapUsd: 20_000,
  maxMarketCapUsd: 30_000_000,
};

const usd = (value) => `$${Math.round(value).toLocaleString("en-US")}`;
const finite = (n) => Number.isFinite(n);

// Returns { category: "no_data", detail } while the fields needed to judge the coin are missing.
// That is a "come back later", not a rejection: bot 2 keeps the coin and waits for bot 1 to fill
// the data in, which is how a month-old coin stays in the registry until the hour it wakes up.
export function gateReason(record, gates = GATE_DEFAULTS) {
  if (!finite(record?.marketCapUsd) || !finite(record?.liquidityUsd)) {
    return { category: "no_data", detail: "waiting for market cap / liquidity data", wait: true };
  }

  if (record.marketCapUsd < gates.minMarketCapUsd || record.marketCapUsd > gates.maxMarketCapUsd) {
    return {
      category: "market_cap",
      detail: `market cap ${usd(record.marketCapUsd)} outside ${usd(gates.minMarketCapUsd)}-${usd(gates.maxMarketCapUsd)}`,
    };
  }

  if (record.liquidityUsd < gates.minLiquidityUsd) {
    return { category: "liquidity", detail: `liquidity ${usd(record.liquidityUsd)} below ${usd(gates.minLiquidityUsd)}` };
  }

  if (record.liquidityUsd / record.marketCapUsd < gates.minLiquidityRatio) {
    return {
      category: "liquidity_ratio",
      detail: `liquidity is ${(record.liquidityUsd / record.marketCapUsd * 100).toFixed(1)}% of market cap (need ${(gates.minLiquidityRatio * 100).toFixed(1)}%)`,
    };
  }

  if (finite(record.tradesH1) && record.tradesH1 < gates.minTradesH1) {
    return { category: "dead", detail: `${record.tradesH1} trades in the last hour (need ${gates.minTradesH1})` };
  }

  if (finite(record.volumeH1Usd) && record.volumeH1Usd < gates.minVolumeH1Usd) {
    return { category: "dead_volume", detail: `1h volume ${usd(record.volumeH1Usd)} below ${usd(gates.minVolumeH1Usd)}` };
  }

  return null;
}

// What the chain says about a coin, checked over RPC only for coins that already scored well (it
// is the one expensive lookup in the pipeline). Each rule is skipped when its data is missing, so
// an RPC that answered only half the questions still contributes what it knows.
//
// Order matters only for which message you see first; any one of these is enough to refuse.
export function holderReason(holders, config) {
  if (!holders || holders.status !== "ok") return null;

  // Supply that can still be printed, or tokens that can be frozen in your wallet, make every
  // other number meaningless.
  if (config.requireMintRevoked && holders.mintAuthority) {
    return { category: "mint_authority", detail: "the creator can still mint more supply" };
  }
  if (config.requireFreezeRevoked && holders.freezeAuthority) {
    return { category: "freeze_authority", detail: "the creator can still freeze your tokens" };
  }

  // One holder who can sell more than the pool can absorb is the whole game: that is the sell
  // that drops the price 99% with no price in between for a stop to catch.
  if (Number.isFinite(holders.topPct) && holders.topPct > config.maxTopHoldersPct) {
    return {
      category: "holders",
      detail: `top ${config.topHoldersCount} holders own ${holders.topPct.toFixed(1)}% (limit ${config.maxTopHoldersPct}%)`,
    };
  }

  // Brand-new wallets holding the supply are one actor wearing several hats, not a crowd.
  if (Number.isFinite(holders.freshPct) && holders.checkedHolders >= 2
    && holders.freshPct > config.maxFreshHoldersPct) {
    return {
      category: "fresh_wallets",
      detail: `${holders.freshHolders} of ${holders.checkedHolders} top holders are brand-new wallets`,
    };
  }
  return null;
}

export function devReason(assessment) {
  return assessment?.verdict === "reject" ? { category: "dev_history", detail: assessment.reason } : null;
}
