import { numberFromEnv } from "./envutil.js";

// A "lane" is an independent paper bot: its own discovery source, thresholds and paper balance.
// All lanes share the same filter / analyst / journal code.
//   fresh   : tokens that just migrated to an AMM pool (PumpPortal migration events)
//   young   : pools 1 hour .. 24 hours old, found through GeckoTerminal trending / top pools
//   veteran : pools 1 day .. 30 days old, found the same way
export const LANE_IDS = ["fresh", "young", "veteran"];
export const AGE_LANE_IDS = ["young", "veteran"];
export const LANE_LABELS = { fresh: "Fresh", young: "Young", veteran: "Veteran" };

const HOUR = 3600;
const DAY = 86_400;
export const LANE_AGE_BANDS = { young: [HOUR, DAY], veteran: [DAY, 30 * DAY] };

// [config key, env suffix, min, max]. Env names are <LANE>_<SUFFIX>, e.g. YOUNG_MIN_TRADES.
const SPECS = [
  ["minMarketCapUsd", "MIN_MARKET_CAP_USD", 0, 1e12],
  ["maxMarketCapUsd", "MAX_MARKET_CAP_USD", 1, 1e12],
  ["minLiquidityUsd", "MIN_LIQUIDITY_USD", 0, 1e12],
  ["minVolumeH1Usd", "MIN_VOLUME_H1_USD", 0, 1e12],
  ["minTrades", "MIN_TRADES", 1, 1e6],
  ["minBuys", "MIN_BUYS", 1, 1e6],
  ["minUniqueBuyers", "MIN_UNIQUE_BUYERS", 1, 1e6],
  ["maxCandidateAgeSeconds", "MAX_CANDIDATE_AGE_SECONDS", 1, 86_400],
  ["pullbackPct", "PULLBACK_PCT", 0.001, 0.95],
  ["bouncePct", "BOUNCE_PCT", 0.001, 2],
  ["takeProfitPct", "TAKE_PROFIT_PCT", 0.001, 100],
  ["stopLossPct", "STOP_LOSS_PCT", 0.001, 0.99],
  ["maxHoldSeconds", "MAX_HOLD_SECONDS", 1, 86_400],
  ["minScore", "MIN_SCORE", 0, 1],
  ["maxEntriesPerDay", "MAX_ENTRIES_PER_DAY", 1, 10_000],
  ["maxOpenPositions", "MAX_OPEN_POSITIONS", 1, 100],
  ["maxActiveCandidates", "MAX_ACTIVE_CANDIDATES", 1, 10_000],
  ["buyAmountSol", "BUY_AMOUNT_SOL", 0.000001, 1e6],
  ["paperStartBalanceSol", "PAPER_START_BALANCE_SOL", 0.000001, 1e9],
  ["maxDailyLossSol", "MAX_DAILY_LOSS_SOL", 0, 1e9],
  ["pollIntervalMs", "POLL_INTERVAL_MS", 1000, 60_000],
];

// Starting points, NOT validated. Older coins have deeper pools and more history, so they get higher
// liquidity/volume floors, bigger market-cap ranges and slower, wider exits. Tune from the journal.
// Activity numbers are over the last HOUR (fresh uses the last 5 minutes).
const LANE_DEFAULTS = {
  young: {
    minMarketCapUsd: 60_000, maxMarketCapUsd: 1_500_000, minLiquidityUsd: 15_000, minVolumeH1Usd: 20_000,
    minTrades: 150, minBuys: 70, minUniqueBuyers: 40, maxCandidateAgeSeconds: 900,
    pullbackPct: 0.15, bouncePct: 0.04, takeProfitPct: 0.15, stopLossPct: 0.12, maxHoldSeconds: 900,
    minScore: 0.5, maxEntriesPerDay: 15, maxOpenPositions: 3, maxActiveCandidates: 150,
    buyAmountSol: 0.01, paperStartBalanceSol: 1, pollIntervalMs: 6000,
  },
  veteran: {
    minMarketCapUsd: 250_000, maxMarketCapUsd: 10_000_000, minLiquidityUsd: 50_000, minVolumeH1Usd: 40_000,
    minTrades: 200, minBuys: 90, minUniqueBuyers: 50, maxCandidateAgeSeconds: 1800,
    pullbackPct: 0.10, bouncePct: 0.03, takeProfitPct: 0.12, stopLossPct: 0.10, maxHoldSeconds: 1800,
    minScore: 0.5, maxEntriesPerDay: 10, maxOpenPositions: 3, maxActiveCandidates: 100,
    buyAmountSol: 0.01, paperStartBalanceSol: 1, pollIntervalMs: 10_000,
  },
};

