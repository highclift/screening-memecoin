// No user-visible string may be hard-coded in public/, and no key may exist in one language only.
// These tests read the dashboard files as text, so they need no browser.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const publicDir = path.resolve("public");
const read = (name) => fs.readFileSync(path.join(publicDir, name), "utf8");
const dictionary = read("i18n.js");

// Keys per language block, in file order.
function keysByLang(text) {
  const result = { id: [], en: [] };
  let lang = "";
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^ {2}(id|en): \{$/);
    if (start) {
      lang = start[1];
      continue;
    }
    if (line === "  },") {
      lang = "";
      continue;
    }
    const key = line.match(/^\s*"([^"]+)":/);
    if (key && lang) result[lang].push(key[1]);
  }
  return result;
}

const keys = keysByLang(dictionary);
const idSet = new Set(keys.id);
const enSet = new Set(keys.en);

// Keys built at runtime from a variable, with the values that variable can take.
const DYNAMIC = [
  ...["screener", "filter", "executor"].flatMap((bot) => [
    `bot.${bot}.name`, `bot.${bot}.stage`, `bot.${bot}.task`, `bot.${bot}.badge`, `bot.${bot}.detailsToggle`,
  ]),
  ...["surge", "buyPressure", "breadth", "momentum", "depth"].map((lead) => `lead.${lead}`),
  ...["measure", "dip", "bounce", "buyers", "spike", "data", "entry", "unknown"].map((state) => `waiting.${state}`),
  // Bot 2's gate categories (src/filters.js) and the states it reports.
  ...["market_cap", "liquidity", "liquidity_ratio", "dead", "dead_volume", "holders", "dev_history",
    "low_score", "no_data", "building", "holders_pending", "green", "unknown"].map((c) => `reason.${c}`),
  // Bot 3's exit reasons (src/bots/executor.js).
  ...["stop-loss", "trail", "trail-locked", "stall", "breakdown", "max-hold", "max-hold-stale", "exit"]
    .map((reason) => `exit.${reason}`),
  ...["stopped", "starting", "running", "stopping", "error"].map((state) => `runtime.${state}`),
];

test("every dictionary key exists in both languages", () => {
  // Singular forms ("<key>.one") are English-only on purpose: Indonesian does not inflect for
  // number, so tn() falls through to the plural form (see the comment on tn in i18n.js).
  const onlyId = keys.id.filter((key) => !enSet.has(key));
  const onlyEn = keys.en.filter((key) => !idSet.has(key) && !key.endsWith(".one"));
  assert.deepEqual(onlyId, [], "keys missing from the English dictionary");
  assert.deepEqual(onlyEn, [], "keys missing from the Indonesian dictionary");

  for (const key of keys.en.filter((k) => k.endsWith(".one"))) {
    const base = key.slice(0, -".one".length);
    assert.ok(idSet.has(base) && enSet.has(base), `${key} has no plural form to fall back to`);
  }
  assert.ok(keys.id.length > 200, `only ${keys.id.length} keys found — the parser probably broke`);
});

test("no key is defined twice in the same language", () => {
  for (const lang of ["id", "en"]) {
    const seen = new Set();
    const duplicates = keys[lang].filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
    assert.deepEqual(duplicates, [], `${lang} has duplicate keys`);
  }
});

test("every key the markup asks for exists", () => {
  const html = read("index.html");
  const wanted = new Set();
  for (const match of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) wanted.add(match[1]);
  for (const match of html.matchAll(/data-help="([^"]+)"/g)) wanted.add(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(",")) wanted.add(pair.split(":")[1]?.trim());
  }
  const missing = [...wanted].filter((key) => key && !idSet.has(key));
  assert.deepEqual(missing, [], "index.html references keys that are not in the dictionary");
});

test("every key the dashboard scripts ask for exists", () => {
  const wanted = new Set(DYNAMIC);
  for (const file of ["app.js", "bots-view.js", "funnel.js", "humanize.js", "anim.js"]) {
    const source = read(file);
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) wanted.add(match[1]);
    for (const match of source.matchAll(/\btn\(\s*"([^"]+)"/g)) wanted.add(match[1]);
    // Keys assembled from a dictionary-key constant, e.g. botStatRow("bot.stat.coins").
    for (const match of source.matchAll(/"((?:bot|lead|waiting|reason|exit|funnel|help)\.[a-zA-Z0-9_.-]+)"/g)) {
      wanted.add(match[1]);
    }
  }
  const missing = [...wanted].filter((key) => key && !key.includes("${") && !idSet.has(key));
  assert.deepEqual(missing, [], "public/*.js references keys that are not in the dictionary");
});

test("no dictionary key is left over from the three-lane design", () => {
  const stale = keys.id.filter((key) => key.startsWith("lane.") || key.startsWith("stage.") || key.startsWith("lanes."));
  assert.deepEqual(stale, [], "lane/stage keys belong to the removed design");
});
