# screening-memecoin: paper trading desk for Solana memecoins

## Hard rules
- **Paper only.** Nothing signs or sends a transaction. Do not add live trading, wallet keys or swap
  code. If asked to, stop and confirm first (config rejects `MODE` other than `paper` on purpose).
- Never commit `.env` or `data/`. Never put API keys, RPC URLs or wallet addresses of the user in logs, the
  journals, the dashboard status, or error messages (the RPC URL can contain a provider key).
- **Unknown data never kills a coin, and never passes one either.** null = unknown, not 0. Score
  parts use a neutral 0.5 for unknown. A safety check that could not be made leaves the coin in
  `wait` (`safety_pending`), which is NOT `pass` — this distinction is the filter's whole value.
- Never mix market-cap definitions for one coin. GeckoTerminal reports `market_cap_usd` falling back
  to FDV, DexScreener reports `marketCap` falling back to FDV, and for the same coin those differ by
  up to 10x. `src/universe.js` keeps one source per coin (DexScreener wins) and bumps
  `marketCapEpoch` when it changes so the executor re-measures instead of trading an imaginary crash.
- Dashboard JS must use `textContent` / DOM APIs, never `innerHTML` with coin names (they are untrusted).
  The one `innerHTML` path is `data-i18n-html` in `public/i18n.js`, which only ever renders dictionary
  strings. Never route coin names, log text or API errors through it.
- No raw colour in `styles.css` outside the two `:root` token blocks, and every token the dark
  theme defines must be redefined by the light one. Elevation differs by theme on purpose: dark
  raises a surface by making it LIGHTER (--surface-1/2/3 climb), light keeps everything white and
  raises it with --shadow-1/2. --good is lime TEXT, --good-fill is the lime BUTTON FILL (on white
  they must differ, or the text is unreadable). test/i18n.test.js checks contrast in both themes.
- No user-visible string is hard-coded in `public/`: add a key to both `id` and `en` in
  `public/i18n.js` and render it with `t()` (or `tn()` when a count needs singular/plural).
  `test/i18n.test.js` enforces parity and that every key referenced actually exists.
- Coin metadata URIs come from untrusted creators: only fetch allowlisted hosts (see `src/social.js`).

## Commands
- `npm start`: dashboard + worker (`server.js` forks `src/index.js`), http://127.0.0.1:3000
- `npm run bot`: worker only. `npm test`: `node --test`, offline, ~4s. `npm run report`: the funnel
  (kills by agent) and the trade outcomes, from the three JSONL logs in `data/`.
- Node >= 22. Dependencies: express, ws, dotenv only. Run `npm test` before every commit.

## Architecture: six agents, hard handoffs
Not six independent bots — six stages, each handing work to the next (see `PIPELINE.md`). A coin
that fails a stage is never seen by the next one.

1. **`src/agents/scout.js`** — finds coins; passes on only what is inside the window (30m–72h old,
   $300k–$20M). Everything else stays in the registry and is still refreshed, because it can walk
   into the window later. Sources: PumpPortal websocket, a round-robin sweep of 17 GeckoTerminal
   pages, and a DexScreener rotation over EVERY known coin (~2,700/min). `data/scout.jsonl`.
2. **`src/agents/filter.js`** — hard kills only: mint/freeze authority, LP burned or locked,
   liquidity, dev holding, bundled/insider wallets, already +80% in 1h, plus the three wallet-count
   gates in `src/filters.js`. Order is local → RugCheck → holder graph (RPC).
3. **`src/agents/analyst.js`** — `deskScore` out of 100 from six parts; only `PASS_SCORE` (70) and
   above goes on. Also samples pool buyers for the smart-wallet registry.
4. **`src/agents/executor.js`** — the only agent that touches a position. Measures each coin's own
   volatility first and refuses to buy one it has not measured. Two triggers (`ENTRY_MODE`).
