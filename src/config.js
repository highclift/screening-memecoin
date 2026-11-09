const DEFAULTS = {
  paperStartBalanceSol: 1,
  buyAmountSol: 0.01,
  maxOpenPositions: 3,
  maxEntriesPerDay: 20,
  maxActiveCandidates: 500,
  minMarketCapSol: 0,
  maxMarketCapSol: 150,
  minTrades: 8,
  minBuys: 5,
  minUniqueBuyers: 4,
  maxCandidateAgeSeconds: 180,
  pullbackPct: 0.18,
  bouncePct: 0.06,
  takeProfitPct: 0.30,
  stopLossPct: 0.20,
  maxHoldSeconds: 300,
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

  const apiKey = (env.PUMPPORTAL_API_KEY ?? "").trim();
  if (!apiKey || apiKey === "replace_me") {
    throw new Error("Enter a valid PumpPortal API key. Paper trading uses live Pump.fun data.");
  }

  const c = {
    mode,
    dataSource,
    apiKey,
    paperStartBalanceSol: numberFromEnv(env, "PAPER_START_BALANCE_SOL", DEFAULTS.paperStartBalanceSol, { min: 0.000001 }),
    buyAmountSol: numberFromEnv(env, "BUY_AMOUNT_SOL", DEFAULTS.buyAmountSol, { min: 0.000001 }),
    maxOpenPositions: numberFromEnv(env, "MAX_OPEN_POSITIONS", DEFAULTS.maxOpenPositions, { min: 1, max: 100 }),
    maxEntriesPerDay: numberFromEnv(env, "MAX_ENTRIES_PER_DAY", DEFAULTS.maxEntriesPerDay, { min: 1, max: 10000 }),
    maxActiveCandidates: numberFromEnv(env, "MAX_ACTIVE_CANDIDATES", DEFAULTS.maxActiveCandidates, { min: 1, max: 10000 }),
    minMarketCapSol: numberFromEnv(env, "MIN_MARKET_CAP_SOL", DEFAULTS.minMarketCapSol),
    maxMarketCapSol: numberFromEnv(env, "MAX_MARKET_CAP_SOL", DEFAULTS.maxMarketCapSol, { min: 0.000001 }),
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

  if (c.minMarketCapSol > c.maxMarketCapSol) {
    throw new Error("MIN_MARKET_CAP_SOL cannot be greater than MAX_MARKET_CAP_SOL.");
  }
  if (c.minBuys > c.minTrades || c.minUniqueBuyers > c.minBuys) {
    throw new Error("MIN_TRADES must be >= MIN_BUYS, and MIN_BUYS must be >= MIN_UNIQUE_BUYERS.");
  }
  if (c.buyAmountSol > c.paperStartBalanceSol) {
    throw new Error("BUY_AMOUNT_SOL cannot exceed PAPER_START_BALANCE_SOL.");
  }
  return c;
}
