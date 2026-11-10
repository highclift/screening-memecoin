# screening-memecoin: paper trading bot for Solana memecoins

## Hard rules
- **Paper only.** Nothing signs or sends a transaction. Do not add live trading, wallet keys or swap
  code. If asked to, stop and confirm first (config rejects `MODE` other than `paper` on purpose).
- Never commit `.env` or `data/`. Never put API keys, RPC URLs or wallet addresses of the user in logs, the
  journal, the dashboard status, or error messages (the RPC URL can contain a provider key).
- Unknown data never rejects a token (null = unknown, not 0). Scores use a neutral 0.5 for unknown.
- Dashboard JS must use `textContent` / DOM APIs, never `innerHTML` with token names (they are untrusted).
  The one `innerHTML` path is `data-i18n-html` in `public/i18n.js`, which only ever renders dictionary
  strings. Never route token names, log text or API errors through it.
- No user-visible string is hard-coded in `public/`: add a key to both `id` and `en` in
  `public/i18n.js` and render it with `t()` (or `tn()` when a count needs singular/plural).
- Token metadata URIs come from untrusted creators: only fetch allowlisted hosts (see `src/social.js`).

## Commands
- `npm start`: dashboard + worker (`server.js` forks `src/index.js`), http://127.0.0.1:3000
- `npm run bot`: worker only. `npm test`: `node --test`, offline, ~1s. `npm run report`: per-lane stats
  from `data/journal.jsonl`.
- Node >= 22. Dependencies: express, ws, dotenv only. Run `npm test` before every commit.

## Layout
- `server.js`: local dashboard API (binds 127.0.0.1, Host/Origin checks), starts/stops the worker.
- `src/index.js`: the worker. Lanes, candidates, discovery, polling, paper accounts, status publishing.
- `src/lanes.js`: lane definitions, age bands, defaults, `<LANE>_<NAME>` env overrides.
- `src/config.js` + `src/envutil.js`: env parsing/validation. New settings are env-only unless told otherwise.
- `src/strategy.js`: price unit, `updateLevels` (pullback then rebound), `shouldEnter`, exits.
- `src/filters.js`, `src/analyst.js`, `src/devbook.js`, `src/holders.js`: pipeline gates and 0-1 score.
- `src/discovery.js`: GeckoTerminal pool discovery for young/veteran lanes + shared call budget.
- `src/pricefeed.js`: DexScreener polling (30 mints/request), GeckoTerminal buyers. `src/social.js`: links + SSRF guard.
- `src/journal.js`: JSONL decision log. `src/state.js`, `src/lanestate.js`: persisted paper accounts.
- `public/` (vanilla JS, classic scripts, load order matters — see the `<script>` tags):
  `i18n.js` all UI strings + `t`/`tn` + locale formatters + `applyStaticText` (`data-i18n` attributes);
  `anim.js` `setText`/`setNumber` (eased) / `markNew`, all reduced-motion aware; `humanize.js` turns raw
  log lines into plain sentences (`humanizeLog`) and stage keys into sentences (`humanizeStage`);
  `lanes-view.js` per-lane cards + the "what is happening now" headline; `funnel.js` drop-out reasons;
  `app.js` fetch loop and the rest of the rendering; `index.html`, `styles.css`.
- `test/`: node:test suites. `PIPELINE.md`: how the pipeline and lanes work. `.env.example`: all settings.

## Concepts
- **Lanes** = independent paper bots with their own balance/thresholds: `fresh` (PumpPortal migration events,
  account in `data/paper-state.json`, shown by the current dashboard), `young` (pools 1-24h old) and
  `veteran` (1-30 days), found via GeckoTerminal trending/top pools, accounts in `data/lanes-state.json`.
- "Price" in the bot is market cap in SOL. Fresh assumes the 1B Pump.fun supply; age lanes use the market
  cap DexScreener reports. Never mix the two definitions for one token (skip the update instead).
- Entry = pullback from peak, then bounce off the post-pullback low, then filters (dev history, liquidity,
  volume, holders via optional `SOLANA_RPC_URL`), then analyst score >= `MIN_SCORE`.
- All GeckoTerminal calls must go through `geckoBudget` (free tier: 30 calls/min, we use 24).
- Every journal record carries `lane`. The screener status sent to the dashboard has a `lanes` block.

## Status
Done: rebound/price-unit bug fixes, SSRF guard, filter + analyst pipeline, journal, funnel panel, lanes
with older-coin discovery, per-lane report, and the beginner-friendly UI (plain-language feed with a
"Technical details" toggle holding the raw log, per-lane cards, jargon tooltips, eased numbers + a
one-time slide-in for new feed lines, English/Indonesian switch remembered in `localStorage`, default
Indonesian). 51 unit tests pass; an end-to-end run with mocked APIs passed.

The worker publishes two things purely so the UI can translate instead of echoing prose: `stageKey` per
candidate (the stable gate id behind the `stage` text) and `thresholds` per lane in `status.lanes`.
Keep both when touching `publishScreenerStatus` / `laneSummary`.

## FIRST: verify against live APIs (could not be tested offline)
Run the bot for a while with `LANES=young,veteran` and check `data/journal.jsonl` / logs:
1. GeckoTerminal pool fields really match `parseGeckoPool` (`transactions.h1.buyers`, `market_cap_usd`,
   `reserve_in_usd`, `pool_created_at`, relationships `base_token`/`quote_token` ids like `solana_<mint>`).
2. DexScreener pairs include `marketCap`/`fdv` and `pairCreatedAt` (age lanes skip updates without a market cap).
3. PumpPortal `create` events carry the creator wallet as `traderPublicKey` (devbook relies on it). If
   "Dev tanpa data" stays ~100%, this is wrong.
4. Top-pools endpoint ordering (we call `/pools?page=N` with no sort param). Adjust if results are not useful.

## NEXT TASK: check the UI against a live run
The UI was verified offline (dictionary parity, the humanizer against every log template, and the render
functions driven by a stubbed `/api/state`), but not yet in a browser against real data. Run
`npm start` with `LANES=young,veteran` and check:
1. Every feed line arrives as a plain sentence. Any line still only visible under "Technical details"
   needs a matcher in `public/humanize.js` and a key in `public/i18n.js` (`humanizeLog` returns `null`
   for unmatched lines on purpose, so nothing is lost — it just is not translated yet).
2. The lane cards show real balances and the "most are waiting on" line names a believable gate.
3. The language switch leaves nothing in the other language, including the watchlist and the feed.

## Known issues not fixed yet
- Stop button on Windows: `kill("SIGTERM")` ends the worker abruptly so `shutdown()` never runs. Use an IPC
  shutdown message first, force-kill after a timeout.
- Positions with no fresh price close at the last known price (`max-hold-stale`): flatters results.
- TP/SL are measured on net proceeds: with 1% fee + 2% slippage per side that is about +16.8% / -9.7% in price.
- `/api/state` reads the whole paper state file synchronously every second.
- README is out of date (thresholds, trenchly.gg links, free mode default, social filter, lanes).
- Defaults are duplicated in `server.js` and `src/config.js`; the server ignores the worker's
  `settings-applied` / `settings-error` messages.
- `server.js` still emits Indonesian prose (log lines and API error strings), and `src/config.js` mixes
  Indonesian/French/English in validation errors. The dashboard only shows these raw, under "Technical
  details" or appended to a translated message. Making them codes the UI can translate is the next
  clean-up if the English UI matters.
- Not yet built: position sizing as % of equity; mint/freeze-authority check; Raydium launch scouting.