5. **`src/agents/risk.js`** — owns the money: size (`POSITION_PCT`, 8% of the CURRENT balance), the
   permission to trade at all, the flat -6% stop fixed before entry, and the trail that arms at
   +12%. Every refusal is a logged kill.
6. **`src/agents/logger.js`** — every agent reports here. `data/kills.jsonl` holds every refusal
   with its reason and the agent that made it; `data/trades.jsonl` holds entries and exits.

`src/index.js` is the wiring only, plus the status it publishes to the dashboard every second.
One process, so all six share one API budget.

- `src/universe.js`: the shared registry (one record per mint, rolling snapshots, bounded, pinned
  coins never evicted). The scout writes, everyone else reads.
- `src/signals.js`: all the maths, pure and testable — `deskScore` + `DESK_WEIGHTS`,
  `holderGrowthPerHour`, `volatilityPct`, `roundTripCostPct`, and the older `pumpScore` helpers.
- `src/rugcheck.js`: api.rugcheck.xyz client (free, no key, 15/min). LP locked %, creator holding,
  insider networks, holder count. `parseReport` is pure and tested against the real response shape.
- `src/smartwallets.js`: the locally learned wallet registry (sample → settle → score).
- `src/filters.js`: the wallet-count gates. `src/feed.js`: the only place that talks to the network.
- `src/config.js` + `src/envutil.js`: the window, the kill list, the trade shape, API budgets. New
  settings are env-only; the dashboard form is money limits and nothing else.
- `src/devbook.js`, `src/holders.js`, `src/social.js`, `src/journal.js`, `src/state.js`, `src/meter.js`.
- `public/` (vanilla JS, classic scripts, load order matters): `i18n.js` all UI strings + `t`/`tn`;
  `anim.js` `setText`/`setNumber`; `humanize.js` turns raw log lines into plain sentences — **its
  regexes match the exact log strings the agents print, so changing a log line breaks it** (there is
  a test listing every line the agents produce); `bots-view.js` six agent rows; `funnel.js` the kill
  reasons; `app.js` the fetch loop.
- `test/`: node:test suites, all offline. `PIPELINE.md`: how the six agents work. `.env.example`: all settings.

## Things that are easy to get wrong
- **A coin the executor holds must skip the scout's window check.** A position that collapses falls
  straight out of the market-cap band; if that stopped the data reaching the executor, the stop
  would never fire and the rug would be held to the time limit. The window says what the desk may
  START trading, not what it may keep watching. (A test covers this; it was a real bug.)
- The filter's RugCheck answer arrives on a LATER turn (it is a call). In tests you must let the
  promise settle and then re-judge past `RESCORE_INTERVAL_MS` — see `admit()` in chain.test.js.
  In production the re-judge loop does this for free.
- `maxSupportedTransactionVersion` must cover the versions in use (currently 1). Asking for 0 does
  not downgrade the answer, the RPC REFUSES it — which silently emptied the whole funding graph.
- Holder rules must be weighted by SUPPLY, not by count. Counting fresh holders rejected 6 of 6
  live coins (a young coin is held by young wallets). Same for clusters: what matters is what the
  group can dump.
- `lpLockedPct` comes from the DEEPEST pool, not an average: a coin trades in several pools whose
  numbers disagree wildly, and the one that matters is the one you would sell into.
- The dashboard server does NOT reload code. A new /api route does not exist until it is restarted,
  which is why every dashboard POST goes through `postJson` and unknown /api paths return JSON.
- **Test runs share the live `data/` directory.** The worker resolves `data/` from its cwd. To smoke
  test without touching the user's paper account, run `node <abs path>/src/index.js` from a scratch
  directory — the journals and state then land there. Note that `server.js` forks the worker with
  `cwd: ROOT`, so starting the DASHBOARD from a scratch directory does **not** isolate it: its
  worker still writes to the project's `data/`.
