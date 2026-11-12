// What the dashboard is allowed to change, grouped by the agent that owns it.
//
// Each agent's gear icon opens the group named here. The grouping is not cosmetic: a setting
// belongs to the agent that READS it, so that changing it has a visible effect on that one row of
// the rail. Settings no agent owns (the data-source URL, the API key, MODE) are not here at all —
// they stay in .env, where changing them means restarting on purpose.
//
// There are no default values in this file. Every default is read back out of `loadConfig`, so
// `src/config.js` stays the only place a default is written down; a field here just says where its
// value lives in the config object and what units to show it in.
//
//   path        where the value lands in the config object
//   configScale config value  ->  env value   (seconds -> minutes, ms -> minutes)
//   envScale    env value     ->  shown value (0.08 -> 8%, 15000ms -> 15s)
//
// so  shown = config * configScale * envScale,  and the env string written back is shown / envScale.

export const AGENT_SETTINGS = {
  scout: {
    title: "Scout",
    blurb: "The window the desk trades at all, and how wide it looks.",
    fields: [
      {
        name: "MIN_AGE_MINUTES", path: "window.minAgeSeconds", configScale: 1 / 60,
        label: "Minimum age", unit: "minutes", min: 0, max: 20000, step: 1,
        help: "Under this a coin has no history to measure and its first candle is bots trading with bots.",
      },
      {
        name: "MAX_AGE_HOURS", path: "window.maxAgeSeconds", configScale: 1 / 3600,
        label: "Maximum age", unit: "hours", min: 0.1, max: 8760, step: 0.5,
        help: "Past this the launch crowd has gone and what is left is a chart, not an event.",
      },
      {
        name: "MIN_MARKET_CAP_USD", path: "window.minMarketCapUsd",
        label: "Minimum market cap", unit: "USD", min: 0, step: 1000,
        help: "Below this there is nothing to sell into. Also used by the filter, so a coin that drifts out of the band between the two stages is caught rather than traded.",
      },
      {
        name: "MAX_MARKET_CAP_USD", path: "window.maxMarketCapUsd",
        label: "Maximum market cap", unit: "USD", min: 1, step: 1000,
        help: "Above this a pump needs more money than the crowd has got.",
      },
      {
        name: "GECKO_CALLS_PER_MINUTE", path: "geckoCallsPerMinute",
        label: "GeckoTerminal budget", unit: "calls/min", min: 1, max: 30, step: 1,
        help: "A ceiling, not a promise. The feed halves its own rate whenever it is refused and creeps back up, but never past a rate that was already refused. Raising this does not fix a 429.",
      },
      {
        name: "REFRESH_INTERVAL_MS", path: "refreshIntervalMs", envScale: 1 / 1000,
        label: "DexScreener re-check", unit: "seconds", min: 0.5, max: 60, step: 0.5,
        help: "How often a batch of known coins is re-priced. This is what catches an old coin waking up.",
      },
    ],
  },

  filter: {
    title: "Filter",
    blurb: "Hard kills only. A coin that fails one of these cannot be traded honestly, so no score rescues it.",
    fields: [
      {
        name: "MIN_LIQUIDITY_USD", path: "gates.minLiquidityUsd",
        label: "Minimum liquidity", unit: "USD", min: 0, step: 1000,
        help: "The pool you would have to sell back into.",
      },
      {
        name: "MIN_LIQUIDITY_RATIO", path: "gates.minLiquidityRatio", envScale: 100,
        label: "Liquidity vs market cap", unit: "% of mcap", min: 0, max: 100, step: 0.1,
        help: "A $5M coin behind a $20k pool is a trap, however deep that pool looks on its own.",
      },
      {
        name: "MIN_LP_LOCKED_PCT", path: "minLpLockedPct",
        label: "LP burned or locked", unit: "%", min: 0, max: 100, step: 1,
        help: "Below this somebody can still withdraw the liquidity you were planning to sell into — which is what a rug actually is: not a price falling, a pool ceasing to exist.",
      },
      {
        name: "MAX_DEV_PCT", path: "maxDevPct",
        label: "Creator may hold", unit: "%", min: 0, max: 100, step: 0.5,
        help: "What the creator still holds and could sell into you.",
      },
      {
        name: "MAX_BUNDLED_PCT", path: "maxBundledPct",
        label: "Bundled / insider supply", unit: "%", min: 0, max: 100, step: 0.5,
        help: "Supply sitting in wallets that have passed the token between themselves — the clusters a bubble map draws.",
      },
      {
        name: "MAX_PRICE_CHANGE_H1", path: "maxPriceChangeH1",
        label: "Already up in 1h", unit: "%", min: 1, max: 10000, step: 5,
        help: "A coin already up this much has had its move; what is left is the giving-back.",
      },
      {
        name: "MIN_BUYERS_H1", path: "gates.minBuyersH1",
        label: "Distinct buyers in 1h", unit: "wallets", min: 0, max: 100000, step: 1,
        help: "Volume and trade count are both free for a group trading with itself. The count of DIFFERENT wallets is the part that costs real money to fake.",
      },
      {
        name: "MAX_TRADES_PER_BUYER", path: "gates.maxTradesPerBuyer",
        label: "Trades per buyer", unit: "trades", min: 1, max: 1000, step: 1,
        help: "Above this the volume is a handful of wallets going back and forth.",
      },
      {
        name: "MAX_SELLER_BUYER_RATIO", path: "gates.maxSellerBuyerRatio",
        label: "Sellers vs buyers", unit: "ratio", min: 1, max: 10, step: 0.05,
        help: "Selling WALLETS against buying wallets. 1.25 refuses a coin once half again as many wallets are getting out as are getting in.",
      },
      {
        name: "MIN_TRADES_H1", path: "gates.minTradesH1",
        label: "Trades in 1h", unit: "trades", min: 0, max: 100000, step: 1,
        help: "Below this the coin is dead, not quiet.",
      },
      {
        name: "MIN_VOLUME_H1_USD", path: "gates.minVolumeH1Usd",
        label: "Volume in 1h", unit: "USD", min: 0, step: 100,
      },
      {
        name: "REQUIRE_MINT_REVOKED", path: "requireMintRevoked", type: "bool",
        label: "Mint authority revoked",
        help: "The creator must no longer be able to print more supply.",
      },
      {
        name: "REQUIRE_FREEZE_REVOKED", path: "requireFreezeRevoked", type: "bool",
        label: "Freeze authority revoked",
        help: "The creator must no longer be able to freeze your tokens so you cannot sell.",
      },
    ],
  },

  analyst: {
    title: "Analyst",
    blurb: "Scores what survived the filter, out of 100. An unmeasured coin scores 50, so nothing is bought on a shrug.",
    fields: [
      {
        name: "PASS_SCORE", path: "passScore",
        label: "Pass mark", unit: "/ 100", min: 0, max: 100, step: 1,
        help: "Only this and above reaches the executor. Built from momentum, unique buyers, buy/sell ratio, holder growth, liquidity against market cap, and smart wallets.",
      },
      {
        name: "RESCORE_INTERVAL_MS", path: "rescoreIntervalMs", envScale: 1 / 1000,
        label: "Re-judge every", unit: "seconds", min: 1, max: 600, step: 1,
        help: "Every coin the scout keeps seeing is put through the filter and the analyst again this often, so a coin that fails a check now is free to pass it shortly after.",
      },
    ],
  },

  executor: {
    title: "Executor",
    blurb: "The only agent that touches a position. It measures each coin's own volatility before it will buy it.",
    fields: [
      {
        name: "ENTRY_MODE", path: "entryMode", type: "enum", options: ["dip", "breakout", "both"],
        label: "Entry trigger",
        help: "dip buys a pullback that bounces (best fill, misses steady climbers); breakout buys new highs (worse fill, catches them); both takes whichever comes first.",
      },
      {
        name: "MAX_HOLD_MINUTES", path: "maxHoldMs", configScale: 1 / 60000,
        label: "Maximum hold", unit: "minutes", min: 1, max: 1440, step: 1,
        help: "These coins pump fast and die fast. Replaying a measured session with a ten-minute cap turned -1.05 SOL into -0.53 SOL, because the long holds were where the rugs landed.",
      },
      {
        name: "STALL_MINUTES", path: "stallMs", configScale: 1 / 60000,
        label: "Stall out after", unit: "minutes", min: 0.5, max: 120, step: 0.5,
        help: "A position not covering its costs and no longer making new highs is not working.",
      },
      {
        name: "WATCH_POLL_INTERVAL_MS", path: "watchPollIntervalMs", envScale: 1 / 1000,
        label: "Watch a candidate every", unit: "seconds", min: 1, max: 60, step: 1,
      },
      {
        name: "MAX_WATCHLIST", path: "maxWatchlist",
        label: "Watchlist size", unit: "coins", min: 1, max: 500, step: 1,
      },
      {
        name: "WATCH_GRACE_MS", path: "watchGraceMs", envScale: 1 / 60000,
        label: "Give up watching after", unit: "minutes", min: 0.5, max: 360, step: 1,
        help: "A candidate that never triggers an entry goes back and has to earn its place again.",
      },
    ],
  },

  risk: {
    title: "Risk",
    blurb: "Owns the money: the size, the permission to trade at all, and the shape of every trade.",
    fields: [
      {
        name: "POSITION_PCT", path: "positionPct", envScale: 100,
        label: "Size per trade", unit: "% of balance", min: 0.1, max: 100, step: 0.5,
        help: "A share of the CURRENT balance, not a fixed amount, so the desk scales itself down after a bad night instead of betting the same size into a smaller account.",
      },
      {
        name: "MIN_POSITION_SOL", path: "minPositionSol",
        label: "Smallest position", unit: "SOL", min: 0.000001, step: 0.001,
      },
      {
        name: "MAX_OPEN_POSITIONS", path: "maxOpenPositions",
        label: "Open at once", unit: "positions", min: 1, max: 100, step: 1,
      },
      {
        name: "MAX_ENTRIES_PER_DAY", path: "maxEntriesPerDay",
        label: "Entries per day", unit: "entries", min: 1, max: 10000, step: 1,
      },
      {
        name: "MAX_DAILY_LOSS_SOL", path: "maxDailyLossSol",
        label: "Daily loss limit", unit: "SOL", min: 0, step: 0.01,
        help: "Once the day's realised loss reaches this the desk refuses every new entry until 00:00 UTC. It keeps screening; it just stops buying.",
      },
      {
        name: "STOP_PCT", path: "stopPct", envScale: 100,
        label: "Hard stop", unit: "%", min: 1, max: 90, step: 0.5,
        help: "Fixed before the entry is taken and never widened. It cannot save you from a rug: those go from above the stop to near zero between two polls.",
      },
      {
        name: "TRAIL_AFTER_PCT", path: "trailAfterPct", envScale: 100,
        label: "Arm the trail at", unit: "%", min: 1, max: 500, step: 0.5,
        help: "Nothing trails until the position has been this far up. Must be greater than the hard stop, or the stop could never fire first and the desk refuses to start.",
      },
      {
        name: "TRAIL_PCT", path: "trailPct", envScale: 100,
        label: "Trail distance", unit: "%", min: 1, max: 90, step: 0.5,
        help: "Once armed, the floor is the better of break-even and this far under the peak, and it only ever moves up.",
      },
      {
        name: "PAPER_FEE_BPS", path: "paperFeeBps",
        label: "Simulated fee", unit: "bps per side", min: 0, max: 5000, step: 5,
        help: "This and the slippage decide more about the measured P&L than any strategy choice. 100 + 200 bps is a 6% round trip, far above a real Solana AMM swap; 30 / 70 is closer to reality.",
      },
      {
        name: "PAPER_SLIPPAGE_BPS", path: "paperSlippageBps",
        label: "Simulated slippage", unit: "bps per side", min: 0, max: 5000, step: 5,
      },
    ],
  },

  logger: {
    title: "Logger",
    blurb: "Every agent reports here. Each refusal is written with its reason and the agent that made it.",
    fields: [
      {
        name: "MAX_UNIVERSE_TOKENS", path: "maxUniverseTokens",
        label: "Coins held in memory", unit: "coins", min: 100, max: 500000, step: 100,
        help: "The ones seen longest ago are dropped first. Coins through the filter and coins being held are never dropped.",
      },
    ],
  },
};

