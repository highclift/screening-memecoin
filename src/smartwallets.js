// Which wallets are worth following, learned here rather than bought in.
//
// The usual way to score "smart money" is a vendor's labelled wallet list. There isn't one in this
// project and buying one would make the score depend on somebody else's opinion, so this learns the
// same thing from what the desk watches anyway:
//
//   1. when a coin reaches the analyst, we take a sample of the wallets buying it right now, and
//      write down the market cap at that moment (`sample`),
//   2. some time later we look at what that coin did (`settle`). A coin that went up by
//      `winPct` credits every wallet in the sample; one that fell by `losePct` debits them,
//   3. a wallet's score is its hit rate, flattened towards neutral until it has a real record.
//
// So on night one it knows nothing and says so — every wallet scores 0.5 and the analyst's smart
// money component is neutral rather than invented. It becomes worth something after a few hundred
// settled samples, and `npm run report` can show whether it ever separates winners from losers.
//
// Stored in data/smart-wallets.json.

import fs from "node:fs";
import path from "node:path";

const MAX_WALLETS = 50_000;
const MAX_PENDING = 2_000;

function trimMap(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

export function createSmartWallets({
  filePath = path.resolve("data", "smart-wallets.json"),
  winPct = 0.5, // +50% from where we sampled: the buyers were early and right
  losePct = 0.35, // -35%: they were early and wrong
  settleAfterMs = 30 * 60_000, // how long a sample is given to prove itself
  giveUpAfterMs = 6 * 3_600_000, // a sample that never moved either way is dropped, not judged
  minSamples = 5, // below this a wallet has no record worth trusting
} = {}) {
  const wallets = new Map(); // wallet -> { hits, misses, lastAt }
  const pending = new Map(); // mint -> { at, marketCapUsd, wallets: string[] }
  let dirty = false;

  function load() {
    if (!filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const [wallet, record] of Array.isArray(parsed.wallets) ? parsed.wallets : []) {
        if (typeof wallet !== "string" || !record) continue;
        wallets.set(wallet, {
          hits: Number(record.hits) || 0,
          misses: Number(record.misses) || 0,
          lastAt: Number(record.lastAt) || 0,
        });
      }
      trimMap(wallets, MAX_WALLETS);
      for (const [mint, sample] of Array.isArray(parsed.pending) ? parsed.pending : []) {
        if (typeof mint !== "string" || !sample || !Array.isArray(sample.wallets)) continue;
        pending.set(mint, {
          at: Number(sample.at) || 0,
          marketCapUsd: Number(sample.marketCapUsd) || 0,
          wallets: sample.wallets.filter((w) => typeof w === "string"),
        });
      }
      trimMap(pending, MAX_PENDING);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error(`[smart-wallets] Could not load ${filePath}: ${error.message}. Starting empty.`);
      }
    }
  }

  load();

  function credit(wallet, won, now) {
    const record = wallets.get(wallet) ?? { hits: 0, misses: 0, lastAt: now };
    wallets.delete(wallet); // re-insert so the most recently active wallets survive trimming
    if (won) record.hits += 1;
    else record.misses += 1;
    record.lastAt = now;
    wallets.set(wallet, record);
    trimMap(wallets, MAX_WALLETS);
    dirty = true;
  }

  return {
    // Write down who was buying this coin, and what it was worth at the time.
    sample(mint, buyers, marketCapUsd, now = Date.now()) {
      const list = [...(buyers ?? [])].filter((wallet) => typeof wallet === "string").slice(0, 100);
      if (!list.length || !Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return false;
      if (pending.has(mint)) return false; // one open sample per coin: a second would double-count
      pending.set(mint, { at: now, marketCapUsd, wallets: list });
      trimMap(pending, MAX_PENDING);
      dirty = true;
      return true;
    },

    // Called with whatever the desk currently knows about a coin. Settles any sample that has had
    // long enough to prove itself.
    settle(mint, marketCapUsd, now = Date.now()) {
      const sample = pending.get(mint);
      if (!sample) return null;
      if (now - sample.at < settleAfterMs) return null;

      if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) {
        if (now - sample.at >= giveUpAfterMs) {
          pending.delete(mint);
          dirty = true;
        }
        return null;
      }

      const change = marketCapUsd / sample.marketCapUsd - 1;
      let won = null;
      if (change >= winPct) won = true;
      else if (change <= -losePct) won = false;
      else if (now - sample.at >= giveUpAfterMs) {
        // It went nowhere. That is not a verdict on the wallets, so nobody is credited.
        pending.delete(mint);
        dirty = true;
        return null;
      } else {
        return null; // still running
      }

      for (const wallet of sample.wallets) credit(wallet, won, now);
      pending.delete(mint);
      dirty = true;
      return { won, change, wallets: sample.wallets.length };
    },

    // 0..1 for one wallet. Flattened towards 0.5 until it has `minSamples` settled coins behind it,
    // so a wallet that got one coin right does not read as a genius.
    score(wallet) {
      const record = wallets.get(wallet);
      if (!record) return 0.5;
      const total = record.hits + record.misses;
      if (total === 0) return 0.5;
      const rate = record.hits / total;
      const confidence = Math.min(1, total / minSamples);
      return 0.5 + (rate - 0.5) * confidence;
    },

    // What the analyst asks: how good is the crowd buying this coin right now? Returns null when
    // we know nothing about any of them, which the analyst scores as neutral rather than as bad.
    crowdScore(buyers) {
      const list = [...(buyers ?? [])];
      if (!list.length) return null;
      let known = 0;
      let total = 0;
      for (const wallet of list) {
        const record = wallets.get(wallet);
        if (!record || record.hits + record.misses === 0) continue;
        known += 1;
        total += this.score(wallet);
      }
      if (!known) return null;
      return { score: total / known, known, of: list.length };
    },

    save() {
      if (!filePath || !dirty) return;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({
          wallets: [...wallets.entries()],
          pending: [...pending.entries()],
        }));
        dirty = false;
      } catch (error) {
        console.error(`[smart-wallets] Could not save: ${error.message}`);
      }
    },

    stats() {
      let rated = 0;
      let hits = 0;
      let misses = 0;
      for (const record of wallets.values()) {
        const total = record.hits + record.misses;
        if (total >= minSamples) rated += 1;
        hits += record.hits;
        misses += record.misses;
      }
      return { wallets: wallets.size, rated, pending: pending.size, hits, misses };
    },
  };
}
