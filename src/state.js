import fs from "node:fs";
import path from "node:path";

// Bot 3's paper account — one account for the whole pipeline. Bot 1 and bot 2 keep no state on
// disk: their work is the universe registry in memory plus their own logs.

// Resolved once, against the CWD at import time. Anything importing this module is therefore bound
// to the data/ directory of wherever it was started from — which is what keeps a scratch run from
// writing to the real paper account, and why a test must chdir BEFORE it imports this file.
const STATE_PATH = path.resolve("data", "paper-state.json");

/** Where this module will read and write. Exported so a test can prove it is not the real one. */
export function stateFilePath() {
  return STATE_PATH;
}

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

// Write-then-rename, so a crash mid-write can never leave a half-written account behind.
//
// On Windows the rename is the part that fails. Unlike POSIX, a rename onto a destination that
// another process currently has OPEN is refused with EPERM — and the dashboard reads this exact
// file on every /api/state poll, so the two collide whenever a read is in flight at the moment the
// worker saves. It is transient by nature: the reads are sub-millisecond, so a retry a few
// milliseconds later lands in the gap. The same applies to EBUSY and EACCES from a virus scanner
// or the search indexer holding the file for a moment after it is written.
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms) {
  // The save path is synchronous on purpose (it runs in shutdown, where nothing awaits), so the
  // wait has to be synchronous too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function saveState(state, { attempts = 5 } = {}) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(tempPath, STATE_PATH);
      return;
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= attempts) {
        // Leave no temp file behind to be mistaken for an account later.
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* the temp file is already gone, or is itself locked; either way it is not the problem */
        }
        throw error;
      }
      sleepSync(attempt * 20);
    }
  }
}

export function currentUtcDay() {
  return new Date().toISOString().slice(0, 10);
}
