// BOT 2 — FILTERING
//
// Takes every coin bot 1 screened and answers one question: can this pump, or pump AGAIN?
//
// The important part is that it never answers that question once. A coin that launched a month ago
// and has sat quiet since gets called red every time bot 1 sees it — until the hour its volume
// jumps off its own baseline, and the same rules turn it green. Nothing about the coin's age is
// part of the decision; a coin that woke up is judged exactly like a coin that just launched.
//
// The order is cheapest-first, so the expensive lookup is only spent on coins that already look
// good:
//   dev history (local)  ->  hard gates (local)  ->  pump score (local)  ->  holders (RPC)
//
// Every verdict goes to data/bot2-filtered.jsonl. A state change is always written; a coin that
// keeps getting the same answer is written at most once every five minutes, so the log stays
// readable while still showing every coin that passed through.

import { devReason, gateReason, holderReason } from "../filters.js";
import { pumpScore } from "../signals.js";
import { fetchSafetyReport } from "../holders.js";
import { createMeter } from "../meter.js";

const REPEAT_LOG_MS = 5 * 60_000;
const RECENT_KEPT = 40;

export function createFilter({ config, universe, journal, devBook, log, note, onGreen, onDropped }) {
  const meter = createMeter();
  const stats = { evaluated: 0, green: 0, watch: 0, red: 0, rugs: 0, holderChecks: 0 };
  const categories = {}; // why coins were turned down: category -> count
  const green = new Map(); // mint -> { at, score }
  const recent = []; // newest first: the last coins that went green, for the dashboard
  let lastLogAt = new Map();

  function countCategory(category) {
    categories[category] = (categories[category] ?? 0) + 1;
  }

  // A coin that collapsed from the peak this bot measured counts as a rug against its creator,
  // once. That is what makes the dev-history gate mean something over a long run.
  function noteRugIfCollapsed(record) {
    if (record.ruggedNoted || !Number.isFinite(record.marketCapUsd)) return;
    let peak = 0;
    for (const snapshot of record.snapshots) {
      if (Number.isFinite(snapshot.marketCapUsd) && snapshot.marketCapUsd > peak) peak = snapshot.marketCapUsd;
    }
    if (peak > 0 && record.marketCapUsd <= peak * (1 - config.rugDropPct) && devBook.recordRug(record.mint)) {
      record.ruggedNoted = true;
      stats.rugs += 1;
      journal.write({ type: "rug", mint: record.mint, symbol: record.symbol, peakMarketCapUsd: peak, marketCapUsd: record.marketCapUsd });
    }
  }

  function requestHolders(record) {
    const holders = record.holders;
    if (holders?.status === "pending") return;
    if (holders?.status === "error" && Date.now() < holders.retryAt) return;
    record.holders = { status: "pending" };
    stats.holderChecks += 1;
    fetchSafetyReport(record.mint, config.solanaRpcUrl, {
      topCount: config.topHoldersCount,
      skipLargest: config.topHoldersSkipLargest,
      freshWalletLimit: config.freshWalletLimit,
      freshWalletMaxTx: config.freshWalletMaxTx,
      freshWalletMaxAgeHours: config.freshWalletMaxAgeHours,
    })
      .then((result) => {
        record.holders = { status: "ok", ...result };
      })
      .catch((error) => {
        record.holders = { status: "error", retryAt: Date.now() + (error.rateLimited ? 30_000 : 10_000) };
      });
  }

  function setGreen(record, verdict) {
    const already = green.has(record.mint);
    green.set(record.mint, { at: already ? green.get(record.mint).at : Date.now(), score: verdict.score });
    universe.pin(record.mint, true);
    if (already) return;

    // The green list is capped: when it is full the weakest coin makes room for a stronger one.
    if (green.size > config.maxGreenCoins) {
      const weakest = [...green.entries()].sort((a, b) => a[1].score - b[1].score)[0];
      if (weakest && weakest[0] !== record.mint) drop(weakest[0], "replaced by a stronger coin");
    }
    stats.green += 1;
    recent.unshift({
      mint: record.mint,
      symbol: record.symbol,
      score: verdict.score,
      lead: verdict.lead,
      surgeFrom: verdict.surgeFrom ?? null,
      surgeRatio: verdict.surgeRatio,
      turnover: verdict.turnover,
      ageSeconds: universe.ageSeconds(record),
      marketCapUsd: record.marketCapUsd ?? null,
      liquidityUsd: record.liquidityUsd ?? null,
      volumeH1Usd: record.volumeH1Usd ?? null,
      at: Date.now(),
    });
    if (recent.length > RECENT_KEPT) recent.length = RECENT_KEPT;
    log(`[bot2] GREEN ${record.symbol || record.mint.slice(0, 8)} score=${verdict.score} (${verdict.lead}${volumeNote(verdict)}) age=${ageText(universe.ageSeconds(record))}`);
    note("candidate", `Bot 2 menilai ${record.symbol || record.mint.slice(0, 8)} berpotensi pump (skor ${verdict.score}); diserahkan ke bot 3.`, record.mint);
    onGreen?.(record, verdict);
  }

  function drop(mint, why) {
    if (!green.delete(mint)) return;
    universe.pin(mint, false);
    onDropped?.(mint, why);
  }

  // `previous` is the verdict before this pass; it has to be passed in, because by the time this
  // runs the record already carries the new one.
  function writeVerdict(record, verdict, previous, now) {
    const changed = previous?.state !== verdict.state || previous?.category !== verdict.category;
    const loggedAt = lastLogAt.get(record.mint) ?? 0;
    if (!changed && now - loggedAt < REPEAT_LOG_MS) return;
    lastLogAt.set(record.mint, now);
    if (lastLogAt.size > config.maxUniverseTokens) lastLogAt = new Map([...lastLogAt].slice(-config.maxUniverseTokens));
    journal.write({
      type: changed ? "verdict" : "recheck",
      mint: record.mint,
      symbol: record.symbol,
      state: verdict.state,
      score: verdict.score ?? null,
      lead: verdict.lead ?? null,
      category: verdict.category ?? null,
      detail: verdict.detail ?? null,
      ageSeconds: universe.ageSeconds(record, now),
      marketCapUsd: record.marketCapUsd ?? null,
      liquidityUsd: record.liquidityUsd ?? null,
      volumeH1Usd: record.volumeH1Usd ?? null,
      volumeH24Usd: record.volumeH24Usd ?? null,
      surgeFrom: verdict.surgeFrom ?? null,
      surgeRatio: verdict.surgeRatio ?? null,
      turnover: verdict.turnover ?? null,
      parts: verdict.parts ?? null,
    });
  }

  // The whole decision for one coin, in order of cost.
  function judge(record, now) {
    // A coin that has already collapsed once is never bought again, whatever it looks like now.
    // A rug often bounces off the floor and can score well on the way back up.
    if (devBook.isBanned(record.mint)) {
      return { state: "red", category: "rugged", detail: "this coin already collapsed once" };
    }
    const dev = devReason(devBook.assess(record.mint, config));
    if (dev) return { state: "red", ...dev };

    const gate = gateReason(record, config.gates);
    if (gate?.wait) return { state: "wait", category: gate.category, detail: gate.detail };
    if (gate) return { state: "red", ...gate };

    const scored = pumpScore(record, universe.ageSeconds(record, now));
    if (scored.score < config.watchScore) {
      return { state: "red", category: "low_score", detail: `score ${scored.score} below ${config.watchScore}`, ...scored };
    }
    if (scored.score < config.greenScore) {
      return { state: "watch", category: "building", detail: `score ${scored.score}, needs ${config.greenScore}`, ...scored };
    }

    // Good enough to buy — now the one lookup that costs an RPC call is worth making.
    if (config.solanaRpcUrl) {
      if (record.holders?.status !== "ok") {
        requestHolders(record);
        return { state: "watch", category: "holders_pending", detail: "waiting for the holder check", ...scored };
      }
      const holders = holderReason(record.holders, config);
      if (holders) return { state: "red", ...holders, ...scored, category: holders.category, detail: holders.detail };
    }
    return { state: "green", category: "green", detail: `score ${scored.score}`, ...scored };
  }

  return {
    // Called by bot 1 for every coin it screens. Cheap on purpose: a coin is only re-judged once
    // per RESCORE_INTERVAL_MS, however many times bot 1 sees it in between.
    consider(record, { now = Date.now() } = {}) {
      const previous = record.verdict;
      if (previous && now - previous.at < config.rescoreIntervalMs) return previous;

      noteRugIfCollapsed(record);
      const verdict = judge(record, now);
      verdict.at = now;
      stats.evaluated += 1;
      meter.hit(1, now);

      if (verdict.state === "red") {
        stats.red += 1;
        countCategory(verdict.category);
        if (previous?.state === "green") {
          log(`[bot2] ${record.symbol || record.mint.slice(0, 8)} is no longer green: ${verdict.detail}.`);
        }
        drop(record.mint, verdict.detail);
        universe.pin(record.mint, false);
      } else if (verdict.state === "watch") {
        if (previous?.state !== "watch") stats.watch += 1;
        countCategory(verdict.category);
        universe.pin(record.mint, true);
        if (previous?.state === "green") drop(record.mint, verdict.detail);
      } else if (verdict.state === "green") {
        setGreen(record, verdict);
      } else {
        countCategory(verdict.category); // still waiting for data
      }

      record.verdict = verdict;
      writeVerdict(record, verdict, previous, now);
      return verdict;
    },

    // Bot 3 asks before entering: a coin that stopped being green is not bought.
    isGreen(mint) {
      return green.has(mint);
    },

    greenMints() {
      return [...green.keys()];
    },

    status() {
      const list = [];
      for (const mint of green.keys()) {
        const record = universe.get(mint);
        if (!record) continue;
        list.push({
          mint,
          symbol: record.symbol,
          score: record.verdict?.score ?? null,
          lead: record.verdict?.lead ?? null,
          surgeFrom: record.verdict?.surgeFrom ?? null,
          surgeRatio: record.verdict?.surgeRatio ?? null,
          turnover: record.verdict?.turnover ?? null,
          ageSeconds: universe.ageSeconds(record),
          marketCapUsd: record.marketCapUsd ?? null,
          liquidityUsd: record.liquidityUsd ?? null,
          volumeH1Usd: record.volumeH1Usd ?? null,
          greenSince: green.get(mint)?.at ?? null,
        });
      }
      list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return {
        ...stats,
        perMinute: meter.perMinute(),
        greenNow: green.size,
        maxGreen: config.maxGreenCoins,
        greenScore: config.greenScore,
        watchScore: config.watchScore,
        holderCheck: Boolean(config.solanaRpcUrl),
        categories: { ...categories },
        greenList: list.slice(0, 25),
        recentGreen: recent.slice(0, 25),
      };
    },
  };
}

// How to describe a coin's volume in the log line. "x its normal hour" only means something when
// the coin HAS a normal hour to compare with; for a coin too young for that, what matters is how
// much money went through the pool.
function volumeNote(verdict) {
  if (verdict.surgeFrom === "baseline" && Number.isFinite(verdict.surgeRatio)) {
    return `, volume ${verdict.surgeRatio}x its normal hour`;
  }
  if (verdict.surgeFrom === "turnover" && Number.isFinite(verdict.turnover)) {
    return `, ${verdict.turnover}x the pool traded in an hour`;
  }
  return "";
}

function ageText(seconds) {
  if (!Number.isFinite(seconds)) return "?";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}