/** Every field, flattened, in the order the groups declare them. */
export function allFields() {
  return Object.values(AGENT_SETTINGS).flatMap((group) => group.fields);
}

const fieldsByName = new Map(allFields().map((field) => [field.name, field]));
export const isSettingName = (name) => fieldsByName.has(name);
export const fieldFor = (name) => fieldsByName.get(name);

function readPath(config, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), config);
}

/** The value to SHOW for one field, read out of a loaded config. */
export function shownValue(config, field) {
  const raw = readPath(config, field.path);
  if (field.type === "bool") return Boolean(raw);
  if (field.type === "enum") return String(raw);
  const value = Number(raw) * (field.configScale ?? 1) * (field.envScale ?? 1);
  // Scaling by 1/60 and friends leaves values like 29.999999999999996; these are all human-sized
  // numbers, so rounding to six places is lossless here and keeps the input box readable.
  return Number(value.toFixed(6));
}

/** Every shown value, keyed by env name. */
export function shownValues(config) {
  return Object.fromEntries(allFields().map((field) => [field.name, shownValue(config, field)]));
}

/** One shown value turned back into the string the env var takes. */
export function envValue(field, shown) {
  if (field.type === "bool") return shown ? "true" : "false";
  if (field.type === "enum") return String(shown);
  const value = Number(shown) / (field.envScale ?? 1);
  if (!Number.isFinite(value)) throw new Error(`${field.label} must be a number.`);
  return String(Number(value.toFixed(8)));
}

