// BOT 3 — EXECUTION
//
// Bot 2 hands it coins that can pump. This bot decides WHEN: when to buy, and when to get out.
// It has no strategy settings, and that is deliberate. Every level it uses is measured from the
// coin in front of it:
//
//   it watches the coin until it has measured how much that coin moves in a minute (signals.js),
//   then a pullback worth 1.2x that move is "a dip", a 0.6x recovery off the low is "buyers are
//   back", 2.5x below entry is "I was wrong", 2x under the peak is the trailing stop, and a coin
//   that stops making new highs for a while has finished its run.
//
// So a coin that swings 10% a minute gets wide stops and little patience, and a steady one gets
// tight stops and time, without anybody choosing a percentage. The only settings left are money
// limits: how much per trade, how many trades, how much it may lose in a day.
//
// Paper only. Nothing here signs or sends a transaction. Log: data/bot3-trades.jsonl

import fs from "node:fs";
import { buyShare, deriveLevels, roundTripCostPct, volatilityPct } from "../signals.js";
import { currentUtcDay } from "../state.js";

const HALT_FILE = ".halt";
const STALE_PRICE_MS = 60_000;

export function createExecutor({ config, universe, journal, account, persist, solUsd, isGreen, onRug, log, note }) {
  const watchlist = new Map(); // mint -> { addedAt, peak, low, pulledBack, lastHighAt, waitingFor }
  const stats = { entries: 0, exits: 0, wins: 0, losses: 0, blocked: 0, skippedNoMeasure: 0, dropped: 0, rugs: 0 };
  let blockedReason = "";

  const fee = () => config.paperFeeBps / 10_000;
  const slippage = () => config.paperSlippageBps / 10_000;
  const priceSolFor = (marketCapUsd) => {
    const sol = solUsd();
    return Number.isFinite(sol) && sol > 0 && Number.isFinite(marketCapUsd) ? marketCapUsd / sol : null;
  };

  function resetDailyIfNeeded() {
    const today = currentUtcDay();
    if (account.daily?.day !== today) {
      account.daily = { day: today, entries: 0, realizedPnlSol: 0 };
      persist();
    }
  }

  function netProceeds(position, priceSol) {
    return position.tokenQuantity * priceSol * (1 - slippage()) * (1 - fee());
  }

  // Money limits only: nothing here is about the coin, it is about the account.
  function riskBlock() {
    resetDailyIfNeeded();
    if (fs.existsSync(HALT_FILE)) return "file .halt aktif";
    if (Object.keys(account.positions).length >= config.maxOpenPositions) return `batas ${config.maxOpenPositions} posisi terbuka`;
    if (account.daily.entries >= config.maxEntriesPerDay) return `batas ${config.maxEntriesPerDay} entry per hari`;
    if (account.balanceSol < config.buyAmountSol) return "saldo paper tidak cukup";
    if (config.maxDailyLossSol > 0 && account.daily.realizedPnlSol <= -config.maxDailyLossSol) {
      return `batas rugi harian ${config.maxDailyLossSol} SOL`;
    }
    return "";
  }

  function watch(record) {
    if (watchlist.has(record.mint) || account.positions[record.mint]) return;
    if (watchlist.size >= config.maxWatchlist) {
      // Make room by dropping whatever has been waiting longest without triggering.
      const oldest = [...watchlist.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt)[0];
      if (oldest) unwatch(oldest[0], "watchlist penuh");
    }
    watchlist.set(record.mint, {
      addedAt: Date.now(),
      peak: Number.isFinite(record.marketCapUsd) ? record.marketCapUsd : null,
      low: Number.isFinite(record.marketCapUsd) ? record.marketCapUsd : null,
      pulledBack: false,
      waitingFor: "measure",
      epoch: record.marketCapEpoch ?? 0,
    });
  }

  function unwatch(mint, why) {
    if (!watchlist.delete(mint)) return;
    stats.dropped += 1;
    journal.write({ type: "unwatch", mint, reason: why });
  }

  function openPosition(record, entry) {
    const priceSol = priceSolFor(record.marketCapUsd);
    if (priceSol === null) return false;
    const block = riskBlock();
    if (block) {
      if (blockedReason !== block) {
        blockedReason = block;
        stats.blocked += 1;
        journal.write({ type: "blocked", mint: record.mint, reason: block });
        note("blocked", `Entry tertahan: ${block}; koin tetap dipantau.`, record.mint);
      }
      return false;
    }
    blockedReason = "";

    const fillPrice = priceSol * (1 + slippage());
    const tokenQuantity = (config.buyAmountSol * (1 - fee())) / fillPrice;
    const position = {
      mint: record.mint,
      name: record.name ?? "",
      symbol: record.symbol ?? "",
      openedAt: Date.now(),
      entryPrice: priceSol,
      lastPrice: priceSol,
      entryMarketCapUsd: record.marketCapUsd,
      lastMarketCapUsd: record.marketCapUsd,
      peakMarketCapUsd: record.marketCapUsd,
      lastPriceAt: Date.now(),
      lastHighAt: Date.now(),
      costSol: config.buyAmountSol,
      tokenQuantity,
      levels: entry.levels,
      entryScore: record.verdict?.score ?? null,
      dataSource: "dexscreener",
    };
    account.positions[record.mint] = position;
    account.balanceSol -= config.buyAmountSol;
    account.daily.entries += 1;
    watchlist.delete(record.mint);
    universe.pin(record.mint, true);
    persist();
    stats.entries += 1;

    journal.write({
      type: "entry",
      mint: record.mint,
      symbol: record.symbol,
      ageSeconds: universe.ageSeconds(record),
      marketCapUsd: record.marketCapUsd,
      liquidityUsd: record.liquidityUsd ?? null,
      volumeH1Usd: record.volumeH1Usd ?? null,
      score: record.verdict?.score ?? null,
      trigger: entry.trigger,
      dipFromPeakPct: entry.dipFromPeakPct,
      reboundPct: entry.reboundPct,
      levels: entry.levels,
    });
    log(`[bot3] BUY ${record.symbol || record.mint.slice(0, 8)} MC=${usd(record.marketCapUsd)} after a ${(entry.dipFromPeakPct * 100).toFixed(1)}% dip and a ${(entry.reboundPct * 100).toFixed(1)}% bounce | stop ${(entry.levels.stopPct * 100).toFixed(1)}% trail ${(entry.levels.trailPct * 100).toFixed(1)}% (this coin moves ~${(entry.levels.volPct * 100).toFixed(1)}%/min)`);
    note("entry", `Bot 3 entry ${record.symbol || record.mint.slice(0, 8)} di market cap ${usd(record.marketCapUsd)}; stop ${(entry.levels.stopPct * 100).toFixed(1)}%, trailing ${(entry.levels.trailPct * 100).toFixed(1)}%.`, record.mint);
    return true;
  }

  function closePosition(mint, priceSol, marketCapUsd, reason) {
    const position = account.positions[mint];
    if (!position) return;
    const proceedsSol = netProceeds(position, priceSol);
    const pnlSol = proceedsSol - position.costSol;
    account.balanceSol += proceedsSol;
    account.daily.realizedPnlSol += pnlSol;
    account.closedTrades.push({
      mint,
      name: position.name,
      symbol: position.symbol,
      dataSource: position.dataSource,
      openedAt: position.openedAt,
      closedAt: Date.now(),
      entryPrice: position.entryPrice,
      exitPrice: priceSol,
      entryMarketCapUsd: position.entryMarketCapUsd ?? null,
      exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
      costSol: position.costSol,
      proceedsSol,
      pnlSol,
      reason,
    });
    if (account.closedTrades.length > 5000) account.closedTrades.splice(0, account.closedTrades.length - 5000);
    delete account.positions[mint];
    universe.pin(mint, false);
    persist();
    stats.exits += 1;
    if (pnlSol > 0) stats.wins += 1;
    else if (pnlSol < 0) stats.losses += 1;

    // A position that lost most of its value did not drift down — the pool was drained between two
    // polls. Report it so the coin is banned and its creator counted, whether or not bot 2 ever
    // saw the collapse from the outside.
    const collapsed = Number.isFinite(position.entryMarketCapUsd) && position.entryMarketCapUsd > 0
      && Number.isFinite(marketCapUsd)
      && marketCapUsd <= position.entryMarketCapUsd * (1 - config.rugDropPct);
    if (collapsed) {
      stats.rugs += 1;
      onRug?.(mint, { entryMarketCapUsd: position.entryMarketCapUsd, exitMarketCapUsd: marketCapUsd });
    }

    journal.write({
      type: "exit",
      mint,
      symbol: position.symbol,
      reason,
      pnlSol: Number(pnlSol.toFixed(6)),
      heldSeconds: Math.round((Date.now() - position.openedAt) / 1000),
      entryMarketCapUsd: position.entryMarketCapUsd ?? null,
      exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
      peakMarketCapUsd: position.peakMarketCapUsd ?? null,
      levels: position.levels,
    });
    log(`[bot3] SELL:${reason} ${position.symbol || mint.slice(0, 8)} MC=${usd(marketCapUsd ?? position.lastMarketCapUsd)} pnl=${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL | balance=${account.balanceSol.toFixed(5)} SOL`);
    note("exit", `Bot 3 exit ${reason} pada market cap ${usd(marketCapUsd ?? position.lastMarketCapUsd)}; PnL ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL.`, mint);
  }

  // ---------- entry ----------
  // Returns the trigger when this coin should be bought right now, else the reason it is waiting.
  function entrySignal(record, watchState, now) {
    const marketCapUsd = record.marketCapUsd;
    if (!Number.isFinite(marketCapUsd)) return { waitingFor: "data" };

    // The market cap started coming from a different source, so the peak and low this bot recorded
    // were measured with another yardstick. Start again rather than trade a dip that never happened.
    if ((record.marketCapEpoch ?? 0) !== watchState.epoch) {
      watchState.epoch = record.marketCapEpoch ?? 0;
      watchState.peak = marketCapUsd;
      watchState.low = marketCapUsd;
      watchState.pulledBack = false;
      return { waitingFor: "measure" };
    }

    const volPct = volatilityPct(record.snapshots, { now });
    if (volPct === null) {
      // The bot refuses to buy a coin it has not measured yet. This is the one wait that cannot be
      // skipped: without it there is no stop distance that means anything.
      stats.skippedNoMeasure += 1;
      return { waitingFor: "measure" };
    }
    const levels = deriveLevels(volPct, roundTripCostPct(config), config.maxLossPct);

    // A new high. In "dip" mode that only resets the pullback tracking and we wait; in the other
    // modes it is itself a reason to buy — a coin that climbs steadily never dips, and waiting for
    // a pullback that never comes is how a bot watches a whole move go past. The entry price is
    // worse than buying a retrace, which is why both triggers are tagged in the journal and the
    // report compares what each one actually earned.
    if (watchState.peak === null || marketCapUsd > watchState.peak) {
      watchState.peak = marketCapUsd;
      watchState.low = marketCapUsd;
      watchState.pulledBack = false;
      if (config.entryMode === "dip") return { waitingFor: "dip", levels };
      const blocked = entryGuard(record, levels);
      if (blocked) return { waitingFor: blocked, levels };
      return { trigger: "breakout", levels, dipFromPeakPct: 0, reboundPct: 0 };
    }
    // "breakout" mode buys new highs and nothing else.
    if (config.entryMode === "breakout") return { waitingFor: "high", levels };

    if (!watchState.pulledBack) {
      if (marketCapUsd <= watchState.peak * (1 - levels.dipPct)) {
        watchState.pulledBack = true;
        watchState.low = marketCapUsd;
        return { waitingFor: "bounce", levels };
      }
      return { waitingFor: "dip", levels };
    }
    if (marketCapUsd < watchState.low) {
      watchState.low = marketCapUsd;
      return { waitingFor: "bounce", levels };
    }

    const reboundPct = marketCapUsd / watchState.low - 1;
    if (reboundPct < levels.bouncePct) return { waitingFor: "bounce", levels };

    const blocked = entryGuard(record, levels);
    if (blocked) return { waitingFor: blocked, levels };

    return {
      trigger: "dip-and-bounce",
      levels,
      dipFromPeakPct: 1 - watchState.low / watchState.peak,
      reboundPct,
    };
  }

  // The two checks that apply however the entry was triggered. Returns null to go ahead, or what
  // it is waiting for. These are about the fill, not about the coin: bot 2 already judged the coin.
  function entryGuard(record, levels) {
    const share = buyShare(record);
    if (share !== null && share < 0.5) return "buyers";

    const snapshots = record.snapshots;
    const last = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];
    if (last && previous && previous.marketCapUsd > 0) {
      const step = last.marketCapUsd / previous.marketCapUsd - 1;
      // A vertical candle is a bad fill: wait for the next measurement instead of buying the spike.
      if (step > levels.volPct * 3) return "spike";
    }
    return null;
  }

  // ---------- exit ----------
  // A flat stop and a trailing take-profit. Nothing here sells at a fixed profit target: the trail
  // is what ends a winning trade, so a coin that keeps climbing is never cut off at an arbitrary
  // number.
  function exitReasonFor(position, marketCapUsd, now) {
    const levels = position.levels ?? deriveLevels(null, roundTripCostPct(config), config.maxLossPct);
    const entry = position.entryMarketCapUsd;
    if (!Number.isFinite(marketCapUsd) || !Number.isFinite(entry) || entry <= 0) return null;

    const peak = Math.max(position.peakMarketCapUsd ?? entry, entry);
    const peakGain = peak / entry - 1;
    const gain = marketCapUsd / entry - 1;
    // Once a trade has been up by lockPct it is not allowed to become a loss: the flat floor
    // ratchets from "entry minus the stop" up to "entry plus what the round trip costs".
    const locked = peakGain >= levels.lockPct;

    // 1. The flat stop. It only ever moves once, and only upwards.
    if (locked) {
      if (marketCapUsd <= entry * (1 + levels.breakEvenPct)) {
        // Polling is every couple of seconds, so a fast coin can gap straight through the floor.
        // Call it what it actually was rather than claiming break-even on a losing exit.
        return marketCapUsd >= entry ? "break-even" : "stop-loss";
      }
    } else if (marketCapUsd <= entry * (1 - levels.stopPct)) {
      return "stop-loss";
    }

    // 2. The trailing take-profit, from the highest point since entry.
    const trail = locked ? levels.tightTrailPct : levels.trailPct;
    if (marketCapUsd <= peak * (1 - trail)) return locked ? "trail-locked" : "trail";

    // 3. A trade that is not even covering its costs and has stopped making highs is not working.
    //    One that IS in profit is left to the trail, however long it takes.
    const inProfit = gain > levels.costPct;
    if (!inProfit && now - (position.lastHighAt ?? position.openedAt) >= levels.stallMs) return "stall";

    // 4. Backstops: measured from the last new high, so a coin still climbing keeps its position.
    if (now - (position.lastHighAt ?? position.openedAt) >= levels.maxHoldMs) return "max-hold";
    if (now - position.openedAt >= (levels.maxTotalHoldMs ?? 4 * 3_600_000)) return "max-hold-total";
    return null;
  }

  function onData(record, now = Date.now()) {
    const mint = record.mint;
    const marketCapUsd = record.marketCapUsd;
    const priceSol = priceSolFor(marketCapUsd);

    const position = account.positions[mint];
    if (position) {
      if (Number.isFinite(marketCapUsd)) {
        position.lastMarketCapUsd = marketCapUsd;
        if (!Number.isFinite(position.peakMarketCapUsd) || marketCapUsd > position.peakMarketCapUsd) {
          position.peakMarketCapUsd = marketCapUsd;
          position.lastHighAt = now;
        }
      }
      if (priceSol !== null) {
        position.lastPrice = priceSol;
        position.lastPriceAt = now;
      }
      const share = buyShare(record);
      if (share !== null && share < 0.35 && Number.isFinite(marketCapUsd) && marketCapUsd < position.entryMarketCapUsd) {
        closePosition(mint, priceSol ?? position.lastPrice, marketCapUsd, "breakdown");
        return;
      }
      const reason = exitReasonFor(position, marketCapUsd, now);
      if (reason) closePosition(mint, priceSol ?? position.lastPrice, marketCapUsd, reason);
      return;
    }

    const watchState = watchlist.get(mint);
    if (!watchState) return;
    if (!isGreen(mint)) {
      unwatch(mint, "bot 2 menarik status green");
      return;
    }

    const signal = entrySignal(record, watchState, now);
    watchState.waitingFor = signal.trigger ? "entry" : signal.waitingFor;
    watchState.levels = signal.levels ?? watchState.levels;
    if (signal.trigger) openPosition(record, signal);
  }

  // Time-based exits and the no-data safety net: a paper position is never left open forever just
  // because a coin stopped being indexed.
  function sweep(now = Date.now()) {
    for (const [mint, position] of Object.entries(account.positions)) {
      const fresh = now - (position.lastPriceAt ?? 0) <= STALE_PRICE_MS;
      if (!fresh) {
        // No price at all for a long time is a data problem, not a trade going quiet, so this one
        // is measured from entry rather than from the last high.
        const levels = position.levels ?? deriveLevels(null, roundTripCostPct(config), config.maxLossPct);
        if (Number.isFinite(position.lastPrice) && now - position.openedAt >= levels.maxHoldMs) {
          closePosition(mint, position.lastPrice, position.lastMarketCapUsd, "max-hold-stale");
        }
        continue;
      }
      const reason = exitReasonFor(position, position.lastMarketCapUsd, now);
      if (reason) closePosition(mint, position.lastPrice, position.lastMarketCapUsd, reason);
    }

    // A green coin that never triggered is not held forever: after the grace period it goes back to
    // bot 2's list and has to earn its place again.
    for (const [mint, watchState] of watchlist) {
      if (now - watchState.addedAt >= config.greenGraceMs) unwatch(mint, "tidak ada sinyal entry dalam masa pantau");
    }
  }

  // ---------- manual control ----------
  // The emergency hatch. Sells at the last price this bot saw, which is what a market order would
  // realistically get, and the normal fee and slippage still apply. Returns how many it closed.
  function closeNow(mint, reason = "manual") {
    const mints = mint ? [mint] : Object.keys(account.positions);
    let closed = 0;
    for (const target of mints) {
      const position = account.positions[target];
      if (!position || !Number.isFinite(position.lastPrice)) continue;
      closePosition(target, position.lastPrice, position.lastMarketCapUsd, reason);
      closed += 1;
    }
    if (closed) {
      log(`[bot3] MANUAL EXIT: closed ${closed} position${closed === 1 ? "" : "s"} on request.`);
      note("exit", closed === 1
        ? "Posisi ditutup manual dari dashboard."
        : `${closed} posisi ditutup manual dari dashboard.`, mint ?? "");
    }
    return closed;
  }

  return {
    watch,
    unwatch,
    onData,
    sweep,
    closeNow,

    // Bot 1 polls these mints every tick: they are the only coins where a second matters.
    priorityMints() {
      return [...new Set([...Object.keys(account.positions), ...watchlist.keys()])];
    },

    holds(mint) {
      return Boolean(account.positions[mint]);
    },

    status() {
      let realizedPnlSol = 0;
      for (const trade of account.closedTrades) realizedPnlSol += Number(trade.pnlSol) || 0;
      const positions = Object.values(account.positions).map((position) => {
        const levels = position.levels ?? {};
        return {
          mint: position.mint,
          symbol: position.symbol,
          openedAt: position.openedAt,
          entryMarketCapUsd: position.entryMarketCapUsd ?? null,
          currentMarketCapUsd: position.lastMarketCapUsd ?? null,
          peakMarketCapUsd: position.peakMarketCapUsd ?? null,
          costSol: position.costSol,
          estimatedPnlSol: Number.isFinite(position.lastPrice) ? netProceeds(position, position.lastPrice) - position.costSol : 0,
          stopPct: levels.stopPct ?? null,
          trailPct: levels.trailPct ?? null,
          volPct: levels.volPct ?? null,
        };
      });
      const watching = [];
      for (const [mint, watchState] of watchlist) {
        const record = universe.get(mint);
        watching.push({
          mint,
          symbol: record?.symbol ?? "",
          waitingFor: watchState.waitingFor,
          marketCapUsd: record?.marketCapUsd ?? null,
          peakMarketCapUsd: watchState.peak,
          lowMarketCapUsd: watchState.low,
          dipPct: watchState.levels?.dipPct ?? null,
          bouncePct: watchState.levels?.bouncePct ?? null,
          volPct: watchState.levels?.volPct ?? null,
          score: record?.verdict?.score ?? null,
          addedAt: watchState.addedAt,
        });
      }
      return {
        ...stats,
        balanceSol: account.balanceSol,
        startBalanceSol: account.startBalanceSol ?? config.paperStartBalanceSol,
        realizedPnlSol,
        todayPnlSol: account.daily?.realizedPnlSol ?? 0,
        todayEntries: account.daily?.entries ?? 0,
        maxEntriesPerDay: config.maxEntriesPerDay,
        maxOpenPositions: config.maxOpenPositions,
        buyAmountSol: config.buyAmountSol,
        openPositions: positions.length,
        watchingCount: watchlist.size,
        maxWatchlist: config.maxWatchlist,
        blockedReason,
        positions,
        watching: watching.slice(0, 25),
        closedTrades: account.closedTrades.slice(-20).reverse(),
      };
    },
  };
}

function usd(value) {
  return Number.isFinite(value) ? `$${Math.round(value).toLocaleString("en-US")}` : "—";
}
