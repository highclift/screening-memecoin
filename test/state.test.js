import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// `src/state.js` resolves data/ from the CWD **at import time**, not at call time, so importing it
// once at the top of this file would bind it to the project directory and every save below would
// land on the real paper account. Each test therefore changes directory FIRST and imports a fresh
// copy of the module afterwards; the query string defeats the module cache so the next test gets
// its own STATE_PATH. (test/CLAUDE.md: "Test runs share the live data/ directory.")
let moduleCounter = 0;

async function inScratch(run) {
  const cwd = process.cwd();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "desk-state-")));
  process.chdir(dir);
  try {
    const state = await import(`../src/state.js?scratch=${(moduleCounter += 1)}`);
    const stateFile = path.join(dir, "data", "paper-state.json");
    assert.ok(state.stateFilePath().startsWith(dir), "the module bound itself outside the scratch directory");
    return await run({ ...state, dir, stateFile, tempFile: `${stateFile}.tmp` });
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a saved account loads back as it was", async () => {
  await inScratch(({ saveState, loadState, freshState }) => {
    const account = freshState(1);
    account.balanceSol = 0.75;
    account.closedTrades = [{ mint: "abc", pnlSol: -0.25 }];
    saveState(account);

    const loaded = loadState(1);
    assert.equal(loaded.balanceSol, 0.75);
    assert.equal(loaded.closedTrades.length, 1);
  });
});

test("the temp file is not left behind", async () => {
  await inScratch(({ saveState, freshState, stateFile, tempFile }) => {
    saveState(freshState(1));
    assert.ok(fs.existsSync(stateFile));
    assert.ok(!fs.existsSync(tempFile), "a .tmp file survived the save");
  });
});

// The failure that killed the desk: on Windows a rename onto a file another process has OPEN is
// refused with EPERM. fs.renameSync is stubbed here because reproducing the real race needs a
// second process and exact timing, which a unit test cannot hold still.
test("a transient rename failure is retried rather than thrown", async () => {
  await inScratch(({ saveState, loadState, freshState }) => {
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls += 1;
      if (calls < 3) {
        const error = new Error("EPERM: operation not permitted, rename");
        error.code = "EPERM";
        throw error;
      }
      return realRename(from, to);
    };
    try {
      saveState(freshState(1));
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(calls, 3, "it should have retried twice before succeeding");
    assert.equal(loadState(1).balanceSol, 1, "the account still landed on disk");
  });
});

test("a rename that never recovers gives up, cleans up, and reports the real error", async () => {
  await inScratch(({ saveState, freshState, tempFile }) => {
    const realRename = fs.renameSync;
    fs.renameSync = () => {
      const error = new Error("EPERM: operation not permitted, rename");
      error.code = "EPERM";
      throw error;
    };
    try {
      assert.throws(() => saveState(freshState(1), { attempts: 2 }), /EPERM/);
    } finally {
      fs.renameSync = realRename;
    }
    assert.ok(!fs.existsSync(tempFile), "giving up must not leave a temp file to be mistaken for an account");
  });
});

test("a failure that is not transient is not retried", async () => {
  await inScratch(({ saveState, freshState }) => {
    const realRename = fs.renameSync;
    let calls = 0;
    fs.renameSync = () => {
      calls += 1;
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    };
    try {
      assert.throws(() => saveState(freshState(1)), /ENOSPC/);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(calls, 1, "a full disk will not get better by trying again immediately");
  });
});

test("a missing account file is a fresh account, not a crash", async () => {
  await inScratch(({ loadState }) => {
    const loaded = loadState(2);
    assert.equal(loaded.balanceSol, 2);
    assert.equal(loaded.startBalanceSol, 2);
    assert.deepEqual(loaded.positions, {});
  });
});

test("a corrupt account file falls back to a fresh account", async () => {
  await inScratch(({ loadState, stateFile }) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{ this is not json");
    assert.equal(loadState(1).balanceSol, 1);
  });
});
