import fs from "node:fs";
import path from "node:path";

const STATE_PATH = path.resolve("data", "paper-state.json");

function freshState(startingBalance) {
  return {
    balanceSol: startingBalance,
    positions: {},
    seenMints: [],
    screenedMigrationMints: [],
    closedTrades: [],
    daily: { day: new Date().toISOString().slice(0, 10), entries: 0, realizedPnlSol: 0 },
  };
}

export function loadState(startingBalance) {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!Number.isFinite(parsed.balanceSol) || !parsed.positions || !Array.isArray(parsed.seenMints)) {
      throw new Error("invalid state shape");
    }
    parsed.closedTrades = Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [];
    parsed.screenedMigrationMints = Array.isArray(parsed.screenedMigrationMints)
      ? parsed.screenedMigrationMints
      : [];
    parsed.daily = parsed.daily && typeof parsed.daily === "object"
      ? parsed.daily
      : { day: new Date().toISOString().slice(0, 10), entries: 0, realizedPnlSol: 0 };
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`[state] Could not load ${STATE_PATH}: ${error.message}. Starting a fresh paper account.`);
    }
    return freshState(startingBalance);
  }
}

export function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, STATE_PATH);
}

export function currentUtcDay() {
  return new Date().toISOString().slice(0, 10);
}