// Cooldown before a pool that was already looked at can be considered again (rejections included,
// so the same listing is not re-counted every discovery cycle).
export const LANE_COOLDOWN_MS = { young: 30 * 60_000, veteran: 2 * 60 * 60_000 };

export function laneForAge(ageSeconds) {
  if (!Number.isFinite(ageSeconds)) return null;
  for (const id of AGE_LANE_IDS) {
    const [min, max] = LANE_AGE_BANDS[id];
    if (ageSeconds >= min && ageSeconds < max) return id;
  }
  return null;
}

// Builds the per-lane effective config: the base config with the lane's own overrides applied.
// `base` must not already contain a `lanes` key.
export function buildLanes(env, base) {
  const requested = (env.LANES ?? "fresh,young,veteran").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const id of requested) {
    if (!LANE_IDS.includes(id)) throw new Error(`LANES contains unknown lane '${id}'. Valid lanes: ${LANE_IDS.join(", ")}.`);
  }

  const lanes = {
    fresh: {
      id: "fresh",
      label: LANE_LABELS.fresh,
      enabled: requested.includes("fresh"),
      requested: requested.includes("fresh"),
      cfg: { ...base, laneId: "fresh", minVolumeH1Usd: 0, activityWindow: "m5", useReportedMarketCap: false },
    },
  };

  for (const id of AGE_LANE_IDS) {
    const prefix = id.toUpperCase();
    const overrides = {};
    for (const [key, suffix, min, max] of SPECS) {
      overrides[key] = numberFromEnv(env, `${prefix}_${suffix}`, LANE_DEFAULTS[id][key] ?? base[key], { min, max });
    }
    const socialMode = (env[`${prefix}_SOCIAL_MODE`] ?? "any").trim().toLowerCase();
    if (!["off", "any", "multiple", "twitter"].includes(socialMode)) {
      throw new Error(`${prefix}_SOCIAL_MODE must be off, any, multiple, or twitter.`);
    }
    if (overrides.minMarketCapUsd > overrides.maxMarketCapUsd) {
      throw new Error(`${prefix}_MIN_MARKET_CAP_USD cannot be greater than ${prefix}_MAX_MARKET_CAP_USD.`);
    }
    if (overrides.minBuys > overrides.minTrades || overrides.minUniqueBuyers > overrides.minBuys) {
      throw new Error(`${prefix}_MIN_TRADES must be >= ${prefix}_MIN_BUYS, and ${prefix}_MIN_BUYS must be >= ${prefix}_MIN_UNIQUE_BUYERS.`);
    }
    if (overrides.buyAmountSol > overrides.paperStartBalanceSol) {
      throw new Error(`${prefix}_BUY_AMOUNT_SOL cannot exceed ${prefix}_PAPER_START_BALANCE_SOL.`);
    }
    const [minAgeSeconds, maxAgeSeconds] = LANE_AGE_BANDS[id];
    lanes[id] = {
      id,
      label: LANE_LABELS[id],
      // Age lanes need per-token polling + discovery, which only exist in the free data mode.
      enabled: requested.includes(id) && base.tradeSource === "free",
      requested: requested.includes(id),
      minAgeSeconds,
      maxAgeSeconds,
      cfg: { ...base, ...overrides, socialMode, laneId: id, activityWindow: "h1", useReportedMarketCap: true },
    };
  }
  return lanes;
}
