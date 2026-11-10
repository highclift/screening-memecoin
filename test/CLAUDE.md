# screening-memecoin: paper trading bot for Solana memecoins

## Hard rules
- **Paper only.** Nothing signs or sends a transaction. Do not add live trading, wallet keys or swap
  code. If asked to, stop and confirm first (config rejects `MODE` other than `paper` on purpose).
- Never commit `.env` or `data/`. Never put API keys, RPC URLs or wallet addresses of the user in logs, the
  journals, the dashboard status, or error messages (the RPC URL can contain a provider key).
- Unknown data never rejects a coin (null = unknown, not 0). Scores use a neutral 0.5 for unknown;
  volume is the one exception (0.3), because a surge the bot cannot see must not be assumed.
- Never mix market-cap definitions for one coin. GeckoTerminal reports `market_cap_usd` falling back
  to FDV, DexScreener reports `marketCap` falling back to FDV, and for the same coin those differ by
  up to 10x. `src/universe.js` keeps one source per coin (DexScreener wins) and bumps
  `marketCapEpoch` when it changes so bot 3 re-measures instead of trading an imaginary crash.
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
  Nothing calls `fetchTokenMetadata` at the moment — socials arrive with the DexScreener snapshot.

## Commands
- `npm start`: dashboard + worker (`server.js` forks `src/index.js`), http://127.0.0.1:3000
- `npm run bot`: worker only. `npm test`: `node --test`, offline, ~3s. `npm run report`: per-bot stats
  from the three JSONL logs in `data/`.
- Node >= 22. Dependencies: express, ws, dotenv only. Run `npm test` before every commit.

## Architecture: three bots in a chain
Not three independent bots — three stages, each handing work to the next (see `PIPELINE.md`):

1. **`src/bots/screener.js` (bot 1)** — screens every coin at any age and logs it. Nothing here
   rejects a coin. Sources: PumpPortal websocket (launches/migrations), a round-robin sweep of 17
   GeckoTerminal pages (new/trending/top volume, weighted so page 1 comes round 4-5x per cycle),
   and a DexScreener rotation that re-checks EVERY coin in the registry (~2,700 coins/min, closest
   to a decision first — never drop a quiet coin, that is the one that wakes up). 65-140 new coins
   a minute measured live, every age band. `data/bot1-screened.jsonl`.
2. **`src/bots/filter.js` (bot 2)** — re-judges everything, forever: dev history → hard gates →
   pump score → holders (RPC). Age is never part of the decision, which is what lets a month-old
   coin go green the hour its volume wakes up. `data/bot2-filtered.jsonl`.
3. **`src/bots/executor.js` (bot 3)** — one paper account. Measures each coin's own volatility,
   derives dip/bounce/stop/trail/patience from it (`deriveLevels`), and refuses to buy a coin it has
   not measured. No strategy settings exist. **Flat stop + trailing take-profit, no profit target**:
   the trail is what ends a winning trade, `stall` only fires while the trade is NOT in profit, and
   `max-hold` counts from the last new high — all so a runner is never cut off. Once a trade has
   been up by `lockPct` the flat floor ratchets to break-even. `data/bot3-trades.jsonl`.

`src/index.js` is the wiring only: `onScreened -> filter.consider -> executor.watch/onData`, plus the
status it publishes to the dashboard every second. One process, so the three share one API budget.

- `src/universe.js`: the shared registry (one record per mint, rolling snapshots, bounded, pinned
  coins never evicted). Bot 1 writes, bots 2 and 3 read.
- `src/signals.js`: all the maths, pure and testable — `surgeRatio` (volume vs a normal hour for
  that coin), `turnover`, `pumpScore`, `volatilityPct`, `deriveLevels`, `roundTripCostPct`.
- `src/filters.js`: bot 2's hard gates. `src/feed.js`: the only place that talks to the network.
- `src/config.js` + `src/envutil.js`: money limits, API budgets, safety floors. New settings are
  env-only; the dashboard form is money limits and nothing else.
- `src/devbook.js`, `src/holders.js`, `src/social.js`, `src/journal.js`, `src/state.js`, `src/meter.js`.
- `public/` (vanilla JS, classic scripts, load order matters — see the `<script>` tags):
  `i18n.js` all UI strings + `t`/`tn` + locale formatters + `applyStaticText`; `anim.js`
  `setText`/`setNumber` (eased) / `markNew`; `humanize.js` turns raw log lines into plain sentences
  (`humanizeLog`) and provides the label helpers (`categoryLabel`, `leadText`, `waitingText`,
  `surgeText`, `fmtScore`); `bots-view.js` four compact bot rows (screening / filter / executor / storage) + the
  "what is happening now" headline; `funnel.js` bot 2's rejection reasons; `app.js` the fetch loop and the rest.
