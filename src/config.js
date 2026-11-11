import { boolFromEnv, numberFromEnv } from "./envutil.js";
import { GATE_DEFAULTS } from "./filters.js";

// Three bots in a chain, so there are only three kinds of setting left:
//
//   money   — how much the paper account may risk. The only thing the dashboard asks for.
//   limits  — API budgets and how fast each stage ticks.
//   floors  — safety gates (bot 2) that are not strategy: dead coins, empty pools, rugged devs.
//
// There are no entry/exit settings any more. Bot 3 derives those from each coin's own measured
// volatility (see signals.js), which is the whole point of splitting the bots this way.

const DEFAULTS = {
  paperStartBalanceSol: 1,
  positionPct: 0.08, // share of the paper balance per trade
  maxOpenPositions: 3,
  maxEntriesPerDay: 20,
  maxDailyLossSol: 0.05,
  paperFeeBps: 100,
  paperSlippageBps: 200,
};

export function loadConfig(env = process.env) {
  const mode = (env.MODE ?? "paper").trim().toLowerCase();
  if (mode !== "paper") {
    throw new Error("This build supports MODE=paper only; no live transactions are sent.");
  }

  // The PumpPortal launch/migration feed is free and needs no key. A key is only passed through if
  // one is configured; nothing in this pipeline subscribes to paid per-token trade streams, because
  // bot 1 needs breadth (hundreds of coins) rather than every tick of a few.
  let apiKey = (env.PUMPPORTAL_API_KEY ?? "").trim();
  if (apiKey === "replace_me") apiKey = "";

  // Optional Solana RPC endpoint for bot 2's holder-concentration gate. It may contain a provider
  // key, so it is never logged or sent to the dashboard.
  const solanaRpcUrl = (env.SOLANA_RPC_URL ?? "").trim();
  if (solanaRpcUrl && !/^https?:\/\//i.test(solanaRpcUrl)) {
    throw new Error("SOLANA_RPC_URL must start with http:// or https://.");
  }

  const entryMode = (env.ENTRY_MODE ?? "both").trim().toLowerCase();
  if (!["dip", "breakout", "both"].includes(entryMode)) {
    throw new Error("ENTRY_MODE must be dip, breakout, or both.");
  }

  const c = {
    mode,
    dataSource: "pumpportal+dexscreener+geckoterminal",
    apiKey,
    solanaRpcUrl,

    // ---- money (the dashboard form), owned by the risk agent ----
    paperStartBalanceSol: numberFromEnv(env, "PAPER_START_BALANCE_SOL", DEFAULTS.paperStartBalanceSol, { min: 0.000001 }),
    // Share of the paper balance per trade, not a fixed amount: the desk scales itself down after
    // a bad night instead of betting the same size into a smaller account.
    positionPct: numberFromEnv(env, "POSITION_PCT", DEFAULTS.positionPct, { min: 0.001, max: 1 }),
    minPositionSol: numberFromEnv(env, "MIN_POSITION_SOL", 0.002, { min: 0.000001 }),
    maxOpenPositions: numberFromEnv(env, "MAX_OPEN_POSITIONS", DEFAULTS.maxOpenPositions, { min: 1, max: 100 }),
    maxEntriesPerDay: numberFromEnv(env, "MAX_ENTRIES_PER_DAY", DEFAULTS.maxEntriesPerDay, { min: 1, max: 10_000 }),
    maxDailyLossSol: numberFromEnv(env, "MAX_DAILY_LOSS_SOL", DEFAULTS.maxDailyLossSol, { min: 0 }),

    // ---- the shape of a trade (risk agent) ----
    // The flat stop, fixed before the entry is taken and never widened.
    stopPct: numberFromEnv(env, "STOP_PCT", 0.06, { min: 0.01, max: 0.9 }),
    // Nothing trails until the position has been this far up. From there the floor is the better
    // of break-even and the trail under the peak, and it only ever moves up.
    trailAfterPct: numberFromEnv(env, "TRAIL_AFTER_PCT", 0.12, { min: 0.01, max: 5 }),
    trailPct: numberFromEnv(env, "TRAIL_PCT", 0.08, { min: 0.01, max: 0.9 }),
    // A position not covering its costs and no longer making highs is not working.
    stallMs: numberFromEnv(env, "STALL_MINUTES", 4, { min: 0.5, max: 120 }) * 60_000,
    // How long one position may be held at all, from entry. These coins pump fast and die fast:
    // reconstructing the measured session with a ten-minute cap turned -1.05 SOL into -0.53 SOL,
    // because the long holds were where the rugs landed, not where the gains were.
    maxHoldMs: numberFromEnv(env, "MAX_HOLD_MINUTES", 10, { min: 1, max: 1440 }) * 60_000,
    paperFeeBps: numberFromEnv(env, "PAPER_FEE_BPS", DEFAULTS.paperFeeBps, { min: 0, max: 5000 }),
    paperSlippageBps: numberFromEnv(env, "PAPER_SLIPPAGE_BPS", DEFAULTS.paperSlippageBps, { min: 0, max: 5000 }),

    // ---- bot 1: how wide and how fast it screens ----
    // How often bot 1 asks whether a GeckoTerminal call may go out. The budget, not this tick, is
    // what paces the calls; ticking faster than the budget costs nothing.
    discoveryTickMs: numberFromEnv(env, "DISCOVERY_TICK_MS", 1000, { min: 250, max: 600_000 }),
    // A call can take several seconds, so a few may be in the air at once.
    maxSweepsInFlight: numberFromEnv(env, "MAX_SWEEPS_IN_FLIGHT", 3, { min: 1, max: 8 }),
    // The ceiling, not a promise: GeckoTerminal documents 30/min but gives an individual IP less,
    // so the feed halves its own rate whenever it is refused and creeps back up towards this.
    geckoCallsPerMinute: numberFromEnv(env, "GECKO_CALLS_PER_MINUTE", 15, { min: 1, max: 30 }),
    geckoMinCallsPerMinute: numberFromEnv(env, "GECKO_MIN_CALLS_PER_MINUTE", 4, { min: 1, max: 30 }),
    refreshIntervalMs: numberFromEnv(env, "REFRESH_INTERVAL_MS", 2000, { min: 500, max: 60_000 }),
    refreshBatchSize: numberFromEnv(env, "REFRESH_BATCH_SIZE", 30, { min: 1, max: 30 }),
    // Calls per tick, run one after another. 3 x 30 coins every 2s is ~2,700 coin-refreshes a
    // minute; DexScreener was measured answering 133 calls/min (~4,000 coins) without complaint.
    refreshCallsPerTick: numberFromEnv(env, "REFRESH_CALLS_PER_TICK", 3, { min: 1, max: 10 }),
    maxUniverseTokens: numberFromEnv(env, "MAX_UNIVERSE_TOKENS", 20_000, { min: 100, max: 500_000 }),

    // ---- scout: the window the desk trades at all ----
    // Under 30 minutes a coin has no history to measure and its first candle is bots trading with
    // bots; past 72 hours the launch crowd has gone. Market cap band from the same reasoning: too
    // small and there is nothing to sell into, too large and a pump needs money the crowd has not
    // got. Coins outside the window are still watched — they can walk into it — but not handed on.
    window: {
      minAgeSeconds: numberFromEnv(env, "MIN_AGE_MINUTES", 30, { min: 0, max: 20_000 }) * 60,
      maxAgeSeconds: numberFromEnv(env, "MAX_AGE_HOURS", 72, { min: 0.1, max: 8760 }) * 3600,
      minMarketCapUsd: numberFromEnv(env, "MIN_MARKET_CAP_USD", 300_000, { min: 0 }),
      maxMarketCapUsd: numberFromEnv(env, "MAX_MARKET_CAP_USD", 20_000_000, { min: 1 }),
    },

    // ---- how often a coin is re-judged, and the analyst's pass mark ----
    rescoreIntervalMs: numberFromEnv(env, "RESCORE_INTERVAL_MS", 15_000, { min: 1000, max: 600_000 }),
    // Out of 100. Only this and above reaches the executor.
    passScore: numberFromEnv(env, "PASS_SCORE", 70, { min: 0, max: 100 }),

    // ---- filter: the hard kills ----
    // A coin already up this much in an hour has had its move; what is left is the giving-back.
    maxPriceChangeH1: numberFromEnv(env, "MAX_PRICE_CHANGE_H1", 80, { min: 1, max: 10_000 }),
    // How much of the deepest pool's LP must be burned or locked. Below this somebody can withdraw
    // the liquidity you were planning to sell into, which is the one loss a stop cannot help with.
    minLpLockedPct: numberFromEnv(env, "MIN_LP_LOCKED_PCT", 90, { min: 0, max: 100 }),
    // What the creator may still hold, and how much supply may sit in wallets that have traded the
    // token between themselves (RugCheck's insider networks — the bubble-map clusters).
    maxDevPct: numberFromEnv(env, "MAX_DEV_PCT", 3, { min: 0, max: 100 }),
    maxBundledPct: numberFromEnv(env, "MAX_BUNDLED_PCT", 10, { min: 0, max: 100 }),
    rugcheckCallsPerMinute: numberFromEnv(env, "RUGCHECK_CALLS_PER_MINUTE", 12, { min: 1, max: 15 }),

    gates: {
      minLiquidityUsd: numberFromEnv(env, "MIN_LIQUIDITY_USD", 25_000, { min: 0 }),
      minLiquidityRatio: numberFromEnv(env, "MIN_LIQUIDITY_RATIO", GATE_DEFAULTS.minLiquidityRatio, { min: 0, max: 1 }),
      minTradesH1: numberFromEnv(env, "MIN_TRADES_H1", GATE_DEFAULTS.minTradesH1, { min: 0, max: 100_000 }),
      minVolumeH1Usd: numberFromEnv(env, "MIN_VOLUME_H1_USD", GATE_DEFAULTS.minVolumeH1Usd, { min: 0 }),
      // Different wallets that bought this hour, and how many trades each of them may account for.
      // Volume and trade count can both be manufactured by a group trading with itself; the count
      // of distinct buyers is what that costs real money to fake.
      minBuyersH1: numberFromEnv(env, "MIN_BUYERS_H1", GATE_DEFAULTS.minBuyersH1, { min: 0, max: 100_000 }),
      maxTradesPerBuyer: numberFromEnv(env, "MAX_TRADES_PER_BUYER", GATE_DEFAULTS.maxTradesPerBuyer, { min: 1, max: 1000 }),
      // Selling WALLETS against buying wallets. A coin can show a healthy buy/sell split while the
      // wallets holding it leave one after another, which is what distribution looks like.
      maxSellerBuyerRatio: numberFromEnv(env, "MAX_SELLER_BUYER_RATIO", GATE_DEFAULTS.maxSellerBuyerRatio, { min: 1, max: 10 }),
      // The scout already turned away anything outside the window; these are the same numbers, so
      // a coin that drifts out of the band between the two stages is caught rather than traded.
      minMarketCapUsd: numberFromEnv(env, "MIN_MARKET_CAP_USD", 300_000, { min: 0 }),
      maxMarketCapUsd: numberFromEnv(env, "MAX_MARKET_CAP_USD", 20_000_000, { min: 1 }),
    },
    maxDevRugs: numberFromEnv(env, "MAX_DEV_RUGS", 1, { min: 0, max: 1000 }),
    maxDevLaunches: numberFromEnv(env, "MAX_DEV_LAUNCHES", 5, { min: 0, max: 100_000 }),
    rugDropPct: numberFromEnv(env, "RUG_DROP_PCT", 0.8, { min: 0.3, max: 0.99 }),
    maxTopHoldersPct: numberFromEnv(env, "MAX_TOP_HOLDERS_PCT", 35, { min: 1, max: 100 }),
    topHoldersCount: numberFromEnv(env, "TOP_HOLDERS_COUNT", 5, { min: 1, max: 19 }),
    topHoldersSkipLargest: boolFromEnv(env, "TOP_HOLDERS_SKIP_LARGEST", true),
    // Authorities the creator should no longer hold. Both are one field on the mint account.
    requireMintRevoked: boolFromEnv(env, "REQUIRE_MINT_REVOKED", true),
    requireFreezeRevoked: boolFromEnv(env, "REQUIRE_FREEZE_REVOKED", true),
    // How much SUPPLY may sit in wallets with no history. Counting fresh holders instead of what
    // they hold rejects nearly every young coin, because new coins are held by new wallets; what
    // is dangerous is a large share of supply behind addresses that appeared minutes ago.
    maxFreshSupplyPct: numberFromEnv(env, "MAX_FRESH_SUPPLY_PCT", 25, { min: 0, max: 100 }),
    // Holders funded by the same wallet are one actor: the cluster on a bubble map. Their combined
    // holding is what can be dumped in one go, so it is judged as a single holder — which means
    // the limit belongs near the single-holder limit, not at half the supply.
    maxClusterPct: numberFromEnv(env, "MAX_CLUSTER_PCT", 15, { min: 1, max: 100 }),
    // All clusters together, each wallet counted once: a map with several hubs is one actor using
    // several funders.
    maxLinkedSupplyPct: numberFromEnv(env, "MAX_LINKED_SUPPLY_PCT", 25, { min: 1, max: 100 }),
    // How many holders one wallet may have funded before the coin is refused on the COUNT alone,
    // whatever each of them holds — and how close together that funding has to be to mean
    // anything. Wallets funded months apart share an address because it is an exchange.
    maxClusterWallets: numberFromEnv(env, "MAX_CLUSTER_WALLETS", 3, { min: 2, max: 20 }),
    clusterBurstHours: numberFromEnv(env, "CLUSTER_BURST_HOURS", 72, { min: 0.5, max: 8760 }),
    // How many holders the funding graph is walked over. The RPC returns at most 20 accounts, and
    // every one of them costs up to two calls — but a cluster of twenty wallets at 1.5% each is
    // invisible to a top-5 check, which is the whole shape this is here to catch.
    clusterHolderCount: numberFromEnv(env, "CLUSTER_HOLDER_COUNT", 20, { min: 2, max: 20 }),
    freshWalletMaxTx: numberFromEnv(env, "FRESH_WALLET_MAX_TX", 8, { min: 1, max: 1000 }),
    freshWalletMaxAgeHours: numberFromEnv(env, "FRESH_WALLET_MAX_AGE_HOURS", 24, { min: 0.1, max: 8760 }),
    freshWalletLimit: numberFromEnv(env, "FRESH_WALLET_SIGNATURE_LIMIT", 50, { min: 5, max: 1000 }),

    // ---- executor: which entries it is allowed to take ----
    // dip      = only buy a pullback that bounces (best fill, misses coins that never dip)
    // breakout = only buy new highs (catches the steady climbers, worse fill)
    // both     = whichever comes first (default). Each entry records which trigger fired, so
    //            `npm run report` can show whether one of them is actually making the money.
    entryMode,

    // ---- executor: how closely it watches what it might buy ----
    watchPollIntervalMs: numberFromEnv(env, "WATCH_POLL_INTERVAL_MS", 3000, { min: 1000, max: 60_000 }),
    maxWatchlist: numberFromEnv(env, "MAX_WATCHLIST", 40, { min: 1, max: 500 }),
    // How long a coin may sit on the watchlist without ever triggering before it goes back and has
    // to earn its place again.
    watchGraceMs: numberFromEnv(env, "WATCH_GRACE_MS", 10 * 60_000, { min: 30_000, max: 6 * 3_600_000 }),
  };

  if (c.gates.minMarketCapUsd > c.gates.maxMarketCapUsd) {
    throw new Error("MIN_MARKET_CAP_USD cannot be greater than MAX_MARKET_CAP_USD.");
  }
  if (c.window.minAgeSeconds > c.window.maxAgeSeconds) {
    throw new Error("MIN_AGE_MINUTES cannot be greater than MAX_AGE_HOURS.");
  }
  if (c.minPositionSol > c.paperStartBalanceSol) {
    throw new Error("MIN_POSITION_SOL cannot exceed PAPER_START_BALANCE_SOL.");
  }
  if (c.stopPct >= c.trailAfterPct) {
    // The trail would arm below the stop, so the stop could never fire first: a configuration that
    // quietly removes the stop is worse than one that refuses to start.
    throw new Error("TRAIL_AFTER_PCT must be greater than STOP_PCT.");
  }
  if (c.geckoMinCallsPerMinute > c.geckoCallsPerMinute) {
    throw new Error("GECKO_MIN_CALLS_PER_MINUTE cannot be greater than GECKO_CALLS_PER_MINUTE.");
  }
  return c;
}
