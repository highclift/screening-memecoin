// AGENT 4 — EXECUTOR
//
// The analyst says WHICH coins are worth buying. This agent decides WHEN, and it is the only agent
// that touches a position. It does not decide how much (risk), whether it is allowed (risk), or
// when to get out (risk) — it asks.
//
// The timing is measured from the coin itself. A coin is watched until there are enough samples to
// say how much it moves in a minute, and only then is it tradable at all: without that number a
// "dip" is a guess. From there:
//
//   dip-and-bounce — it pulls back by more than its own usual move and then reclaims part of it.
//                    The better fill, and it misses coins that never pull back.
//   breakout       — it makes a new high. Worse fill, catches the steady climbers.
//
// Both triggers are tagged on the entry, so `npm run report` can show which one actually earned.
//
// Paper only. Nothing here signs or sends a transaction. Log: data/trades.jsonl

import { buyShare, volatilityPct } from "../signals.js";

const STALE_PRICE_MS = 60_000;

export function createExecutor({ config, universe, account, risk, logger, persist, solUsd, isCandidate, onRug }) {
  const watchlist = new Map(); // mint -> { addedAt, peak, low, pulledBack, waitingFor, epoch }
  const stats = { entries: 0, exits: 0, wins: 0, losses: 0, dropped: 0, rugs: 0, notMeasured: 0 };

  const priceSolFor = (marketCapUsd) => {
    const sol = solUsd();
    return Number.isFinite(sol) && sol > 0 && Number.isFinite(marketCapUsd) ? marketCapUsd / sol : null;
  };

  function netProceeds(position, priceSol) {
    return position.tokenQuantity * priceSol * (1 - risk.slippage()) * (1 - risk.fee());
  }

  function watch(record) {
    if (watchlist.has(record.mint) || account.positions[record.mint]) return;
    if (watchlist.size >= config.maxWatchlist) {
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
    logger.trade({ type: "unwatch", mint, reason: why });
  }

  function openPosition(record, entry, now) {
    const priceSol = priceSolFor(record.marketCapUsd);
    if (priceSol === null) return false;
    if (risk.blockReason(record, now)) return false;

    const costSol = risk.sizeSol();
    const fillPrice = priceSol * (1 + risk.slippage());
    const tokenQuantity = (costSol * (1 - risk.fee())) / fillPrice;
    const position = {
      mint: record.mint,
      name: record.name ?? "",
      symbol: record.symbol ?? "",
      openedAt: now,
      entryPrice: priceSol,
      lastPrice: priceSol,
      entryMarketCapUsd: record.marketCapUsd,
      lastMarketCapUsd: record.marketCapUsd,
      peakMarketCapUsd: record.marketCapUsd,
      lastPriceAt: now,
      lastHighAt: now,
      costSol,
      tokenQuantity,
      levels: entry.levels,
      armed: false,
      entryScore: record.analysis?.score ?? null,
      dataSource: "dexscreener",
    };
    account.positions[record.mint] = position;
    account.balanceSol -= costSol;
    account.daily.entries += 1;
    watchlist.delete(record.mint);
    universe.pin(record.mint, true);
    persist();
    stats.entries += 1;

    logger.trade({
      type: "entry",
      mint: record.mint,
      symbol: record.symbol,
      ageSeconds: universe.ageSeconds(record),
      marketCapUsd: record.marketCapUsd,
      liquidityUsd: record.liquidityUsd ?? null,
      volumeH1Usd: record.volumeH1Usd ?? null,
      buyersH1: record.buyersH1 ?? null,
      score: record.analysis?.score ?? null,
      lead: record.analysis?.lead ?? null,
      parts: record.analysis?.parts ?? null,
      lpLockedPct: record.rugcheck?.lpLockedPct ?? null,
      trigger: entry.trigger,
      dipFromPeakPct: entry.dipFromPeakPct,
      reboundPct: entry.reboundPct,
      costSol,
      levels: entry.levels,
    });
    logger.say(`[executor] BUY ${record.symbol || record.mint.slice(0, 8)} ${usd(record.marketCapUsd)} score=${record.analysis?.score ?? "?"} ${entry.trigger} | ${costSol.toFixed(5)} SOL, stop -${(entry.levels.stopPct * 100).toFixed(0)}%, trail ${(entry.levels.trailPct * 100).toFixed(0)}% after +${(entry.levels.trailAfterPct * 100).toFixed(0)}%`);
    logger.tell("entry", `Bought at ${usd(record.marketCapUsd)}; stop -${(entry.levels.stopPct * 100).toFixed(0)}%, trail arms at +${(entry.levels.trailAfterPct * 100).toFixed(0)}%.`, record.mint);
    return true;
  }

  function closePosition(mint, priceSol, marketCapUsd, reason, now = Date.now()) {
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
      closedAt: now,
      entryPrice: position.entryPrice,
      exitPrice: priceSol,
      entryMarketCapUsd: position.entryMarketCapUsd ?? null,
      exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
      costSol: position.costSol,
      proceedsSol,
      pnlSol,
      entryScore: position.entryScore ?? null,
      reason,
    });
    if (account.closedTrades.length > 5000) account.closedTrades.splice(0, account.closedTrades.length - 5000);
    delete account.positions[mint];
    universe.pin(mint, false);
    persist();
    stats.exits += 1;
    risk.recordExit(reason);
    if (pnlSol > 0) stats.wins += 1;
    else if (pnlSol < 0) stats.losses += 1;

    // A position that lost most of its value did not drift down; the pool was drained between two
    // polls. Report it so the coin is banned and counted against its creator.
    const collapsed = Number.isFinite(position.entryMarketCapUsd) && position.entryMarketCapUsd > 0
      && Number.isFinite(marketCapUsd)
      && marketCapUsd <= position.entryMarketCapUsd * (1 - config.rugDropPct);
    if (collapsed) {
      stats.rugs += 1;
      onRug?.(mint, { entryMarketCapUsd: position.entryMarketCapUsd, exitMarketCapUsd: marketCapUsd });
    }

    logger.trade({
      type: "exit",
      mint,
      symbol: position.symbol,
      reason,
      pnlSol: Number(pnlSol.toFixed(6)),
      heldSeconds: Math.round((now - position.openedAt) / 1000),
      entryMarketCapUsd: position.entryMarketCapUsd ?? null,
      exitMarketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : position.lastMarketCapUsd ?? null,
      peakMarketCapUsd: position.peakMarketCapUsd ?? null,
      entryScore: position.entryScore ?? null,
      armed: position.armed === true,
      levels: position.levels,
    });
    logger.say(`[executor] SELL:${reason} ${position.symbol || mint.slice(0, 8)} ${usd(marketCapUsd ?? position.lastMarketCapUsd)} pnl=${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL | balance=${account.balanceSol.toFixed(5)} SOL`);
    logger.tell("exit", `Sold on ${reason} at ${usd(marketCapUsd ?? position.lastMarketCapUsd)}; P&L ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(5)} SOL.`, mint);
  }

  // ---------- entry timing ----------
  function entrySignal(record, watchState, now) {
    const marketCapUsd = record.marketCapUsd;
    if (!Number.isFinite(marketCapUsd)) return { waitingFor: "data" };

    // The market cap started coming from a different source, so the peak and low recorded here were
    // measured with another yardstick. Start again rather than trade a dip that never happened.
    if ((record.marketCapEpoch ?? 0) !== watchState.epoch) {
      watchState.epoch = record.marketCapEpoch ?? 0;
      watchState.peak = marketCapUsd;
      watchState.low = marketCapUsd;
      watchState.pulledBack = false;
      return { waitingFor: "measure" };
    }

    const volPct = volatilityPct(record.snapshots, { now });
    if (volPct === null) {
      stats.notMeasured += 1;
      return { waitingFor: "measure" };
    }
    const levels = risk.levelsFor(volPct);
    const dipPct = Math.max(volPct * 1.2, 0.04);
    const bouncePct = Math.max(volPct * 0.6, 0.015);

    if (watchState.peak === null || marketCapUsd > watchState.peak) {
      watchState.peak = marketCapUsd;
      watchState.low = marketCapUsd;
      watchState.pulledBack = false;
      if (config.entryMode === "dip") return { waitingFor: "dip", levels };
      const blocked = entryGuard(record, volPct);
      if (blocked) return { waitingFor: blocked, levels };
      return { trigger: "breakout", levels, dipFromPeakPct: 0, reboundPct: 0 };
    }
    if (config.entryMode === "breakout") return { waitingFor: "high", levels };

    if (!watchState.pulledBack) {
      if (marketCapUsd <= watchState.peak * (1 - dipPct)) {
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
    if (reboundPct < bouncePct) return { waitingFor: "bounce", levels };

    const blocked = entryGuard(record, volPct);
    if (blocked) return { waitingFor: blocked, levels };

    return {
      trigger: "dip-and-bounce",
      levels,
      dipFromPeakPct: 1 - watchState.low / watchState.peak,
      reboundPct,
    };
  }

  // About the fill, not about the coin: the first three agents already judged the coin.
  function entryGuard(record, volPct) {
    const share = buyShare(record);
    if (share !== null && share < 0.5) return "buyers";
    const snapshots = record.snapshots;
    const last = snapshots[snapshots.length - 1];
    const previous = snapshots[snapshots.length - 2];
    if (last && previous && previous.marketCapUsd > 0) {
      // A vertical candle is a bad fill: wait for the next measurement rather than buy the spike.
      if (last.marketCapUsd / previous.marketCapUsd - 1 > volPct * 3) return "spike";
    }
    return null;
  }

  return {
    watch,
    unwatch,

    // Every refresh of a coin the desk cares about comes through here.
    onData(record, now = Date.now()) {
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
          // Latch the trail the moment the trade has been far enough up, so a spike that is gone
          // by the next poll still counts as having armed it.
          const entry = position.entryMarketCapUsd;
          if (!position.armed && Number.isFinite(entry) && entry > 0
            && position.peakMarketCapUsd / entry - 1 >= position.levels.trailAfterPct) {
            position.armed = true;
          }
        }
        if (priceSol !== null) {
          position.lastPrice = priceSol;
          position.lastPriceAt = now;
        }
        const reason = risk.exitReason(position, marketCapUsd, now, record);
        if (reason) closePosition(mint, priceSol ?? position.lastPrice, marketCapUsd, reason, now);
        return;
      }

      const watchState = watchlist.get(mint);
      if (!watchState) return;
      if (!isCandidate(mint)) {
        unwatch(mint, "no longer passes the analyst");
        return;
      }

      const signal = entrySignal(record, watchState, now);
      watchState.waitingFor = signal.trigger ? "entry" : signal.waitingFor;
      watchState.levels = signal.levels ?? watchState.levels;
      if (signal.trigger) openPosition(record, signal, now);
    },

    // Time-based exits and the no-data safety net: a position is never left open forever because a
    // coin stopped being indexed.
    sweep(now = Date.now()) {
      for (const [mint, position] of Object.entries(account.positions)) {
        const fresh = now - (position.lastPriceAt ?? 0) <= STALE_PRICE_MS;
        if (!fresh) {
          if (Number.isFinite(position.lastPrice) && now - position.openedAt >= config.maxHoldMs) {
            closePosition(mint, position.lastPrice, position.lastMarketCapUsd, "max-hold-stale", now);
          }
          continue;
        }
        const reason = risk.exitReason(position, position.lastMarketCapUsd, now);
        if (reason) closePosition(mint, position.lastPrice, position.lastMarketCapUsd, reason, now);
      }

      for (const [mint, watchState] of watchlist) {
        if (now - watchState.addedAt >= config.watchGraceMs) {
          unwatch(mint, "no entry signal while it was watched");
        }
      }
    },

    // The dashboard's emergency exit. Sells at the last price seen, with the usual fee and slippage.
    closeNow(mint, reason = "manual") {
      const mints = mint ? [mint] : Object.keys(account.positions);
      let closed = 0;
      for (const target of mints) {
        const position = account.positions[target];
        if (!position || !Number.isFinite(position.lastPrice)) continue;
        closePosition(target, position.lastPrice, position.lastMarketCapUsd, reason);
        closed += 1;
      }
      if (closed) {
        logger.say(`[executor] MANUAL EXIT: closed ${closed} position${closed === 1 ? "" : "s"} on request.`);
        logger.tell("exit", closed === 1
          ? "Position closed by hand from the dashboard."
          : `${closed} positions closed by hand from the dashboard.`, mint ?? "");
      }
      return closed;
    },

    // The scout polls these every tick: the only coins where a second matters.
    priorityMints() {
      return [...new Set([...Object.keys(account.positions), ...watchlist.keys()])];
    },

    holds(mint) {
      return Boolean(account.positions[mint]);
    },

    status() {
      let realizedPnlSol = 0;
      for (const trade of account.closedTrades) realizedPnlSol += Number(trade.pnlSol) || 0;
      const positions = Object.values(account.positions).map((position) => ({
        mint: position.mint,
        symbol: position.symbol,
        openedAt: position.openedAt,
        entryMarketCapUsd: position.entryMarketCapUsd ?? null,
        currentMarketCapUsd: position.lastMarketCapUsd ?? null,
        peakMarketCapUsd: position.peakMarketCapUsd ?? null,
        costSol: position.costSol,
        estimatedPnlSol: Number.isFinite(position.lastPrice) ? netProceeds(position, position.lastPrice) - position.costSol : 0,
        entryScore: position.entryScore ?? null,
        armed: position.armed === true,
        stopPct: position.levels?.stopPct ?? null,
        trailPct: position.levels?.trailPct ?? null,
      }));
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
          score: record?.analysis?.score ?? null,
          addedAt: watchState.addedAt,
        });
      }
      return {
        ...stats,
        balanceSol: account.balanceSol,
        startBalanceSol: account.startBalanceSol ?? config.paperStartBalanceSol,
        realizedPnlSol,
        openPositions: positions.length,
        watchingCount: watchlist.size,
        maxWatchlist: config.maxWatchlist,
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