- `test/`: node:test suites, all offline. `PIPELINE.md`: how the three bots work. `.env.example`: all settings.

## Things that are easy to get wrong
- `writeVerdict` needs the *previous* verdict passed in; the record already holds the new one by then.
- Bot 3 must see the verdict from this pass, so `filter.consider` runs before `executor.onData` in
  `onScreened`.
- No stop may be tighter than a round trip costs (`roundTripCostPct`), or the trailing stop fires
  inside the spread and books a loss the price never made. Note the knock-on: `PAPER_FEE_BPS=100` +
  `PAPER_SLIPPAGE_BPS=200` is a 6% round trip, which forces every stop to 9% and biases the bot
  towards only the wildest coins. Realistic is nearer 25-30 bps fee and 50-100 bps slippage.
- Two entry triggers (`ENTRY_MODE`, default `both`): `dip-and-bounce` buys a retrace, `breakout`
  buys a new high. The pullback is about the PRICE PAID, not about coin safety — do not remove it
  because a safety filter was added elsewhere; they are unrelated. Every entry records its trigger
  so the report can compare them.
- Never add a fixed take-profit. It caps a winner exactly when it is working; the trail is the
  profit-taker. Same for cutting a profitable trade on a timer.
- `Number(null)` is 0, not NaN: use the null guards when formatting optional numbers.
- GeckoTerminal gives an individual IP far less than its documented 30 calls/min, and answers a
  BURST with 429 even when the average is legal. Calls are paced evenly by `createBudget`
  (minIntervalMs), the feed halves its rate on a 429 and creeps back up but never past a refused
  rate, and the result is remembered in `data/feed-state.json`. Settles at 4-7/min here. Never
  "fix" a 429 by raising the budget.
- A 0 for market cap, liquidity or price means "not reported" from both APIs; a 0 volume is real.

## Status
The three-bot rewrite replaced the old three-lane design (`fresh`/`young`/`veteran`, one balance
each), which screened different coins per lane and could never look at an old coin waking up.
88 unit tests pass. Verified against the live APIs: bot 1 screened 118 coins in 80s across every age
band (24 of them older than 30 days), bot 2 turned a real 52-day-old coin green at 6-10x its normal
hourly volume, and bot 3 entered and exited by itself with per-coin levels, including a profitable
`trail-locked` exit. The dashboard was driven end to end through `/api/state`. The CSS for the new card lists was added
by hand but never seen in a browser.

## Not verified yet
- The dashboard has not been opened in a browser since the rewrite (now four bot rows beside the
  log, per the user's mockup). The payload, the dictionary and
  the humanizer are covered by tests, but the DOM rendering has only been read, not seen. **Check
  this first**: the three bot cards, the `bot-detail-*` classes added to `styles.css` for the card
  lists, the new screener table columns, and the language switch.
- Whether the weights in `PUMP_WEIGHTS`, `GREEN_SCORE` and the multipliers in `deriveLevels` are any
  good. They are starting points. `npm run report` compares score buckets against outcomes.
- PumpPortal delivers few `create` events to an unauthenticated client (3-12 a minute observed),
  which seems low for Pump.fun; the dev book is only as good as those events.

## Known issues not fixed yet
- Stop button on Windows: `kill("SIGTERM")` ends the worker abruptly so `shutdown()` never runs. Use an IPC
  shutdown message first, force-kill after a timeout.
- Positions with no fresh price for a minute close at the last known price (`max-hold-stale`): flatters results.
- An open position whose market-cap source changes mid-hold is not re-anchored (rare: a watched coin
  is already on DexScreener numbers before bot 3 enters).
- `/api/state` reads the whole paper state file synchronously every second.
- README is out of date (it still describes the lanes, thresholds and the social filter).
- Money-limit defaults are duplicated in `server.js` and `src/config.js`; the server ignores the
  worker's `settings-applied` / `settings-error` messages.
- `server.js` emits Indonesian prose in logs and API errors, and `src/config.js` throws English
  validation messages. The dashboard shows these raw, under "Technical details".
- Not yet built: position sizing as % of equity; mint/freeze-authority check.
