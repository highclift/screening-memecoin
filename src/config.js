const DEFAULTS = {
  paperStartBalanceSol: 1,
  buyAmountSol: 0.01,
  maxOpenPositions: 3,
  maxEntriesPerDay: 20,
  maxActiveCandidates: 500,
  minMarketCapUsd: 40_000,
  maxMarketCapUsd: 160_000,
  minTrades: 25,
  minBuys: 14,
  minUniqueBuyers: 8,
  maxCandidateAgeSeconds: 240,
  pullbackPct: 0.2,
  bouncePct: 0.05,
  takeProfitPct: 0.1,
  stopLossPct: 0.15,
  maxHoldSeconds: 180,
  paperFeeBps: 100,
  paperSlippageBps: 200,
  maxDailyLossSol: 0.05,
};

function numberFromEnv(env, name, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const mode = (env.MODE ?? "paper").trim().toLowerCase();
  if (mode !== "paper") {
    throw new Error("This build supports MODE=paper only; no live transactions are sent.");
  }

  const dataSource = "pumpportal";

  // TRADE_SOURCE=free   -> launches/migrations from PumpPortal (free) + prices from DexScreener/GeckoTerminal (free)
  // TRADE_SOURCE=pumpportal -> old behaviour (subscribeTokenTrade, needs wallet with >= 0.02 SOL)
  const tradeSource = (env.TRADE_SOURCE ?? "free").trim().toLowerCase();
  if (tradeSource !== "free" && tradeSource !== "pumpportal") {
    throw new Error("TRADE_SOURCE must be 'free' or 'pumpportal'.");
  }

  const socialMode = (env.SOCIAL_MODE ?? "twitter").trim().toLowerCase();
  if (!["off", "any", "multiple", "twitter"].includes(socialMode)) {
    throw new Error("SOCIAL_MODE must be off, any, multiple, or twitter.");
  }

  let apiKey = (env.PUMPPORTAL_API_KEY ?? "").trim();
  if (apiKey === "replace_me") apiKey = "";
  if (tradeSource === "pumpportal" && !apiKey) {
    throw new Error("Enter a valid PumpPortal API key (required when TRADE_SOURCE=pumpportal).");
  }

  const c = {
    mode,
    dataSource,
    tradeSource,
    socialMode,
    apiKey,
    pollIntervalMs: numberFromEnv(env, "POLL_INTERVAL_MS", 3000, { min: 1000, max: 60000 }),
    buyerCheckIntervalMs: numberFromEnv(env, "BUYER_CHECK_INTERVAL_MS", 5000, { min: 2000, max: 120000 }),
    paperStartBalanceSol: numberFromEnv(env, "PAPER_START_BALANCE_SOL", DEFAULTS.paperStartBalanceSol, { min: 0.000001 }),
    buyAmountSol: numberFromEnv(env, "BUY_AMOUNT_SOL", DEFAULTS.buyAmountSol, { min: 0.000001 }),
    maxOpenPositions: numberFromEnv(env, "MAX_OPEN_POSITIONS", DEFAULTS.maxOpenPositions, { min: 1, max: 100 }),
    maxEntriesPerDay: numberFromEnv(env, "MAX_ENTRIES_PER_DAY", DEFAULTS.maxEntriesPerDay, { min: 1, max: 10000 }),
    maxActiveCandidates: numberFromEnv(env, "MAX_ACTIVE_CANDIDATES", DEFAULTS.maxActiveCandidates, { min: 1, max: 10000 }),
    minMarketCapUsd: numberFromEnv(env, "MIN_MARKET_CAP_USD", DEFAULTS.minMarketCapUsd),
    maxMarketCapUsd: numberFromEnv(env, "MAX_MARKET_CAP_USD", DEFAULTS.maxMarketCapUsd, { min: 0.000001 }),
    minTrades: numberFromEnv(env, "MIN_TRADES", DEFAULTS.minTrades, { min: 1, max: 100000 }),
    minBuys: numberFromEnv(env, "MIN_BUYS", DEFAULTS.minBuys, { min: 1, max: 100000 }),
    minUniqueBuyers: numberFromEnv(env, "MIN_UNIQUE_BUYERS", DEFAULTS.minUniqueBuyers, { min: 1, max: 100000 }),
    maxCandidateAgeSeconds: numberFromEnv(env, "MAX_CANDIDATE_AGE_SECONDS", DEFAULTS.maxCandidateAgeSeconds, { min: 1, max: 86400 }),
    pullbackPct: numberFromEnv(env, "PULLBACK_PCT", DEFAULTS.pullbackPct, { min: 0.001, max: 0.95 }),
    bouncePct: numberFromEnv(env, "BOUNCE_PCT", DEFAULTS.bouncePct, { min: 0.001, max: 2 }),
    takeProfitPct: numberFromEnv(env, "TAKE_PROFIT_PCT", DEFAULTS.takeProfitPct, { min: 0.001, max: 100 }),
    stopLossPct: numberFromEnv(env, "STOP_LOSS_PCT", DEFAULTS.stopLossPct, { min: 0.001, max: 0.99 }),
    maxHoldSeconds: numberFromEnv(env, "MAX_HOLD_SECONDS", DEFAULTS.maxHoldSeconds, { min: 1, max: 86400 }),
    paperFeeBps: numberFromEnv(env, "PAPER_FEE_BPS", DEFAULTS.paperFeeBps, { min: 0, max: 5000 }),
    paperSlippageBps: numberFromEnv(env, "PAPER_SLIPPAGE_BPS", DEFAULTS.paperSlippageBps, { min: 0, max: 5000 }),
    maxDailyLossSol: numberFromEnv(env, "MAX_DAILY_LOSS_SOL", DEFAULTS.maxDailyLossSol),
  };

  if (c.minMarketCapUsd > c.maxMarketCapUsd) {
    throw new Error("MIN_MARKET_CAP_USD cannot be greater than MAX_MARKET_CAP_USD.");
  }
  if (c.minBuys > c.minTrades || c.minUniqueBuyers > c.minBuys) {
    throw new Error("MIN_TRADES must be >= MIN_BUYS, and MIN_BUYS must be >= MIN_UNIQUE_BUYERS.");
  }
  if (c.buyAmountSol > c.paperStartBalanceSol) {
    throw new Error("BUY_AMOUNT_SOL cannot exceed PAPER_START_BALANCE_SOL.");
  }
  return c;
}
