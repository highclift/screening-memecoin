import fs from "node:fs";
import path from "node:path";

// Bot 3's paper account — one account for the whole pipeline. Bot 1 and bot 2 keep no state on
// disk: their work is the universe registry in memory plus their own logs.

const STATE_PATH = path.resolve("data", "paper-state.json");

export function freshState(startingBalance) {
  return {
    balanceSol: startingBalance,
    startBalanceSol: startingBalance,
    positions: {},
    closedTrades: [],
    daily: { day: currentUtcDay(), entries: 0, realizedPnlSol: 0 },
  };
}

export function loadState(startingBalance) {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!Number.isFinite(parsed.balanceSol) || !parsed.positions || typeof parsed.positions !== "object") {
      throw new Error("invalid state shape");
    }
    parsed.closedTrades = Array.isArray(parsed.closedTrades) ? parsed.closedTrades : [];
    parsed.startBalanceSol = Number.isFinite(parsed.startBalanceSol) ? parsed.startBalanceSol : startingBalance;
    parsed.daily = parsed.daily && typeof parsed.daily === "object"
      ? parsed.daily
      : { day: currentUtcDay(), entries: 0, realizedPnlSol: 0 };
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
