// AGENT 2 — FILTER
//
// Hard kills only. Not "is this a good trade" — that is the analyst — but "is this a coin a person
// could honestly take a position in at all". Every rule here answers a way of losing everything
// that has nothing to do with being wrong about the price:
//
//   mint authority live   — the creator can print more supply and sell it into your bid
//   freeze authority live — the creator can freeze your tokens so you cannot sell at all
//   LP not burned/locked  — somebody can withdraw the pool you were planning to sell into. This is
//                           what a rug actually is: not a price falling, a pool ceasing to exist
//   thin liquidity        — a pool too small to get out of at any price
//   dev holds too much    — one wallet whose exit is the whole move
//   bundled launch        — supply split across wallets that have traded it between themselves
//   already +80% in 1h    — the move has happened; what is left is the giving-back
//
// Plus the three that count WALLETS rather than trades (few_buyers, wash_trading, distribution),
// because volume and trade counts are free for a group to manufacture and distinct wallets are not.
//
// Cheapest first, so the paid-for calls are only spent on a coin that survived the free ones:
//
//   local numbers -> RugCheck (15/min) -> holder graph over RPC
//
// Nothing here treats missing data as clean. A check that could not be made leaves the coin in
// `wait`, where it is looked at again next pass rather than passed on.

import { gateReason, holderReason } from "../filters.js";
import { fetchSafetyReport } from "../holders.js";
import { createMeter } from "../meter.js";

// How long a RugCheck answer is trusted before it is asked again. LP can be unlocked and a dev can
// sell while a coin sits in the watchlist, so this is minutes, not hours.
const RUGCHECK_TTL_MS = 10 * 60_000;
const RUGCHECK_RETRY_MS = 30_000;
const HOLDERS_TTL_MS = 15 * 60_000;

const pct = (value) => `${Number(value).toFixed(1)}%`;

// The RugCheck half of the kill list. Returns null when the coin survives, or the kill.
// `report` is a parsed rugcheck report; config carries the limits.
export function rugcheckReason(report, config) {
  if (!report) return null;

  if (report.rugged) {
    return { category: "rugged", detail: "RugCheck has this token marked as already rugged" };
  }
  if (config.requireMintRevoked && report.mintAuthority) {
    return { category: "mint_authority", detail: "the creator can still mint more supply" };
  }
  if (config.requireFreezeRevoked && report.freezeAuthority) {
    return { category: "freeze_authority", detail: "the creator can still freeze your tokens" };
  }

  // The pool you would be selling into. Below the threshold, somebody still holds the LP tokens and
  // can take the liquidity away — which is the one loss a stop cannot protect against, because
  // there is no price on the way down, just no pool.
  if (Number.isFinite(report.lpLockedPct) && report.lpLockedPct < config.minLpLockedPct) {
    return {
      category: "lp_unlocked",
      detail: `only ${pct(report.lpLockedPct)} of the ${report.marketType ?? "main"} pool's LP is burned or locked (need ${pct(config.minLpLockedPct)})`,
    };
  }

  if (Number.isFinite(report.creatorPct) && report.creatorPct > config.maxDevPct) {
    return {
      category: "dev_holding",
      detail: `the creator still holds ${pct(report.creatorPct)} of supply (limit ${pct(config.maxDevPct)})`,
    };
  }

  // Wallets that have passed the token between each other: the bubble-map cluster, as data.
  // Measured on what they STILL hold, because that is what can be dumped.
  if (Number.isFinite(report.insiderPct) && report.insiderPct > config.maxBundledPct) {
    return {
      category: "bundled",
      detail: `${report.insiderWallets} linked wallets across ${report.insiderNetworks} network(s) hold ${pct(report.insiderPct)} between them (limit ${pct(config.maxBundledPct)})`,
    };
  }
  if (Number.isFinite(report.flaggedHolderPct) && report.flaggedHolderPct > config.maxBundledPct) {
    return {
      category: "bundled",
      detail: `insider-flagged holders hold ${pct(report.flaggedHolderPct)} of supply (limit ${pct(config.maxBundledPct)})`,
    };
  }
  return null;
}

// The cheap local kills that do not need any call at all.
export function localReason(record, config) {
  const gate = gateReason(record, config.gates);
  if (gate) return gate;

  // The move already happened. A coin up 80% in an hour is not an opportunity, it is somebody
  // else's opportunity that is now being handed over — and the desk's own measured history says
  // the entries that went worst were the ones taken after the vertical part of the chart.
  if (Number.isFinite(record?.priceChangeH1) && record.priceChangeH1 > config.maxPriceChangeH1) {
    return {
      category: "pumped_already",
      detail: `already +${Math.round(record.priceChangeH1)}% in the last hour (limit +${config.maxPriceChangeH1}%)`,
    };
  }
  return null;
}