- **`src/index.js` only starts a desk when it is the program being run** (`isMain`). Keep it that
  way. It used to start on import, so anything that imported it — a test, a tooling script, an
  `import()` in a one-liner — launched a second full desk against the same `data/`. Two desks
  persisting the same paper account every 15s makes the dashboard flip between two different
  balances every few seconds, which reads as a UI bug and is nearly impossible to trace from there.
  If you ever see numbers oscillating, count the node processes before debugging the dashboard.
- A rug is not a stop-loss problem. In a measured session 5 coins went from above their stop to
  near zero between two polls and cost 74% of all losses. Tightening the stop does nothing for
  that — only not holding the coin does, which is what the filter is for.
- No stop may be tighter than a round trip costs (`roundTripCostPct`), or the trailing stop fires
  inside the spread and books a loss the price never made. `PAPER_FEE_BPS=100` +
  `PAPER_SLIPPAGE_BPS=200` is a 6% round trip, which is far above reality (25-30 bps fee, 50-100
  bps slippage) and biases everything towards only the wildest coins.
- `TRAIL_AFTER_PCT` must exceed `STOP_PCT` or the stop could never fire first; config throws.
- Never add a fixed take-profit. It caps a winner exactly when it is working.
- `Number(null)` is 0, not NaN: use the null guards when formatting optional numbers.
- GeckoTerminal gives an individual IP far less than its documented 30 calls/min, and answers a
  BURST with 429 even when the average is legal. Calls are paced evenly by `createBudget`, the feed
  halves its rate on a 429 and creeps back up but never past a refused rate, remembered in
  `data/feed-state.json`. Settles at 4-7/min here. Never "fix" a 429 by raising the budget.
- A 0 for market cap, liquidity or price means "not reported" from both APIs; a 0 volume is real.

## Status
The six-agent desk replaced the three-bot chain (screener/filter/executor). 99 unit tests pass.
Verified live for 100 seconds against the real APIs: the scout turned away 58 coins on the window
(37 too young, 12 too old, 9 outside the size band), the filter passed 2 and killed one with
`bundled — 24 linked wallets across 6 networks hold 13.1% between them`, and the analyst scored
both survivors and refused them (38 and 47, under the pass mark of 70) with the six parts logged.

The three-bot version's measured result is the baseline to beat: **180 trades, 27% win rate,
-6.41 SOL**, and its 0.80+ score bucket had the WORST total PnL of any bucket. Treat any score,
including `deskScore`, as decoration until `npm run report` shows it separating winners from losers.

## Not verified yet
- **The dashboard has not been opened in a browser since the rewrite.** The payload, the dictionary
  and the humanizer are covered by tests, but the six agent rows, the kill-funnel panel and the
  `positionPct` form field (shown as %, stored as a fraction via `data-scale`) have only been read,
  not seen. **Check this first.**
- No trade has been taken end to end against live data by the new desk — the 100-second run never
  got a coin past the analyst. Entry, stop and trail are covered by unit tests only.
- Whether `DESK_WEIGHTS`, `PASS_SCORE`, the window and the -6%/+12% shape are any good.
- The smart-wallet registry has never settled a real sample (needs 30+ minutes of uptime).
- PumpPortal delivers few `create` events to an unauthenticated client, so the dev book is thin.

## Known issues not fixed yet
- Stop button on Windows: `kill("SIGTERM")` ends the worker abruptly so `shutdown()` never runs. Use an IPC
  shutdown message first, force-kill after a timeout.
- Positions with no fresh price for a minute close at the last known price (`max-hold-stale`): flatters results.
- `/api/state` reads the whole paper state file synchronously every second.
- README is out of date (it describes the old lanes and thresholds).
- Money-limit defaults are duplicated in `server.js` and `src/config.js`; the server ignores the
  worker's `settings-applied` / `settings-error` messages.
- `server.js` emits Indonesian prose in logs and API errors, and `src/config.js` throws English
  validation messages. The dashboard shows these raw, under "Technical details".
- `.env.example` contains a real-looking Helius API key that should be rotated.
