import fs from "node:fs";
import path from "node:path";

// Paper accounts for the age lanes (young, veteran). The fresh lane keeps using paper-state.json
// so the existing dashboard keeps working. Cooldowns (pools already looked at) live here too.

const DEFAULT_PATH = path.resolve("data", "lanes-state.json");

export function createAccount(startBalanceSol, day) {
  return {
    startBalanceSol,
    balanceSol: startBalanceSol,
    positions: {},
    closedTrades: [],
    daily: { day, entries: 0, realizedPnlSol: 0 },
  };
}

function sane(account) {
  return Boolean(account) && typeof account === "object"
    && Number.isFinite(account.balanceSol)
    && account.positions && typeof account.positions === "object" && !Array.isArray(account.positions)
    && Array.isArray(account.closedTrades)
    && account.daily && typeof account.daily === "object";
}

export function loadLaneState(startBalances, day, filePath = DEFAULT_PATH) {
  const result = { lanes: {}, cooldowns: {} };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.error(`[lanes] Could not read ${filePath}: ${error.message}. Starting fresh accounts.`);
  }
  for (const [id, start] of Object.entries(startBalances)) {
    const saved = parsed?.lanes?.[id];
    result.lanes[id] = sane(saved) ? saved : createAccount(start, day);
    if (!Number.isFinite(result.lanes[id].startBalanceSol)) result.lanes[id].startBalanceSol = start;
    const cooldowns = parsed?.cooldowns?.[id];
    result.cooldowns[id] = cooldowns && typeof cooldowns === "object" && !Array.isArray(cooldowns) ? cooldowns : {};
  }
  return result;
}

export function saveLaneState(laneState, filePath = DEFAULT_PATH) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(laneState), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    console.error(`[lanes] Could not save ${filePath}: ${error.message}`);
  }
}
