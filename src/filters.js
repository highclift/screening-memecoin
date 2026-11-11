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
  minBuyersH1: 10, // DIFFERENT wallets, not trades: volume from five wallets is not a market
  maxTradesPerBuyer: 12, // 600 trades from 20 wallets is one group passing a coin between itself
  maxSellerBuyerRatio: 1.25, // more wallets leaving than arriving is a coin being handed out
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

  // Volume and trade count are the two numbers an insider group can manufacture for nothing: the
  // same wallets buying from each other produce both. The number they cannot fake without paying
  // for it is how many DIFFERENT wallets bought. A coin whose hour was busy but narrow is a coin
  // being traded by its own holders, which is what the bubble-map coins look like from the outside.
  const buyers = finite(record.buyersH1) ? record.buyersH1 : null;
  if (buyers !== null && buyers < gates.minBuyersH1) {
    return {
      category: "few_buyers",
      detail: `only ${buyers} different wallets bought this hour (need ${gates.minBuyersH1})`,
    };
  }
  if (buyers !== null && buyers > 0 && finite(record.tradesH1)
    && record.tradesH1 / buyers > gates.maxTradesPerBuyer) {
    return {
      category: "wash_trading",
      detail: `${record.tradesH1} trades from only ${buyers} wallets (${(record.tradesH1 / buyers).toFixed(0)} each) — the volume is the same wallets going round`,
    };
  }

  // Counted in WALLETS, which is what makes this different from the buy/sell split: a coin can
  // show half its trades as buys while the wallets holding it are steadily leaving. More sellers
  // than buyers is the exit side of an insider position — the hour the cluster hands its supply
  // to whoever the chart attracted — and it is the one thing those coins cannot hide, because
  // somebody has to be on the other side of the sale.
  const sellers = finite(record.sellersH1) ? record.sellersH1 : null;
  if (buyers !== null && buyers > 0 && sellers !== null && sellers > buyers * gates.maxSellerBuyerRatio) {
    return {
      category: "distribution",
      detail: `${sellers} wallets sold against ${buyers} buying — more holders leaving than arriving`,
    };
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

  // Several holders funded by the same wallet are one actor spread across addresses. On a bubble
  // map this is the cluster joined by lines to a single hub, and the combined holding is what can
  // be dumped at once — so it is judged as if it were one holder.
  if (Number.isFinite(holders.largestClusterPct) && holders.largestClusterWallets >= 2
    && holders.largestClusterPct > config.maxClusterPct) {
    return {
      category: "wallet_cluster",
      detail: `${holders.largestClusterWallets} holders share one funder and hold ${holders.largestClusterPct.toFixed(1)}% together (limit ${config.maxClusterPct}%)`,
    };
  }

  // Every cluster together. A map with several hubs is the same actor using several funders, and
  // judging only the biggest one lets a position through by splitting it twice instead of once.
  if (Number.isFinite(holders.linkedSupplyPct) && holders.linkedWallets >= 2
    && holders.linkedSupplyPct > config.maxLinkedSupplyPct) {
    return {
      category: "linked_supply",
      detail: `${holders.linkedWallets} of the top holders are linked by funding and hold ${holders.linkedSupplyPct.toFixed(1)}% together (limit ${config.maxLinkedSupplyPct}%)`,
    };
  }

  // The same picture with the size taken out. A row of wallets paid for by one address within
  // hours of each other is an insider distribution however little each one holds — the point of
  // splitting a position across twenty addresses is to sit under a limit exactly like the two
  // above. The funding window is what keeps this honest: wallets funded months apart share an
  // address because it is an exchange, not because somebody set them up for this launch.
  if (holders.largestClusterWallets >= config.maxClusterWallets
    && (!Number.isFinite(holders.largestClusterSpanHours) || holders.largestClusterSpanHours <= config.clusterBurstHours)) {
    const when = Number.isFinite(holders.largestClusterSpanHours)
      ? ` within ${holders.largestClusterSpanHours < 1 ? "an hour" : `${Math.round(holders.largestClusterSpanHours)}h`} of each other`
      : "";
    return {
      category: "linked_wallets",
      detail: `${holders.largestClusterWallets} top holders were funded by one wallet${when} (limit ${config.maxClusterWallets}) — one actor behind several addresses`,
    };
  }

  // Supply sitting in brand-new wallets. Measured as a share of SUPPLY, not as a count of
  // holders: on a young coin almost every holder is a new wallet, so counting them rejects
  // everything. What is dangerous is a lot of supply in wallets with no history behind them.
  if (Number.isFinite(holders.freshSupplyPct) && holders.freshSupplyPct > config.maxFreshSupplyPct) {
    return {
      category: "fresh_wallets",
      detail: `${holders.freshHolders} brand-new wallets hold ${holders.freshSupplyPct.toFixed(1)}% of supply (limit ${config.maxFreshSupplyPct}%)`,
    };
  }
  return null;
}

export function devReason(assessment) {
  return assessment?.verdict === "reject" ? { category: "dev_history", detail: assessment.reason } : null;
}
