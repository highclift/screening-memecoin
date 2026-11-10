# Screening pipeline

Paper trading only. Nothing here signs or sends a transaction.

```
Scout  -> migration / launch events from PumpPortal
Filter -> market cap -> dev history -> social links -> liquidity -> holders   (cheap checks first)
Analyst-> weighted 0-1 score, entry needs score >= MIN_SCORE
Entry  -> pullback from peak, then a bounce off the post-pullback low (src/strategy.js)
Exit   -> take-profit / stop-loss / max-hold (net of simulated fees and slippage)
```

Expensive or rate-limited lookups (holders RPC) only run for a token that already has an entry
signal, so they are never spent on tokens that would not be bought anyway.

## Where to see what happened

- **Dashboard -> "Mengapa token gugur"**: counts per rejection reason, and which gate expired
  candidates were stuck on (e.g. "Habis waktu: trade kurang").
- **`data/journal.jsonl`** (rotates at 5 MB to `journal.jsonl.1`): one JSON line per decision.
  `reject` (with `category` and `detail`), `score_block`, `holders`, `entry` (with the score and its
  per-feature `parts`), `exit`, `rug`.

## Tuning from evidence

The thresholds and score weights are hand-picked starting points, not validated. After a few
hundred journaled paper trades, compare the `parts` of winning and losing entries (`entry` lines
joined with their `exit` lines by `mint`) and adjust `WEIGHTS` in `src/analyst.js` or `MIN_SCORE`.
If one `expired:<stage>` dominates the funnel, that gate is the one to look at first.

## Known limits

- **Dev history** only covers creators whose launch this bot saw while running; others count as
  "Dev tanpa data" and score a neutral 0.5. Coverage grows with uptime. A "rug" is a token that
  fell `RUG_DROP_PCT` from its observed peak during the screening window, a coarse signal.
- **Holders** need `SOLANA_RPC_URL`. Skipping the largest account is a heuristic for the AMM pool
  vault; a real whale can be the largest account. `largestPct` is journaled so you can check.
- **Liquidity** comes from DexScreener (free mode). When it is not reported, the filter does not
  reject (unknown never rejects) and the score uses a neutral value.
- **Social links** only prove a link was filled in, not that the account is real.
- Paper results ignore latency, failed sells and rugs you cannot exit, so they flatter reality.
