# The three bots

Paper trading only. Nothing here signs or sends a transaction.

Three bots in a chain. Each one only talks to the next:

```
BOT 1  screening   every coin, any age          ->  data/bot1-screened.jsonl
BOT 2  filter      can it pump, or pump again?  ->  data/bot2-filtered.jsonl
BOT 3  execution   when to buy, when to sell    ->  data/bot3-trades.jsonl
```

They run in one process (`npm run bot`, or `npm start` for the dashboard too) because they share one
API budget and one copy of the market data. The handoff is one function call per stage, wired in
`src/index.js`: `onScreened -> filter.consider -> executor.watch -> executor.onData`.

## Bot 1 — screening (`src/bots/screener.js`)

Sees coins and writes down what it saw. It has no opinion about any of them, so **nothing here
rejects a coin**; the only thing it skips is a pool that is not a memecoin against SOL.

| Source | What it brings | Rate |
|---|---|---|
| PumpPortal websocket | brand-new launches and AMM migrations, pushed | free, no key |
| GeckoTerminal sweep | 17 pages of new / trending / top-volume pools, round-robin | self-tuned, see below |
| DexScreener refresh | market cap, liquidity, volume, buys/sells, socials | 30 coins per call, every 2s |

**The GeckoTerminal rate is found, not assumed.** Its documentation says 30 calls a minute; an
individual IP gets considerably less, and it answers a *burst* with 429 even when the average is
legal. So the calls are paced evenly (never bunched), and the feed halves its own rate whenever it
is refused, creeping back up one call a minute at a time but never past a rate that was refused
before. The rate it settles on is written to `data/feed-state.json`, so a restart starts there
instead of being refused all over again. On the machine this was built on it settles at 4-7 a
minute; `GECKO_CALLS_PER_MINUTE` is only the ceiling.

Because that rate is low, the page rotation is weighted: page 1 of new, trending and top come round
four or five times per cycle, the deeper pages once (`buildRotation` in `src/discovery.js`). A coin
waking up shows on the first pages, so those are the ones worth revisiting.

Measured live: about 90-140 coins a minute seen for the first time, spread across every age band
(in one 80-second sample: 52 under an hour old, 77 hours old, 24 days old, 17 older than a month).
While GeckoTerminal is paused, DexScreener and the launch feed carry on, so the coins already being
watched never go stale.

**How a month-old coin gets screened again.** Two ways, and the first is the one that matters: once
bot 1 has met a coin it stays in the DexScreener rotation below forever, so its numbers are
refreshed every minute or so whatever it is doing. Separately, when it wakes up its volume carries
it back onto the trending and top-volume pages, so the sweep finds it again even if it had been
evicted from the registry. Either way bot 2 is free to turn it green today after calling it red for
weeks.

**Every coin in the registry is re-checked on a rotation**, ordered by who is closest to a decision:
bot 3's open positions and watchlist first, then bot 2's green and watched coins, then everyone
else, least recently refreshed first. Nobody is ever dropped for being quiet — a coin that went
quiet is precisely the coin that might wake up, and waiting for GeckoTerminal's rate-limited
trending page to re-surface it would be the slow way to find out.

That rotation is the main reason the "pump again" case works, and it is nearly free: one DexScreener
call covers 30 coins, and a measured probe answered 133 calls a minute (~4,000 coins) without a
single 429. The default of 3 calls every 2 seconds is ~2,700 coins a minute, so a registry of a few
thousand coins is fully re-checked every minute or so. Bot 1 reports that interval as
`recheckSeconds`, and the dashboard shows it on bot 1's card.

Every coin is logged the first time it is seen and then at most once a minute, so a few hundred
coins a minute stays readable (`data/bot1-screened.jsonl`, rotates at 20 MB).

## Bot 2 — filter (`src/bots/filter.js`)

Answers one question about every coin bot 1 screened: can this pump, or pump *again*? It never
answers it once — each coin is re-judged every `RESCORE_INTERVAL_MS` (15s) for as long as bot 1
keeps seeing it. **Nothing about a coin's age is part of the decision.**

Cheapest first, so the one expensive lookup is only spent on coins that already look good:

```
dev history (local)  ->  hard gates (local)  ->  pump score (local)  ->  holders (RPC)
```

**Hard gates** (`src/filters.js`) are safety, not strategy: a coin that fails one cannot be
paper-traded honestly at all, so no score can rescue it. Missing data is a `no_data` wait, never a
rejection — which is how a quiet coin stays in the registry until the hour it wakes up.

**Pump score** (`src/signals.js`), 0..1, every part measured against the coin itself:

| Signal | Weight | What it measures |
|---|---|---|
| `surge` | 0.30 | this hour's volume against a normal hour *for this coin* — the re-pump trigger |
| `buyPressure` | 0.20 | share of the hour's trades that were buys |
| `breadth` | 0.20 | how many different wallets are buying (one whale is not a pump) |
| `momentum` | 0.15 | 1h price change, or the climb off the lowest point this bot measured |
| `depth` | 0.15 | liquidity against market cap |

