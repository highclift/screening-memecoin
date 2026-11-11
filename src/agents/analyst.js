// AGENT 3 — ANALYST
//
// Everything that reaches here is already tradable and not an obvious rug: the filter settled that.
// The analyst answers the different question — out of the coins that are safe enough, which ones
// are actually worth the money — and it answers with one number out of 100 (signals.js, deskScore).
//
// Only `passScore` and above is handed to the executor. Below it the coin is killed with its score
// and its parts written down, which is the point: after a night there is a file saying what each
// score was made of and what happened next, so the weights can be argued with from evidence rather
// than from taste.
//
// It is also the only stage that looks at WHO is buying. Once per coin it samples the wallets
// trading the pool and hands them to the smart-wallet registry, which settles them against what the
// coin did afterwards. That costs one GeckoTerminal call per coin, which is why it happens here —
// after three cheaper stages have already thrown most coins away.

import { deskScore } from "../signals.js";
import { createMeter } from "../meter.js";

const SAMPLE_EVERY_MS = 20 * 60_000; // one buyer sample per coin per 20 minutes

export function createAnalyst({ config, universe, feed, smartWallets, logger, onPassed, onDropped }) {
  const meter = createMeter();
  const stats = { scored: 0, passed: 0, rejected: 0, samples: 0, settled: 0, settledWins: 0 };
  const passing = new Map(); // mint -> { at, score }
  const buckets = {}; // score band -> how many coins landed in it
  let sampling = false;

  function bucketOf(score) {
    if (score >= 90) return "90+";
    if (score >= 80) return "80-89";
    if (score >= 70) return "70-79";
    if (score >= 60) return "60-69";
    if (score >= 50) return "50-59";
    return "<50";
  }

  // One GeckoTerminal call: who is buying this pool right now. The registry decides later, from
  // what the coin did, whether those wallets were worth listening to.
  function sampleBuyers(record, now) {
    if (sampling || !record.pool) return;
    if (now - (record.lastBuyerSampleAt ?? 0) < SAMPLE_EVERY_MS) return;
    record.lastBuyerSampleAt = now;
    sampling = true;
    feed.buyers(record.pool)
      .then((buyers) => {
        if (!buyers?.size) return;
        record.recentBuyers = [...buyers];
        if (smartWallets.sample(record.mint, buyers, record.marketCapUsd, Date.now())) stats.samples += 1;
      })
      .catch(() => {})
      .finally(() => {
        sampling = false;
      });
  }

  function drop(mint, why) {
    if (!passing.delete(mint)) return;
    onDropped?.(mint, why);
  }

  return {
    // Called by the filter for every coin that clears it.
    consider(record, { now = Date.now() } = {}) {
      const previous = record.analysis;
      if (previous && now - previous.at < config.rescoreIntervalMs) return previous;

      // Whatever we know about this coin now is also the answer to a sample taken earlier.
      const settled = smartWallets.settle(record.mint, record.marketCapUsd, now);
      if (settled) {
        stats.settled += 1;
        if (settled.won) stats.settledWins += 1;
      }

      sampleBuyers(record, now);

      const crowd = record.recentBuyers ? smartWallets.crowdScore(record.recentBuyers) : null;
      const analysis = { ...deskScore(record, { smartCrowd: crowd }), at: now };
      record.analysis = analysis;
      stats.scored += 1;
      meter.hit(1, now);
      buckets[bucketOf(analysis.score)] = (buckets[bucketOf(analysis.score)] ?? 0) + 1;

      if (analysis.score < config.passScore) {
        stats.rejected += 1;
        logger.kill("analyst", record, {
          category: "below_score",
          detail: `scored ${analysis.score}, needs ${config.passScore} (strongest part: ${analysis.lead}, ${analysis.measured}/${analysis.of} measured)`,
          parts: analysis.parts,
          lead: analysis.lead,
        }, now);
        drop(record.mint, `score fell to ${analysis.score}`);
        return analysis;
      }

      const first = !passing.has(record.mint);
      passing.set(record.mint, { at: first ? now : passing.get(record.mint).at, score: analysis.score });
      if (first) {
        stats.passed += 1;
        logger.pass("analyst", record, {
          score: analysis.score,
          lead: analysis.lead,
          measured: `${analysis.measured}/${analysis.of}`,
          parts: analysis.parts,
        }, { write: true, now });
        logger.say(`[analyst] ${record.symbol || record.mint.slice(0, 8)} scores ${analysis.score}/100 (${analysis.lead} leading, ${analysis.measured}/${analysis.of} parts measured) -> executor`);
        logger.tell("candidate", `Analyst memberi skor ${analysis.score}/100 untuk ${record.symbol || record.mint.slice(0, 8)}; diserahkan ke executor.`, record.mint);
      }
      onPassed?.(record, analysis);
      return analysis;
    },

    // The filter killed it, so it is no longer a candidate whatever it scored.
    withdraw(mint, why) {
      drop(mint, why);
    },

    scoreOf(mint) {
      return passing.get(mint)?.score ?? null;
    },

    passes(mint) {
      return passing.has(mint);
    },

    status() {
      const list = [];
      for (const [mint, entry] of passing) {
        const record = universe.get(mint);
        if (!record) continue;
        list.push({
          mint,
          symbol: record.symbol,
          score: entry.score,
          lead: record.analysis?.lead ?? null,
          measured: record.analysis?.measured ?? null,
          parts: record.analysis?.parts ?? null,
          ageSeconds: universe.ageSeconds(record),
          marketCapUsd: record.marketCapUsd ?? null,
          liquidityUsd: record.liquidityUsd ?? null,
          buyersH1: record.buyersH1 ?? null,
          since: entry.at,
        });
      }
      list.sort((a, b) => b.score - a.score);
      return {
        ...stats,
        perMinute: meter.perMinute(),
        passScore: config.passScore,
        passingNow: passing.size,
        buckets: { ...buckets },
        smartWallets: smartWallets.stats(),
        candidates: list.slice(0, 25),
      };
    },
  };
}
