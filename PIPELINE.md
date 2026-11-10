# Screening pipeline

Paper trading only. Nothing here signs or sends a transaction.

## Lanes: more than one bot

A **lane** is an independent paper bot with its own discovery source, thresholds and paper balance.
All lanes share the same filter, analyst and journal code.

| Lane | Coin age | How it finds coins | Account file |
|---|---|---|---|
| Fresh | just migrated | PumpPortal migration events | `data/paper-state.json` (what the dashboard shows today) |
| Young | 1 hour .. 24 hours | GeckoTerminal trending / top pools | `data/lanes-state.json` |
| Veteran | 1 day .. 30 days | GeckoTerminal trending / top pools | `data/lanes-state.json` |

Switch lanes with `LANES=fresh,young,veteran`. Young and veteran need `TRADE_SOURCE=free`. Each lane's
thresholds can be overridden with `<LANE>_<NAME>` variables (see `.env.example`). Separate balances let you
compare the lanes fairly: run `npm run report` for a per-lane breakdown.

### Why older coins were invisible before

The bot used to learn about a token only when PumpPortal announced its migration. A coin that migrated an
hour or a month ago never fires that event again. Young and veteran lanes use a second source instead:
GeckoTerminal lists trending and top pools with their creation time, liquidity, volume and 1h unique
buyers. Each discovery tick makes ONE call and works through a rotating list of pages, so a full sweep takes
about two minutes. All GeckoTerminal calls (discovery, refresh, fresh-lane buyer checks) share one budget
(`GECKO_CALLS_PER_MINUTE`, default 24 of the free tier's 30).

Limits of discovery: it sees what GeckoTerminal ranks (trending, top by volume, first 5 pages), not every
token that exists, and pools with no trading never show up. A pool only qualifies if its quote token is SOL
and its base is not SOL/USDC/USDT.

### What differs per lane

- **Activity window**: fresh counts the last 5 minutes (DexScreener `m5`); young and veteran count the last
  hour (`h1`), and unique buyers come from GeckoTerminal's 1h buyer count.
- **Market cap**: fresh assumes the 1B Pump.fun supply. Older tokens can have any supply, so young and
  veteran use the market cap DexScreener reports (falling back to FDV). If neither is reported the update is
  skipped rather than mixing two definitions (the candidate shows "Menunggu data market cap").
- **Extra gate**: 1h volume floor (`<LANE>_MIN_VOLUME_H1_USD`).
- **Polling**: young polls every 6s, veteran every 10s (fresh every 3s), so API calls stay low.
- **Cooldown**: a pool already looked at (even if rejected) is not reconsidered for 30 min (young) / 2 h
  (veteran), so the same listing is not re-counted every cycle.

The young and veteran defaults are guesses. Nothing here shows that either lane has an edge.

## Pipeline per candidate

```
Discover -> market cap / liquidity / volume (cheap pre-filters from the listing)
Filter   -> dev history -> social links -> liquidity -> volume -> holders        (cheap checks first)
Analyst  -> weighted 0-1 score, entry needs score >= <lane> MIN_SCORE
Entry    -> pullback from peak, then a bounce off the post-pullback low (src/strategy.js)
Exit     -> take-profit / stop-loss / max-hold (net of simulated fees and slippage)
```

Expensive or rate-limited lookups (holders RPC) only run for a token that already has an entry signal.

## Where to see what happened

- **`npm run report`**: per lane: entries, win rate, PnL, exits by reason, whether the score separates
  winners from losers, and why tokens dropped out.
- **`data/journal.jsonl`** (rotates at 5 MB): one JSON line per decision, each tagged with its `lane`:
  `reject` (with `category` and `detail`), `score_block`, `holders`, `entry` (score and per-feature `parts`,
  token age), `exit`, `rug`.
- **Dashboard**: the screener status now carries a `lanes` block (balance, open positions, wins/losses,
  funnel per lane). The current dashboard shows the Fresh account; a per-lane view is the next UI step.

## Resetting

The dashboard's reset button only resets the Fresh account. To reset young/veteran, stop the bot and delete
`data/lanes-state.json`.

## Tuning from evidence

The thresholds and score weights are hand-picked starting points, not validated. After a few hundred
journaled paper trades per lane, compare winners and losers (`npm run report`) and adjust the lane's
variables, `MIN_SCORE`, or `WEIGHTS` in `src/analyst.js`. If one `expired:<stage>` dominates a lane's funnel,
that gate is the one to look at first.

## Known limits

- **Dev history** only covers creators whose launch this bot saw while running; older tokens are almost always
  "unknown" (neutral 0.5 in the score). The holder check (`SOLANA_RPC_URL`) is the main safety signal for them.
- **Holders** need `SOLANA_RPC_URL`. Skipping the largest account is a heuristic for the AMM pool vault.
- **GeckoTerminal fields** (`transactions.h1.buyers`, `market_cap_usd`, ...) are parsed defensively from the
  documented format; unknown values never reject. If it changes, lanes degrade to waiting and expiring.
- **Social links** only prove a link was filled in, not that the account is real.
- Paper results ignore latency, failed sells and rugs you cannot exit, so they flatter reality.
