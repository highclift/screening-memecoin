import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { AGENT_SETTINGS, allFields, envOverrides, publicSchema, shownValues } from "../src/settings.js";

const baseEnv = { MODE: "paper" };
const base = () => loadConfig(baseEnv);

// A wrong scale is the failure this file exists for: the dashboard would show a sensible-looking
// number, write a different one to the env, and the desk would quietly run on settings nobody
// chose. Every assertion below is some form of "what is shown survives a round trip".

test("every field points at something that exists in a loaded config", () => {
  const config = base();
  for (const field of allFields()) {
    const value = field.path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), config);
    assert.notEqual(value, undefined, `${field.name} -> ${field.path} is not in the config`);
  }
});

test("field names are unique and are the env var they write", () => {
  const names = allFields().map((field) => field.name);
    assert.equal(new Set(names).size, names.length, "two fields share a name");
  for (const name of names) {
    assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${name} is not an env var name`);
  }
});

test("shown values round-trip back to the same config", () => {
  const config = base();
  const shown = shownValues(config);
  const roundTripped = loadConfig({ ...baseEnv, ...envOverrides(shown) });

  for (const field of allFields()) {
    const read = (node) => field.path.split(".").reduce((n, key) => (n == null ? undefined : n[key]), node);
    const before = read(config);
    const after = read(roundTripped);
    if (typeof before === "number") {
      // Minutes and seconds do not divide evenly into every stored millisecond value, so this
      // allows a rounding step rather than demanding bit equality.
      assert.ok(
        Math.abs(before - after) <= Math.max(Math.abs(before) * 1e-6, 1e-6),
        `${field.name}: ${before} became ${after}`,
      );
    } else {
      assert.equal(after, before, `${field.name} did not survive the round trip`);
    }
  }
});

test("the scaled fields are shown in the units their label claims", () => {
  const config = loadConfig({ ...baseEnv, POSITION_PCT: "0.08", MIN_AGE_MINUTES: "30", MAX_HOLD_MINUTES: "10", RESCORE_INTERVAL_MS: "15000" });
  const shown = shownValues(config);

  assert.equal(shown.POSITION_PCT, 8, "a fraction of 0.08 is 8%");
  assert.equal(shown.MIN_AGE_MINUTES, 30, "1800 stored seconds is 30 minutes");
  assert.equal(shown.MAX_HOLD_MINUTES, 10, "600000 stored ms is 10 minutes");
  assert.equal(shown.RESCORE_INTERVAL_MS, 15, "15000ms is shown as 15 seconds");
});

test("a shown value is written back in the env var's own units", () => {
  assert.equal(envOverrides({ POSITION_PCT: 12 }).POSITION_PCT, "0.12");
  assert.equal(envOverrides({ MIN_AGE_MINUTES: 45 }).MIN_AGE_MINUTES, "45");
  assert.equal(envOverrides({ RESCORE_INTERVAL_MS: 20 }).RESCORE_INTERVAL_MS, "20000");
  assert.equal(envOverrides({ REQUIRE_MINT_REVOKED: false }).REQUIRE_MINT_REVOKED, "false");
  assert.equal(envOverrides({ ENTRY_MODE: "dip" }).ENTRY_MODE, "dip");
});

test("a setting the dashboard does not own is refused", () => {
  // Anything that could reach a wallet, a key or the mode must not be settable from a web form.
  assert.throws(() => envOverrides({ SOLANA_RPC_URL: "https://example.com" }), /not a setting/);
  assert.throws(() => envOverrides({ MODE: "live" }), /not a setting/);
  assert.throws(() => envOverrides({ PUMPPORTAL_API_KEY: "x" }), /not a setting/);
});

test("rubbish values are refused before they reach the config", () => {
  assert.throws(() => envOverrides({ PASS_SCORE: "not a number" }), /must be a number/);
  assert.throws(() => envOverrides({ ENTRY_MODE: "sideways" }), /must be one of/);
});

test("config still owns the range and cross-field rules", () => {
  // The schema deliberately does not re-check these; loadConfig is the one place they live.
  assert.throws(
    () => loadConfig({ ...baseEnv, ...envOverrides({ STOP_PCT: 20, TRAIL_AFTER_PCT: 10 }) }),
    /TRAIL_AFTER_PCT must be greater than STOP_PCT/,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, ...envOverrides({ MIN_MARKET_CAP_USD: 50_000_000, MAX_MARKET_CAP_USD: 1000 }) }),
    /MIN_MARKET_CAP_USD cannot be greater/,
  );
});

test("the schema the dashboard receives carries no server-only plumbing", () => {
  const schema = publicSchema();
  assert.deepEqual(Object.keys(schema), Object.keys(AGENT_SETTINGS));
  for (const group of Object.values(schema)) {
    assert.ok(group.title && group.blurb, "every group is labelled");
    for (const field of group.fields) {
      assert.ok(field.label, `${field.name} has no label`);
      assert.equal(field.path, undefined, `${field.name} leaked its config path`);
      assert.equal(field.configScale, undefined, `${field.name} leaked its scale`);
      assert.ok(["number", "bool", "enum"].includes(field.type), `${field.name} has type ${field.type}`);
      if (field.type === "enum") assert.ok(field.options?.length, `${field.name} has no options`);
    }
  }
});

test("every agent on the rail has a settings group", () => {
  // The rail renders these six; a gear that opens an empty sheet is a dead end.
  for (const agent of ["scout", "filter", "analyst", "executor", "risk", "logger"]) {
    assert.ok(AGENT_SETTINGS[agent]?.fields?.length, `${agent} has no settings`);
  }
});
