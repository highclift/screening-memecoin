// Static checks on public/: no user-visible string hard-coded, no key in one language only, and
// no script reaching for an element the markup does not have. Read as text, so no browser needed.

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
  // One row per agent, plus the badge humanize.js puts on a log line from one of the stages.
  ...["scout", "filter", "analyst", "executor", "risk", "logger"]
    .flatMap((bot) => [`bot.${bot}.name`, `bot.${bot}.task`, `bot.${bot}.badge`]),
  ...["running", "idle", "trading", "blocked", "starting", "stopped"].map((state) => `bot.state.${state}`),
  // The analyst's six score parts (DESK_WEIGHTS) and the older pump-score names.
  ...["momentum", "uniqueBuyers", "buySellRatio", "holderGrowth", "liqMcap", "smartWallets"].map((lead) => `lead.${lead}`),
  ...["surge", "buyPressure", "breadth", "depth"].map((lead) => `lead.${lead}`),
  ...["measure", "dip", "high", "bounce", "buyers", "spike", "data", "entry", "unknown"].map((state) => `waiting.${state}`),
  // Every kill category any agent can report: the scout's window (scout.js), the filter's hard
  // kills (filter.js + filters.js), the analyst's pass mark, and the risk agent's money limits.
  ...["too_young", "too_old", "mcap_low", "mcap_high",
    "market_cap", "liquidity", "liquidity_ratio", "dead", "dead_volume", "holders", "dev_history",
    "lp_unlocked", "dev_holding", "bundled", "pumped_already", "safety_pending", "below_score",
    "money_limit", "pass", "no_data", "holders_pending", "buyers_pending", "rugged",
    "few_buyers", "wash_trading", "distribution",
    "mint_authority", "freeze_authority", "fresh_wallets", "wallet_cluster", "linked_supply",
    "linked_wallets", "unknown"].map((c) => `reason.${c}`),
  // Bot 3's exit reasons (src/bots/executor.js).
  ...["stop-loss", "break-even", "trail", "trail-locked", "stall", "breakdown", "max-hold",
    "max-hold-total", "max-hold-stale", "manual", "exit"]
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
  for (const file of ["app.js", "bots-view.js", "funnel.js", "humanize.js", "anim.js", "nav.js"]) {
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

test("every element the dashboard scripts look up exists in the markup", () => {
  const html = read("index.html");
  const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  // Ids created by the scripts themselves rather than written in the markup.
  const madeAtRuntime = new Set(["funnelTiles", "funnelJudged", "funnelWatching", "funnelRugs", "funnelHolderCheck"]);

  const missing = [];
  for (const file of ["app.js", "bots-view.js", "funnel.js", "anim.js", "nav.js"]) {
    const source = read(file);
    for (const match of source.matchAll(/querySelector\(\s*"#([A-Za-z0-9_-]+)"/g)) {
      const id = match[1];
      if (!present.has(id) && !madeAtRuntime.has(id)) missing.push(`${file} -> #${id}`);
    }
    for (const match of source.matchAll(/\$\(\s*"#([A-Za-z0-9_-]+)"/g)) {
      const id = match[1];
      if (!present.has(id) && !madeAtRuntime.has(id)) missing.push(`${file} -> #${id}`);
    }
  }
  assert.deepEqual(missing, [], "these elements are gone from index.html but still queried");
});

test("no rule hard-codes a colour, so both themes actually switch", () => {
  const css = read("styles.css");
  // Everything above the first rule is the token block; colours may only be declared there.
  const offenders = [];
  let inTokens = false;
  css.split(/\r?\n/).forEach((line, index) => {
    if (/^:root/.test(line)) inTokens = true;
    else if (inTokens && /^}/.test(line)) inTokens = false;
    if (inTokens || /^\s*(\/\*|\*)/.test(line)) return;
    const hex = line.match(/#[0-9a-fA-F]{3,8}\b/);
    if (hex) offenders.push(`line ${index + 1}: ${hex[0]} — use a token`);
  });
  assert.deepEqual(offenders, []);
});

test("both themes define the same tokens", () => {
  const css = read("styles.css");
  const tokensIn = (selector) => {
    const start = css.indexOf(selector);
    assert.ok(start >= 0, `${selector} block is missing`);
    const block = css.slice(start, css.indexOf("\n}", start));
    return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  };
  const dark = tokensIn(':root[data-theme="dark"]');
  const light = tokensIn(':root[data-theme="light"]');
  // The light theme inherits the fonts from the default block; everything else must be redefined,
  // or a switch to light would leave dark values behind.
  const fonts = new Set(["--mono", "--sans", "--display"]);
  const missing = [...dark].filter((token) => !light.has(token) && !fonts.has(token));
  assert.deepEqual(missing, [], "tokens the light theme does not override");

  // Every token a rule uses must exist.
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]));
  const undefinedTokens = [...used].filter((token) => !dark.has(token));
  assert.deepEqual(undefinedTokens, [], "tokens used but never defined");
});

