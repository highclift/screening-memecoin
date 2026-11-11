// AGENT 6 — LOGGER
//
// Every other agent reports here, and the rule it exists to enforce is "log every kill": when a
// coin is turned down, the reason is written to disk with the numbers that caused it. That is what
// makes the overnight run readable in the morning — `npm run report` is built entirely out of
// these lines, and a desk that only logs its trades can never answer the useful question, which is
// what it refused and whether it was right to.
//
// Files (data/):
//   scout.jsonl    what the scout saw
//   kills.jsonl    every refusal, from any stage, with its reason
//   trades.jsonl   entries, exits, and the money limits that blocked one
//
// A coin that keeps failing the same check is written once and then at most every five minutes, so
// a coin refused four times a minute all night does not bury the file. The counters are exact
// either way: deduplication affects the file, never the totals.

const REPEAT_MS = 5 * 60_000;

export const STAGES = ["scout", "filter", "analyst", "executor", "risk"];

export function createLogger({ journals, maxTracked = 20_000, repeatMs = REPEAT_MS, log, note }) {
  // mint|stage|category -> when it was last written
  let lastWriteAt = new Map();
  const killsByStage = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const killsByCategory = {};
  let totalKills = 0;
  let totalPasses = 0;

  function shouldWrite(key, now) {
    const previous = lastWriteAt.get(key) ?? 0;
    if (now - previous < repeatMs) return false;
    lastWriteAt.set(key, now);
    if (lastWriteAt.size > maxTracked) {
      lastWriteAt = new Map([...lastWriteAt].slice(-Math.floor(maxTracked / 2)));
    }
    return true;
  }

  return {
    // The one every agent calls. `detail` is the sentence a person reads; `category` is what the
    // report groups by.
    kill(stage, record, { category, detail, ...extra } = {}, now = Date.now()) {
      totalKills += 1;
      if (killsByStage[stage] !== undefined) killsByStage[stage] += 1;
      killsByCategory[category] = (killsByCategory[category] ?? 0) + 1;

      if (!shouldWrite(`${record?.mint}|${stage}|${category}`, now)) return false;
      journals.kills.write({
        type: "kill",
        stage,
        mint: record?.mint ?? null,
        symbol: record?.symbol ?? "",
        category,
        detail,
        ageSeconds: Number.isFinite(record?.ageSeconds) ? record.ageSeconds : null,
        marketCapUsd: record?.marketCapUsd ?? null,
        liquidityUsd: record?.liquidityUsd ?? null,
        volumeH1Usd: record?.volumeH1Usd ?? null,
        buyersH1: record?.buyersH1 ?? null,
        score: record?.analysis?.score ?? null,
        ...extra,
      });
      return true;
    },

    // A coin clearing a stage. Only the interesting ones are written (the analyst's passes); the
    // count is kept for all of them so the funnel adds up.
    pass(stage, record, extra = {}, { write = false, now = Date.now() } = {}) {
      totalPasses += 1;
      if (!write) return false;
      if (!shouldWrite(`${record?.mint}|${stage}|pass`, now)) return false;
      journals.kills.write({
        type: "pass",
        stage,
        mint: record?.mint ?? null,
        symbol: record?.symbol ?? "",
        ...extra,
      });
      return true;
    },

    // What the scout saw. High volume, its own file.
    sighting(entry) {
      journals.scout.write(entry);
    },

    // Entries, exits and blocked entries.
    trade(entry) {
      journals.trades.write(entry);
    },

    // Plain-language lines for the terminal and the dashboard story.
    say(message) {
      log?.(message);
    },

    tell(level, message, mint = "") {
      note?.(level, message, mint);
    },

    status() {
      return {
        kills: totalKills,
        passes: totalPasses,
        byStage: { ...killsByStage },
        byCategory: { ...killsByCategory },
        files: Object.entries(journals).map(([name, journal]) => ({ name, ...journal.stats() })),
      };
    },
  };
}