A coin younger than a couple of hours has no "normal hour" to compare against, so `surge` falls
back to turnover (volume against the pool's own size) and the logs say which of the two was used.
Unknown data scores a neutral 0.5, never 0 — except volume, which leans low at 0.3, because a surge
the bot cannot see is not a surge it may assume.

Verdicts: **green** at `GREEN_SCORE` (0.58) and above → handed to bot 3; **watch** from
`WATCH_SCORE` (0.40) → kept and re-judged; **red** below that, or on any hard gate. A green coin
that stops pumping loses green on the next pass and bot 3 drops it (unless it is already holding).

Every state change is logged; a coin that keeps getting the same answer is logged at most every five
minutes (`data/bot2-filtered.jsonl`).

## Bot 3 — execution (`src/bots/executor.js`)

Decides *when*. It has no strategy settings, deliberately: every level comes from the coin in front
of it.

1. It watches a green coin until it has measured how much that coin moves in a minute
   (`volatilityPct`, needs 5 samples over at least 30 seconds). **It will not buy a coin it has not
   measured** — without that there is no stop distance that means anything.
2. From that one number (`deriveLevels`): a pullback worth 1.2× it is "a dip", a 0.6× recovery off
   the low is "buyers are back", 2.5× below entry is the flat stop, and 2× under the peak is the
   trailing stop.
3. Two ways in (`ENTRY_MODE`, default `both`):
   - **`dip-and-bounce`** — the coin pulls back and buyers come back. The better price.
   - **`breakout`** — the coin pushes to a new high without ever pulling back. A steady climber
     never dips, and waiting for a pullback that never comes means watching the move go past.

   Both carry the same two fill guards: buy pressure must not have flipped below 50%, and a
   vertical candle (a step over 3× the coin's own volatility) waits for the next measurement
   rather than buying the spike. Those guards decide the *price paid*; judging whether the coin
   is worth buying at all is bot 2's job, and no safety filter there replaces them. Each entry
   records which trigger fired, so `npm run report` can show which one earns.

**A flat stop and a trailing take-profit — there is no profit target.** A fixed target sells a
winner at exactly the moment it is working, so nothing here does that. What ends a winning trade is
the trail:

| Exit | When |
|---|---|
| `stop-loss` | price falls `stopPct` below entry. Flat: this level never moves down |
| `break-even` | the trade was once up by `lockPct`, then came back to entry + costs. A winner is not allowed to become a loss |
| `trail` | price falls `trailPct` under the highest point since entry |
| `trail-locked` | same, but after a `lockPct` run the trail tightens to 1.5× the coin's own move (not 1×, which would stop a runner out on an ordinary wiggle) |
| `breakdown` | buy share collapses under 35% while the trade is under water |
| `stall` | no new high for `stallMs` — **only while the trade is not in profit**. A profitable trade that pauses is left to the trail |
| `max-hold` | 45 minutes with no new high. Measured from the last high, not from entry, so a coin still climbing is never cut off |
| `max-hold-total` | 4 hours, the one absolute ceiling |

A position with no fresh price for a minute closes at the last known price rather than staying open
forever (`max-hold-stale`).

So a coin that swings 10% a minute gets wide stops and little patience, and a steady one gets tight
stops and time, without anybody choosing a percentage.

**The only settings left are money limits**, and they are the only thing the dashboard asks for:
balance, SOL per trade, open positions, entries per day, daily loss limit. Creating a `.halt` file
blocks new entries immediately.

## Where to see what happened

- **`npm run report`** — per bot: how many coins bot 1 saw and at what ages, what bot 2 made of
  them (including **how many coins older than a day went green**, which is the "pump again" case),
  and bot 3's entries, exits by reason, win rate and whether a higher score actually won more often.
- **The dashboard** (`npm start`, http://127.0.0.1:3000) — a card per bot, bot 1's last 25 coins,
  bot 2's green list with the reason each one passed, and what bot 3 is waiting for on each.
- **The three JSONL logs** in `data/`, one line per decision.

## Tuning from evidence

The weights in `PUMP_WEIGHTS`, the green threshold and the multipliers in `deriveLevels` are
hand-picked starting points, **not validated against outcomes**. After a few hundred paper trades,
`npm run report` shows whether the score separates winners from losers and which gate dominates the
rejections; change those, not a per-coin setting.

## Known limits

- **Discovery sees what GeckoTerminal ranks** (new, trending, first 10 pages by volume), not every
  token that exists. A coin nobody trades at all never appears — which is fine, since a coin with no
  trades is not about to pump.
- **GeckoTerminal's free API is the bottleneck on how fast new coins are found.** At 4-7 calls a
  minute a full rotation of all 17 pages takes several minutes (the hot pages come round in well
  under one). An API key, or a second listing source, is the way to raise that ceiling.
- **Dev history** only covers creators whose launch this bot saw while running, so older coins are
  almost always "unknown" (neutral). The holder check (`SOLANA_RPC_URL`) is the main safety signal
  for them, and it is off until you set that variable.
- **Volatility is measured from our own polling** (every 2-3s for watched coins), so it is a proxy
  for real tick volatility, and it is clamped to 0.5%–25% a minute.
- **GeckoTerminal fields** are parsed defensively; unknown values never reject a coin.
- Paper results ignore latency, failed sells and rugs you cannot exit, so they flatter reality.
- **The simulated cost dominates everything.** The defaults (`PAPER_FEE_BPS=100`,
  `PAPER_SLIPPAGE_BPS=200`, per side) mean a round trip costs 6% of the price before the trade has
  done anything, which is far above a real Solana AMM swap at this size. That is not just
  pessimistic accounting: every stop is floored at 1.5× the round trip, so a 6% cost forces 9%
  stops and pushes the bot towards only the wildest coins. Setting these to something realistic
  (around 25-30 bps fee, 50-100 bps slippage) changes both the measured PnL and the strategy.