export function createFilter({ config, universe, devBook, rugcheck, logger, onPassed, onKilled }) {
  const meter = createMeter();
  const stats = { judged: 0, passed: 0, killed: 0, waiting: 0, rugcheckCalls: 0, holderChecks: 0 };
  const categories = {};
  const passing = new Set(); // mints currently through the filter

  function countKill(record, reason, now) {
    stats.killed += 1;
    categories[reason.category] = (categories[reason.category] ?? 0) + 1;
    logger.kill("filter", record, reason, now);
  }

  // ---------- RugCheck, asked for lazily and cached on the record ----------
  function requestRugcheck(record, now) {
    const held = record.rugcheck;
    if (held?.status === "pending") return;
    if (held?.status === "error" && now < held.retryAt) return;
    if (held?.status === "ok" && now - held.at < RUGCHECK_TTL_MS) return;
    if (!rugcheck.ready()) return; // the budget is spent this minute; ask again next pass

    record.rugcheck = { status: "pending" };
    stats.rugcheckCalls += 1;
    rugcheck.report(record.mint)
      .then((report) => {
        record.rugcheck = { status: "ok", at: Date.now(), ...report };
        // Holder count only means something as a series, so each answer is kept with its time.
        if (Number.isFinite(report.totalHolders)) {
          record.holderCounts = [...(record.holderCounts ?? []), { at: Date.now(), holders: report.totalHolders }].slice(-12);
        }
      })
      .catch((error) => {
        // A token RugCheck has never indexed is usually one minutes old. Everything else is a
        // transient: either way the coin waits rather than passing unchecked.
        record.rugcheck = {
          status: "error",
          at: Date.now(),
          retryAt: Date.now() + (error.notFound ? 5 * 60_000 : RUGCHECK_RETRY_MS),
          reason: error.message,
        };
      });
  }

  function requestHolders(record, now) {
    const held = record.holders;
    if (held?.status === "pending") return;
    if (held?.status === "error" && now < held.retryAt) return;
    if (held?.status === "ok" && now - held.at < HOLDERS_TTL_MS) return;

    record.holders = { status: "pending" };
    stats.holderChecks += 1;
    fetchSafetyReport(record.mint, config.solanaRpcUrl, {
      topCount: config.topHoldersCount,
      clusterHolderCount: config.clusterHolderCount,
      skipLargest: config.topHoldersSkipLargest,
      freshWalletLimit: config.freshWalletLimit,
      freshWalletMaxTx: config.freshWalletMaxTx,
      freshWalletMaxAgeHours: config.freshWalletMaxAgeHours,
    })
      .then((result) => {
        record.holders = { status: "ok", at: Date.now(), ...result };
      })
      .catch((error) => {
        record.holders = {
          status: "error",
          at: Date.now(),
          retryAt: Date.now() + (error.rateLimited ? 30_000 : 10_000),
        };
      });
  }

  // The whole decision for one coin, in order of cost.
  function judge(record, now) {
    // 1. Coins and creators this desk has already watched collapse.
    if (devBook.isBanned(record.mint)) {
      return { state: "kill", category: "rugged", detail: "this coin already collapsed once" };
    }
    const dev = devBook.assess(record.mint, config);
    if (dev?.verdict === "reject") return { state: "kill", category: "dev_history", detail: dev.reason };

    // 2. Everything readable from the numbers the scout already has.
    const local = localReason(record, config);
    if (local?.wait) return { state: "wait", category: local.category, detail: local.detail };
    if (local) return { state: "kill", ...local };

    // 3. RugCheck: authorities, LP, the dev's own bag, and the linked-wallet networks.
    requestRugcheck(record, now);
    const report = record.rugcheck;
    if (report?.status !== "ok") {
      return {
        state: "wait",
        category: "safety_pending",
        detail: report?.status === "error" ? `safety check unavailable (${report.reason})` : "waiting for the safety check",
      };
    }
    const unsafe = rugcheckReason(report, config);
    if (unsafe) return { state: "kill", ...unsafe };

    // 4. The holder graph over our own RPC, when one is configured. This is the deepest and most
    //    expensive look, so it goes last and only for a coin that has survived everything else.
    if (config.solanaRpcUrl) {
      requestHolders(record, now);
      if (record.holders?.status !== "ok") {
        return { state: "wait", category: "holders_pending", detail: "waiting for the holder check" };
      }
      const holders = holderReason(record.holders, config);
      if (holders) return { state: "kill", ...holders };
    }

    return { state: "pass", category: "pass", detail: "clears every hard check" };
  }

  return {
    // Called by the scout for every coin inside its window.
    consider(record, { now = Date.now() } = {}) {
      const previous = record.filter;
      if (previous && now - previous.at < config.rescoreIntervalMs) return previous;

      const verdict = judge(record, now);
      verdict.at = now;
      record.filter = verdict;
      stats.judged += 1;
      meter.hit(1, now);

      if (verdict.state === "kill") {
        countKill(record, verdict, now);
        if (passing.delete(record.mint)) {
          universe.pin(record.mint, false);
          onKilled?.(record.mint, verdict.detail);
        }
        return verdict;
      }

      if (verdict.state === "wait") {
        stats.waiting += 1;
        categories[verdict.category] = (categories[verdict.category] ?? 0) + 1;
        return verdict;
      }

      stats.passed += 1;
      universe.pin(record.mint, true);
      const first = !passing.has(record.mint);
      passing.add(record.mint);
      logger.pass("filter", record, {
        lpLockedPct: record.rugcheck?.lpLockedPct ?? null,
        creatorPct: record.rugcheck?.creatorPct ?? null,
        insiderPct: record.rugcheck?.insiderPct ?? null,
      }, { write: first, now });
      onPassed?.(record, { now, first });
      return verdict;
    },

    passes(mint) {
      return passing.has(mint);
    },

    status() {
      return {
        ...stats,
        perMinute: meter.perMinute(),
        passingNow: passing.size,
        categories: { ...categories },
        rugcheck: rugcheck.stats(),
        holderCheck: Boolean(config.solanaRpcUrl),
        limits: {
          minLiquidityUsd: config.gates.minLiquidityUsd,
          minLpLockedPct: config.minLpLockedPct,
          maxDevPct: config.maxDevPct,
          maxBundledPct: config.maxBundledPct,
          maxPriceChangeH1: config.maxPriceChangeH1,
        },
      };
    },
  };
}