/**
 * Turn a patch of shown values into env overrides, rejecting anything not declared above.
 * Range and cross-field checks are left to `loadConfig`, which owns them.
 */
export function envOverrides(patch = {}) {
  const env = {};
  for (const [name, shown] of Object.entries(patch)) {
    const field = fieldFor(name);
    if (!field) throw new Error(`${name} is not a setting the dashboard may change.`);
    if (field.type === "enum" && !(field.options ?? []).includes(String(shown))) {
      throw new Error(`${field.label} must be one of: ${(field.options ?? []).join(", ")}.`);
    }
    if (field.type !== "bool" && field.type !== "enum" && !Number.isFinite(Number(shown))) {
      throw new Error(`${field.label} must be a number.`);
    }
    env[name] = envValue(field, shown);
  }
  return env;
}

/** The schema the dashboard renders, without the server-only plumbing. */
export function publicSchema() {
  return Object.fromEntries(
    Object.entries(AGENT_SETTINGS).map(([agent, group]) => [
      agent,
      {
        title: group.title,
        blurb: group.blurb,
        fields: group.fields.map((field) => ({
          name: field.name,
          label: field.label,
          help: field.help ?? "",
          type: field.type ?? "number",
          unit: field.unit ?? "",
          ...(field.options ? { options: field.options } : {}),
          ...(field.min !== undefined ? { min: field.min } : {}),
          ...(field.max !== undefined ? { max: field.max } : {}),
          ...(field.step !== undefined ? { step: field.step } : {}),
        })),
      },
    ]),
  );
}