// ---------- appearance ----------
function themeTokens() {
  const css = read("styles.css");
  const block = (selector) => {
    const start = css.indexOf(selector);
    const text = css.slice(start, css.indexOf("\n}", start));
    return Object.fromEntries([...text.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
  };
  const dark = block(':root[data-theme="dark"]');
  return { dark, light: { ...dark, ...block(':root[data-theme="light"]') } };
}

function contrast(a, b) {
  const channel = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex) => {
    let h = hex.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("text stays readable in both themes", () => {
  // [foreground, background, what it is, minimum]. 4.5 for anything you read, 3 for labels and
  // chips, which are either larger or purely supporting.
  const PAIRS = [
    ["--text-1", "--bg", "heading on the page", 4.5],
    ["--text-1", "--surface-1", "heading on a panel", 4.5],
    ["--text-2", "--surface-1", "body on a panel", 4.5],
    ["--text-2", "--surface-2", "body on a row", 4.5],
    ["--text-3", "--surface-1", "label on a panel", 3],
    ["--text-3", "--surface-2", "label on a row", 3],
    ["--text-4", "--surface-1", "timestamp", 2.5],
    ["--good", "--surface-1", "running / profit text", 3],
    ["--good", "--good-bg", "lime chip", 3],
    ["--good-ink", "--good-fill", "text on the lime button", 4.5],
    ["--bad", "--surface-1", "loss text", 3],
    ["--bad", "--bad-bg", "error chip", 3],
    ["--warn", "--surface-1", "warning text", 3],
    ["--warn", "--warn-bg", "warning chip", 3],
    ["--info", "--surface-1", "info text", 3],
    ["--info", "--info-bg", "info chip", 3],
  ];
  const themes = themeTokens();
  const failures = [];
  for (const [name, tokens] of Object.entries(themes)) {
    for (const [fg, bg, label, min] of PAIRS) {
      const value = contrast(tokens[fg], tokens[bg]);
      if (value < min) failures.push(`${name}: ${label} is ${value.toFixed(2)}:1, want ${min}:1`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the dark theme separates layers by lightness, the light theme by shadow", () => {
  const { dark, light } = themeTokens();
  const luminance = (hex) => parseInt(hex.replace("#", "").slice(0, 2), 16);

  // Dark: each layer above the page is lighter than the one beneath it. That is the whole trick —
  // a shadow is invisible on a dark background.
  const steps = ["--bg", "--surface-1", "--surface-2", "--surface-3"].map((token) => luminance(dark[token]));
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i] > steps[i - 1], `dark surface ${i} is not lighter than the one below it`);
  }
  assert.equal(dark["--shadow-1"], "none", "shadows do nothing on a dark page");

  // Light: you cannot go lighter than white, so shadow does the separating instead.
  assert.equal(light["--surface-1"], "#ffffff");
  assert.notEqual(light["--shadow-1"], "none");
  assert.match(light["--shadow-2"], /px/);
});

test("the appearance toggle remembers the choice and follows the system when there is none", () => {
  // i18n.js is a classic script; run it against a minimal fake browser.
  const source = read("i18n.js");
  const run = ({ stored = null, systemLight = false } = {}) => {
    const store = new Map(stored ? [["launchpad.theme", stored]] : []);
    const root = { dataset: {} };
    const sandbox = {
      localStorage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
      },
      window: { matchMedia: (q) => ({ matches: systemLight && q.includes("light") }) },
      document: {
        documentElement: root,
        querySelectorAll: () => [],
      },
    };
    const factory = new Function("localStorage", "window", "document",
      `${source}\nreturn { theme, setTheme, onThemeChange };`);
    const api = factory(sandbox.localStorage, sandbox.window, sandbox.document);
    return { api, root, store };
  };

  // No stored choice, system is dark -> dark.
  let { api, root } = run();
  assert.equal(api.theme(), "dark");
  assert.equal(root.dataset.theme, "dark", "the attribute the CSS keys off is set on load");

  // No stored choice, system prefers light -> light.
  ({ api, root } = run({ systemLight: true }));
  assert.equal(api.theme(), "light");

  // A stored choice always wins over the system preference.
  ({ api, root } = run({ stored: "dark", systemLight: true }));
  assert.equal(api.theme(), "dark");

  // Switching applies the attribute, remembers it, and notifies listeners once.
  let notified = 0;
  ({ api, root } = run());
  api.onThemeChange(() => { notified += 1; });
  api.setTheme("light");
  assert.equal(api.theme(), "light");
  assert.equal(root.dataset.theme, "light");
  assert.equal(notified, 1);
  api.setTheme("light"); // already light: no work, no notification
  assert.equal(notified, 1);
  api.setTheme("sepia"); // not a theme
  assert.equal(api.theme(), "light");
});

test("the sidebar highlight follows the section you are looking at", () => {
  const { currentSectionIndex } = new Function(
    `${read("nav.js")}\nreturn { currentSectionIndex };`,
  )();
  // Four sections at these distances down the page, in a 900px window on a 4000px page.
  const tops = [0, 1200, 2200, 3100];
  const at = (scrollY, documentHeight = 4000) =>
    currentSectionIndex(tops, { scrollY, viewportHeight: 900, documentHeight });

  assert.equal(at(0), 0, "at the top, the first item");
  assert.equal(at(900), 0, "still the first: the second section has not reached the marker");
  assert.equal(at(1100), 1, "the second section is now under the top edge");
  assert.equal(at(2100), 2);
  assert.equal(at(3000), 3);
  assert.equal(at(3100), 3, "the bottom of the page keeps the last item");

  // The old bug: the highlight never moved off the first item.
  assert.notEqual(at(2100), at(0));

  // A page shorter than the window: the last section still gets its turn.
  assert.equal(currentSectionIndex([0, 100], { scrollY: 0, viewportHeight: 900, documentHeight: 800 }), 1);
  assert.equal(currentSectionIndex([], { scrollY: 0, viewportHeight: 900, documentHeight: 800 }), -1);
});

test("every sidebar link points at a section that exists and is not inside another one", () => {
  const html = read("index.html");
  const hrefs = [...html.matchAll(/class="nav-link[^"]*"\s+href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 3, `only found ${hrefs.length} nav links`);

  const positions = hrefs.map((id) => {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `#${id} is not in the markup`);
    return { id, at };
  });

  // Targets must appear in the markup in the same order as the links, so the highlight moves
  // downwards as you scroll rather than jumping about.
  const order = positions.map((p) => p.at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "nav links are not in page order");

  // No link may point inside another link's section, or both would highlight at once — which is
  // exactly what happened when the activity feed moved into the bots panel.
  const ids = positions.map((p) => p.id);
  assert.ok(!ids.includes("story"), "the log lives inside the bots panel now; it cannot be its own nav target");
  const botsAt = html.indexOf('id="bots"');
  const botsEnd = html.indexOf("</section>", botsAt);
  for (const { id, at } of positions) {
    if (id === "bots" || id === "overview") continue;
    assert.ok(at < botsAt || at > botsEnd, `#${id} sits inside the bots panel`);
  }
});

test("every dashboard POST goes through the helper that survives a non-JSON reply", () => {
  // A server running older code answers an unknown route with an HTML error page. Calling
  // response.json() on that throws "Unexpected token '<'", which tells nobody anything, so every
  // call site must use postJson instead of fetch directly.
  const app = read("app.js");
  const direct = [...app.matchAll(/await fetch\("(\/api\/[^"]+)"/g)].map((m) => m[1]);
  // /api/state is a GET on a timer and handles its own failure; the rest must go through postJson.
  assert.deepEqual(direct.filter((path) => path !== "/api/state"), []);
  assert.ok(app.includes("async function postJson"), "the helper is gone");
});

test("no dictionary key is left over from the three-lane design", () => {
  const stale = keys.id.filter((key) => key.startsWith("lane.") || key.startsWith("stage.") || key.startsWith("lanes."));
  assert.deepEqual(stale, [], "lane/stage keys belong to the removed design");
});
