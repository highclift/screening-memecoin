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
  buyAmountSol: 0.01,
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

    // ---- money (the dashboard form) ----
    paperStartBalanceSol: numberFromEnv(env, "PAPER_START_BALANCE_SOL", DEFAULTS.paperStartBalanceSol, { min: 0.000001 }),
    buyAmountSol: numberFromEnv(env, "BUY_AMOUNT_SOL", DEFAULTS.buyAmountSol, { min: 0.000001 }),
    maxOpenPositions: numberFromEnv(env, "MAX_OPEN_POSITIONS", DEFAULTS.maxOpenPositions, { min: 1, max: 100 }),
    maxEntriesPerDay: numberFromEnv(env, "MAX_ENTRIES_PER_DAY", DEFAULTS.maxEntriesPerDay, { min: 1, max: 10_000 }),
    maxDailyLossSol: numberFromEnv(env, "MAX_DAILY_LOSS_SOL", DEFAULTS.maxDailyLossSol, { min: 0 }),
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

    // ---- bot 2: how often a coin is re-judged, and where green starts ----
    rescoreIntervalMs: numberFromEnv(env, "RESCORE_INTERVAL_MS", 15_000, { min: 1000, max: 600_000 }),
    greenScore: numberFromEnv(env, "GREEN_SCORE", 0.58, { min: 0, max: 1 }),
    watchScore: numberFromEnv(env, "WATCH_SCORE", 0.4, { min: 0, max: 1 }),
    maxGreenCoins: numberFromEnv(env, "MAX_GREEN_COINS", 60, { min: 1, max: 1000 }),

    // ---- bot 2: safety floors (not strategy) ----
    gates: {
      minLiquidityUsd: numberFromEnv(env, "MIN_LIQUIDITY_USD", GATE_DEFAULTS.minLiquidityUsd, { min: 0 }),
      minLiquidityRatio: numberFromEnv(env, "MIN_LIQUIDITY_RATIO", GATE_DEFAULTS.minLiquidityRatio, { min: 0, max: 1 }),
      minTradesH1: numberFromEnv(env, "MIN_TRADES_H1", GATE_DEFAULTS.minTradesH1, { min: 0, max: 100_000 }),
      minVolumeH1Usd: numberFromEnv(env, "MIN_VOLUME_H1_USD", GATE_DEFAULTS.minVolumeH1Usd, { min: 0 }),
      minMarketCapUsd: numberFromEnv(env, "MIN_MARKET_CAP_USD", GATE_DEFAULTS.minMarketCapUsd, { min: 0 }),
      maxMarketCapUsd: numberFromEnv(env, "MAX_MARKET_CAP_USD", GATE_DEFAULTS.maxMarketCapUsd, { min: 1 }),
    },
    maxDevRugs: numberFromEnv(env, "MAX_DEV_RUGS", 1, { min: 0, max: 1000 }),
    maxDevLaunches: numberFromEnv(env, "MAX_DEV_LAUNCHES", 5, { min: 0, max: 100_000 }),
    rugDropPct: numberFromEnv(env, "RUG_DROP_PCT", 0.8, { min: 0.3, max: 0.99 }),
    maxTopHoldersPct: numberFromEnv(env, "MAX_TOP_HOLDERS_PCT", 35, { min: 1, max: 100 }),
    topHoldersCount: numberFromEnv(env, "TOP_HOLDERS_COUNT", 5, { min: 1, max: 19 }),
    topHoldersSkipLargest: boolFromEnv(env, "TOP_HOLDERS_SKIP_LARGEST", true),

    // ---- bot 3: which entries it is allowed to take ----
    // dip      = only buy a pullback that bounces (best fill, misses coins that never dip)
    // breakout = only buy new highs (catches the steady climbers, worse fill)
    // both     = whichever comes first (default). Each entry records which trigger fired, so
    //            `npm run report` can show whether one of them is actually making the money.
    entryMode,

    // ---- bot 3: how closely it watches what it might buy ----
    watchPollIntervalMs: numberFromEnv(env, "WATCH_POLL_INTERVAL_MS", 3000, { min: 1000, max: 60_000 }),
    maxWatchlist: numberFromEnv(env, "MAX_WATCHLIST", 40, { min: 1, max: 500 }),
    greenGraceMs: numberFromEnv(env, "GREEN_GRACE_MS", 10 * 60_000, { min: 30_000, max: 6 * 3_600_000 }),
  };

  if (c.gates.minMarketCapUsd > c.gates.maxMarketCapUsd) {
    throw new Error("MIN_MARKET_CAP_USD cannot be greater than MAX_MARKET_CAP_USD.");
  }
  if (c.buyAmountSol > c.paperStartBalanceSol) {
    throw new Error("BUY_AMOUNT_SOL cannot exceed PAPER_START_BALANCE_SOL.");
  }
  if (c.watchScore > c.greenScore) {
    throw new Error("WATCH_SCORE cannot be greater than GREEN_SCORE.");
  }
  if (c.geckoMinCallsPerMinute > c.geckoCallsPerMinute) {
    throw new Error("GECKO_MIN_CALLS_PER_MINUTE cannot be greater than GECKO_CALLS_PER_MINUTE.");
  }
  return c;
}
