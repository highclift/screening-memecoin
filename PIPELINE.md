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
| GeckoTerminal sweep | 17 pages of new / trending / top-volume pools, round-robin | 1 call per tick, shared 30/min budget |
| DexScreener refresh | market cap, liquidity, volume, buys/sells, socials | 30 coins per call |

A full GeckoTerminal sweep is about 340 distinct pools and takes roughly 45 seconds at the default
tick, so the registry sees a few hundred coins a minute and then starts again with fresh numbers.

**How a month-old coin gets screened again.** It does not sit in a queue waiting to be re-checked.
When it wakes up, its volume carries it back onto the trending and top-volume pages, so the sweep
picks it up with current numbers and hands it to bot 2 — which is free to turn it green today after
calling it red for weeks.

DexScreener refreshes go where they matter, in order: bot 3's open positions and watchlist, then
bot 2's green and watched coins, then a slow rotation over everything traded in the last 30 minutes.
Coins nobody is interested in are not polled; the sweep will find them again if they start moving.

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
   the low is "buyers are back", 2.5× below entry is the hard stop, 2× under the peak is the
   trailing stop (tightening to 1× once profit reaches 3×), and `120s × (3% / vol)` without a new
   high means the run is over.
3. Entry is a dip-and-bounce, plus two sanity checks: buy pressure must not have flipped below 50%,
   and a vertical candle (a step over 3× the coin's own volatility) waits for the next measurement
   instead of buying the spike.
4. Exits, in order: hard stop, trailing stop, breakdown (buy share under 35% while under water),
   stall, max hold (45 min). A position with no fresh price for a minute closes at the last known
   price rather than staying open forever.

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
- **Dev history** only covers creators whose launch this bot saw while running, so older coins are
  almost always "unknown" (neutral). The holder check (`SOLANA_RPC_URL`) is the main safety signal
  for them, and it is off until you set that variable.
- **Volatility is measured from our own polling** (every 2-3s for watched coins), so it is a proxy
  for real tick volatility, and it is clamped to 0.5%–25% a minute.
- **GeckoTerminal fields** are parsed defensively; unknown values never reject a coin.
- Paper results ignore latency, failed sells and rugs you cannot exit, so they flatter reality.
