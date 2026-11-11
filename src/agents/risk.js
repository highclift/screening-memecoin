// AGENT 5 — RISK
//
// Owns the money. The executor decides WHICH coin and WHEN; every question about how much, whether
// a trade is allowed at all, and when a position ends is answered here. They are deliberately
// separate agents: a desk where the thing hunting for entries also decides its own position size
// and its own stop is a desk with no risk management, only opinions.
//
// The shape of a trade:
//
//   size      — `positionPct` of the paper balance, never more than what is left
//   stop      — a flat `stopPct` below entry, FIXED BEFORE THE ENTRY IS TAKEN and never widened
//   trail     — nothing trails until the position has been `trailAfterPct` up. From that point the
//               floor is the better of break-even and `trailPct` under the peak, and it only moves
//               up. So a trade that got far enough into profit cannot go back to being a loss.
//   time      — a hard cap from entry, because on this market the thing that arrives after the move
//               is finished is usually a rug rather than a second leg.
//
// Every refusal is logged as a kill, same as any other agent: a night where nothing traded should
// say whether that was the filter or the daily loss limit.

import fs from "node:fs";
import { buyShare, roundTripCostPct } from "../signals.js";
import { currentUtcDay } from "../state.js";

const HALT_FILE = ".halt";

export function createRisk({ config, account, logger, persist }) {
  const stats = { blocked: 0, exits: 0, stops: 0, trails: 0, timeouts: 0 };
  const blocks = {}; // reason -> how many entries it stopped
  let lastBlock = "";

  const fee = () => config.paperFeeBps / 10_000;
  const slippage = () => config.paperSlippageBps / 10_000;
  const costPct = () => roundTripCostPct(config);

  function resetDailyIfNeeded() {
    const today = currentUtcDay();
    if (account.daily?.day !== today) {
      account.daily = { day: today, entries: 0, realizedPnlSol: 0 };
      persist();
    }
  }

  // What one trade is allowed to cost. A share of what is in the account rather than a fixed
  // number, so the desk scales itself down after a bad night instead of betting the same size into
  // a smaller balance.
  function sizeSol() {
    const wanted = account.balanceSol * config.positionPct;
    return Math.min(wanted, account.balanceSol);
  }

  // The levels, settled before the position exists. `volPct` is the coin's own measured move and is
  // only used to keep the trail from sitting inside the noise — the stop itself is the spec's flat
  // number, not something derived.
  function levelsFor(volPct = null) {
    const cost = costPct();
    const trail = Math.max(
      config.trailPct,
      cost * 1.5,
      Number.isFinite(volPct) && volPct > 0 ? Math.min(volPct * 2, 0.2) : 0,
    );
    return {
      stopPct: config.stopPct,
      trailAfterPct: config.trailAfterPct,
      trailPct: Number(trail.toFixed(4)),
      breakEvenPct: Number(cost.toFixed(4)),
      costPct: Number(cost.toFixed(4)),
      volPct: Number.isFinite(volPct) ? Number(volPct.toFixed(4)) : null,
      stallMs: config.stallMs,
      maxHoldMs: config.maxHoldMs,
    };
  }

  return {
    sizeSol,
    levelsFor,
    costPct,
    fee,
    slippage,

    // May a new position be opened right now? Returns "" when yes, or the reason when no. Nothing
    // about the coin is considered here — that was settled three agents ago.
    blockReason(record = null, now = Date.now()) {
      resetDailyIfNeeded();
      let reason = "";
      if (fs.existsSync(HALT_FILE)) reason = "file .halt aktif";
      else if (Object.keys(account.positions).length >= config.maxOpenPositions) {
        reason = `batas ${config.maxOpenPositions} posisi terbuka`;
      } else if (account.daily.entries >= config.maxEntriesPerDay) {
        reason = `batas ${config.maxEntriesPerDay} entry per hari`;
      } else if (config.maxDailyLossSol > 0 && account.daily.realizedPnlSol <= -config.maxDailyLossSol) {
        reason = `batas rugi harian ${config.maxDailyLossSol} SOL`;
      } else if (sizeSol() < config.minPositionSol) {
        reason = "saldo paper tidak cukup";
      }

      if (!reason) {
        lastBlock = "";
        return "";
      }
      blocks[reason] = (blocks[reason] ?? 0) + 1;
      // Logged once per change of reason: the limit is hit on every tick while it holds, and a
      // thousand identical lines would bury the one that matters.
      if (reason !== lastBlock) {
        lastBlock = reason;
        stats.blocked += 1;
        logger.kill("risk", record, { category: "money_limit", detail: reason }, now);
        logger.tell("blocked", `Entry tertahan: ${reason}; koin tetap dipantau.`, record?.mint ?? "");
      }
      return reason;
    },

    // Is this position over? Returns the exit reason, or null to hold.
    exitReason(position, marketCapUsd, now = Date.now(), record = null) {
      const levels = position.levels ?? levelsFor(null);
      const entry = position.entryMarketCapUsd;
      if (!Number.isFinite(marketCapUsd) || !Number.isFinite(entry) || entry <= 0) return null;

      const peak = Math.max(position.peakMarketCapUsd ?? entry, entry);
      const peakGain = peak / entry - 1;
      const gain = marketCapUsd / entry - 1;
      // Armed once the trade has been far enough up. This latches: a position that touched +12%
      // keeps its ratcheted floor even if it falls back below.
      const armed = position.armed || peakGain >= levels.trailAfterPct;

      if (armed) {
        // The floor is the better of break-even and the trail under the peak, and never below the
        // flat stop it started with.
        const floor = Math.max(entry * (1 + levels.breakEvenPct), peak * (1 - levels.trailPct));
        if (marketCapUsd <= floor) return marketCapUsd >= entry ? "trail" : "stop-loss";
      } else if (marketCapUsd <= entry * (1 - levels.stopPct)) {
        return "stop-loss";
      }

      // Selling wallets taking over while the position is under water: the same distribution
      // reading the filter uses, applied to a coin we are already in.
      const share = buyShare(record ?? {});
      if (share !== null && share < 0.35 && gain < 0) return "breakdown";

      // Not covering its costs and no longer making highs.
      if (gain <= levels.costPct && now - (position.lastHighAt ?? position.openedAt) >= levels.stallMs) {
        return "stall";
      }
      if (now - position.openedAt >= (config.maxHoldMs ?? levels.maxHoldMs)) return "max-hold";
      return null;
    },

    // Called by the executor once a position is actually closed, so the counters live in one place.
    recordExit(reason) {
      stats.exits += 1;
      if (reason === "stop-loss") stats.stops += 1;
      else if (reason === "trail") stats.trails += 1;
      else if (reason === "max-hold" || reason === "max-hold-stale") stats.timeouts += 1;
    },

    status() {
      return {
        ...stats,
        positionPct: config.positionPct,
        nextSizeSol: Number(sizeSol().toFixed(6)),
        stopPct: config.stopPct,
        trailAfterPct: config.trailAfterPct,
        trailPct: config.trailPct,
        maxOpenPositions: config.maxOpenPositions,
        maxEntriesPerDay: config.maxEntriesPerDay,
        maxDailyLossSol: config.maxDailyLossSol,
        todayEntries: account.daily?.entries ?? 0,
        todayPnlSol: account.daily?.realizedPnlSol ?? 0,
        blockedReason: lastBlock,
        blocks: { ...blocks },
      };
    },
  };
}
