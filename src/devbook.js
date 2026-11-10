import fs from "node:fs";
import path from "node:path";

// Local "who launched this" book. It only knows creators whose launch event this bot saw while
// running, so coverage grows with uptime. Tokens it has never seen launch are "unknown" (not bad).
//  - launches: tokens this wallet launched that the bot saw
//  - migrated: how many of those reached an AMM pool
//  - rugs:     how many collapsed by RUG_DROP_PCT from their observed peak while being screened

const MAX_CREATORS = 20_000;
const MAX_MINTS = 80_000;

function trimMap(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

function trimSet(set, max) {
  while (set.size > max) set.delete(set.values().next().value);
}

export function createDevBook({ filePath = path.resolve("data", "devbook.json") } = {}) {
  const creators = new Map(); // wallet -> { launches, migrated, rugs, lastSeen }
  const mintToCreator = new Map();
  const migratedMints = new Set();
  const ruggedMints = new Set();
  let dirty = false;

  function load() {
    if (!filePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const mint of Array.isArray(parsed.ruggedMints) ? parsed.ruggedMints : []) {
        if (typeof mint === "string" && mint) ruggedMints.add(mint);
      }
      trimSet(ruggedMints, MAX_MINTS);
      for (const [mint, creator] of Array.isArray(parsed.mintToCreator) ? parsed.mintToCreator : []) {
        if (typeof mint === "string" && typeof creator === "string") mintToCreator.set(mint, creator);
      }
      trimMap(mintToCreator, MAX_MINTS);
      for (const [wallet, stats] of Array.isArray(parsed.creators) ? parsed.creators : []) {
        if (typeof wallet !== "string" || !stats || typeof stats !== "object") continue;
        creators.set(wallet, {
          launches: Number(stats.launches) || 0,
          migrated: Number(stats.migrated) || 0,
          rugs: Number(stats.rugs) || 0,
          lastSeen: Number(stats.lastSeen) || 0,
        });
      }
      trimMap(creators, MAX_CREATORS);
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`[devbook] Could not load ${filePath}: ${error.message}. Starting empty.`);
    }
  }

  function touch(wallet, now) {
    const existing = creators.get(wallet) ?? { launches: 0, migrated: 0, rugs: 0, lastSeen: now };
    creators.delete(wallet); // re-insert so the most recently active creators are kept when trimming
    existing.lastSeen = now;
    creators.set(wallet, existing);
    trimMap(creators, MAX_CREATORS);
    return existing;
  }

  load();

  return {
    recordLaunch(creator, mint, now = Date.now()) {
      if (typeof creator !== "string" || !creator || typeof mint !== "string" || !mint) return;
      if (mintToCreator.has(mint)) return;
      mintToCreator.set(mint, creator);
      trimMap(mintToCreator, MAX_MINTS);
      touch(creator, now).launches += 1;
      dirty = true;
    },

    creatorOf(mint) {
      return mintToCreator.get(mint) ?? null;
    },

    recordMigration(mint, now = Date.now()) {
      const creator = mintToCreator.get(mint);
      if (!creator || migratedMints.has(mint)) return;
      migratedMints.add(mint);
      trimSet(migratedMints, MAX_MINTS);
      touch(creator, now).migrated += 1;
      dirty = true;
    },

    // A coin that collapsed. Recorded even when the creator is unknown — most rugs are coins this
    // bot met through a pool listing rather than at launch, and those used to be forgotten
    // entirely, so the same coin could be bought again minutes later.
    recordRug(mint, now = Date.now()) {
      if (typeof mint !== "string" || !mint || ruggedMints.has(mint)) return false;
      ruggedMints.add(mint);
      trimSet(ruggedMints, MAX_MINTS);
      const creator = mintToCreator.get(mint);
      if (creator) touch(creator, now).rugs += 1;
      dirty = true;
      return true;
    },

    // Banned for good: this exact coin already collapsed once. Survives a restart.
    isBanned(mint) {
      return ruggedMints.has(mint);
    },

    bannedCount() {
      return ruggedMints.size;
    },

    // verdict: "unknown" (creator never seen) | "clean" | "reject"
    assess(mint, rules = {}) {
      const creator = mintToCreator.get(mint);
      const stats = creator ? creators.get(creator) : null;
      if (!creator || !stats) return { verdict: "unknown", reason: "creator not seen at launch" };
      const summary = { launches: stats.launches, migrated: stats.migrated, rugs: stats.rugs };
      if (rules.maxDevRugs > 0 && stats.rugs >= rules.maxDevRugs) {
        return { verdict: "reject", reason: `dev has ${stats.rugs} rugged token(s)`, ...summary };
      }
      if (rules.maxDevLaunches > 0 && stats.launches > rules.maxDevLaunches) {
        return { verdict: "reject", reason: `dev launched ${stats.launches} tokens (limit ${rules.maxDevLaunches})`, ...summary };
      }
      return { verdict: "clean", reason: "", ...summary };
    },

    size() {
      return creators.size;
    },

    save() {
      if (!dirty || !filePath) return;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.tmp`;
        // The rug list is the valuable part: without it a restart forgets which coins already
        // collapsed and the bot is free to buy them again.
        fs.writeFileSync(tempPath, JSON.stringify({
          creators: Array.from(creators.entries()),
          ruggedMints: Array.from(ruggedMints),
          mintToCreator: Array.from(mintToCreator.entries()).slice(-MAX_MINTS),
        }), { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tempPath, filePath);
        dirty = false;
      } catch (error) {
        console.error(`[devbook] Could not save ${filePath}: ${error.message}`);
      }
    },
  };
}
