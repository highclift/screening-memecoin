# The six agents

Paper trading only. Nothing here signs or sends a transaction.

Six agents in a chain, with hard handoffs. Each one only ever talks to the next, and a coin that
fails a stage is never seen by the stage after it:

```
AGENT 1  scout      is it in the window at all?        30m-72h old, $300k-$20M
AGENT 2  filter     is it safe to hold?                authorities, LP, liquidity, dev, bundling
AGENT 3  analyst    is it worth the money?             one score out of 100, pass mark 70
AGENT 4  executor   when to buy                        measured from the coin's own swing
AGENT 5  risk       how much, and when it ends         8% per trade, -6% stop, trail after +12%
AGENT 6  logger     what happened and why              data/scout.jsonl, kills.jsonl, trades.jsonl
```

They run in one process (`npm run bot`, or `npm start` for the dashboard too) because they share one
API budget and one copy of the market data. The handoff is one function call per stage, wired in
`src/index.js`: `onScouted -> filter.consider -> analyst.consider -> executor.watch/onData`, with
the executor asking the risk agent for permission, size and every exit.

**Every refusal is written down.** That is the logger's reason for existing, and it is what makes an
overnight run readable in the morning: `npm run report` is built entirely out of the kill log, and
can say which agent refused what, and therefore which rule actually shaped the night.

## Agent 1 — scout (`src/agents/scout.js`)

Finds coins, and decides one thing: is this one inside the window the desk trades at all?

| Rule | Default | Why |
|---|---|---|
| age | 30m – 72h | under 30 minutes a coin has no history to measure and its first candle is bots trading with bots; past 72 hours the launch crowd has gone and what is left is a chart, not an event |
| market cap | $300k – $20M | below the band there is nothing to sell into; above it a pump needs money the crowd has not got |

A coin outside the window is **still watched** — a 20-minute-old coin becomes eligible at 30, and a
$200k coin becomes eligible when it grows — it is simply not handed on, and the reason is logged.

The one exception: a coin the executor is already acting on skips the window check entirely. The
window says what the desk may *start* trading, never what it may keep watching. A position that
collapses falls straight out of the market-cap band, and if that stopped the data reaching the
executor the stop would never fire — which is the exact coin that needs selling first.

### Where the coins come from

The scout watches far wider than the window, because a coin walks into the window while nobody is
looking. The only thing skipped outright is a pool that is not a memecoin against SOL.

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
the scout has met a coin it stays in the DexScreener rotation below forever, so its numbers are
refreshed every minute or so whatever it is doing. Separately, when it wakes up its volume carries
it back onto the trending and top-volume pages, so the sweep finds it again even if it had been
evicted from the registry. Either way it is judged on what it is doing now, not on when it was
born — the window is about the coin's age, and nothing after the scout cares about that at all.

**Every coin in the registry is re-checked on a rotation**, ordered by who is closest to a decision:
the executor's open positions and watchlist first, then everything through the filter, then
everyone else, least recently refreshed first. Nobody is ever dropped for being quiet — a coin that went
quiet is precisely the coin that might wake up, and waiting for GeckoTerminal's rate-limited
trending page to re-surface it would be the slow way to find out.

That rotation is the main reason the "pump again" case works, and it is nearly free: one DexScreener
call covers 30 coins, and a measured probe answered 133 calls a minute (~4,000 coins) without a
single 429. The default of 3 calls every 2 seconds is ~2,700 coins a minute, so a registry of a few
thousand coins is fully re-checked every minute or so. The scout reports that interval as
`recheckSeconds`.

Every coin is logged the first time it is seen and then at most once a minute, so a few hundred
coins a minute stays readable (`data/scout.jsonl`, rotates at 20 MB).

## Agent 2 — filter (`src/agents/filter.js`)

Hard kills only. Not "is this a good trade" — that is the analyst — but "could a person honestly
hold this at all". Every rule here is a way of losing everything that has nothing to do with being
wrong about the price. Each coin is re-judged every `RESCORE_INTERVAL_MS` (15s) for as long as the
scout keeps seeing it, so a coin that fails now is free to pass later, and the other way round.

Cheapest first, so the calls are only spent on a coin that survived the free checks:

```
local numbers -> RugCheck (15/min) -> holder graph over RPC (optional)
```

| Kill | Rule | Why it is fatal rather than merely bad |
|---|---|---|
| `mint_authority` | creator can still mint | new supply gets sold into your bid |
| `freeze_authority` | creator can still freeze | you cannot sell at all |
| `lp_unlocked` | LP under `MIN_LP_LOCKED_PCT` (90%) burned or locked | somebody can withdraw the pool you were going to sell into |
| `liquidity` | under `MIN_LIQUIDITY_USD` ($25k) | no way out at any price |
| `dev_holding` | creator holds over `MAX_DEV_PCT` (3%) | one wallet whose exit is the whole move |
| `bundled` | linked wallets hold over `MAX_BUNDLED_PCT` (10%) | a launch split across wallets that trade it between themselves |
| `pumped_already` | over `MAX_PRICE_CHANGE_H1` (+80%) in an hour | the move has happened; what is left is the giving-back |
| `dev_history` / `rugged` | this creator rugged before, or this coin already collapsed | learned locally, from coins this desk watched die |

**Nothing here treats missing data as clean.** A check that could not be made leaves the coin in
`wait`, looked at again next pass, rather than passed on. That distinction is the whole value of the
stage: `safety_pending` is not `pass`.

### Where the safety data comes from

`src/rugcheck.js` calls api.rugcheck.xyz — free, no key, 15 calls a minute, so it is paced by a
budget and only ever spent on a coin that cleared everything cheaper. It answers the four things no
DEX feed reports: **LP burned or locked**, **what the creator still holds**, **insider networks**
(wallets that have passed the token between each other — the graph a bubble map draws), and the
**holder count**, which the analyst turns into a growth rate by keeping the samples over time.

`lpLockedPct` is read from the *deepest* pool rather than averaged. A coin trades in several pools
at once and their numbers disagree wildly (a pump.fun AMM pool at 100% beside four dust Meteora
pools at 0%); the pool that matters is the one a position would actually be sold into.

### The three gates that count wallets, not trades

Volume, trade count and the buy/sell split are all free for a group to manufacture by trading with
itself. The number of *distinct* wallets is what that would cost real money to fake.

| Gate | Refuses |
|---|---|
| `few_buyers` | fewer than `MIN_BUYERS_H1` (10) different wallets bought this hour |
| `wash_trading` | more than `MAX_TRADES_PER_BUYER` (12) trades per distinct buyer |
| `distribution` | selling wallets outnumber buying wallets by `MAX_SELLER_BUYER_RATIO` (1.25) |

`distribution` is the one that catches a finished pump. A coin can show an even buy/sell split and
healthy volume while the wallets holding it leave one after another — that is an insider position
being handed to whoever the chart attracted, and somebody has to be on the other side of the sale.

### The holder graph (optional, needs `SOLANA_RPC_URL`)

The deepest and most expensive look, so it goes last. Beyond authorities and top-holder
concentration it walks the **funding graph**: who paid for each holding wallet's first transaction.
Wallets that share a payer are one actor across addresses, and their combined holding is judged as a
single holder (`MAX_CLUSTER_PCT`, 15%). It covers 20 holders rather than 5
(`CLUSTER_HOLDER_COUNT`), because a cluster of twenty wallets at 1.5% each is invisible to any top-5
check. Three wallets from one payer is refused on the count alone (`MAX_CLUSTER_WALLETS`) when they
were funded within `CLUSTER_BURST_HOURS` of each other — the window is what keeps an exchange hot
wallet, which strangers share, from reading as a conspiracy.

What it cannot see: a holder whose own wallet has thousands of transactions. Its first transaction
is hundreds of pages back and usually too old for a non-archival node to return at all, so it is
left unlinked rather than guessed at. **On a coin held mostly by sniper bots this graph comes back
empty** — which is exactly why RugCheck's insider networks are read as well: they are built from
transfers between wallets, a different graph, and they see clusters this one cannot.

## Agent 3 — analyst (`src/agents/analyst.js`)

Everything that reaches here is already safe enough to hold. The analyst answers the different
question — out of the coins that are safe, which are worth the money — with one number out of 100
(`deskScore`, `src/signals.js`). Only `PASS_SCORE` (70) and above reaches the executor.

| Part | Weight | What it measures |
|---|---|---|
| `momentum` | 0.20 | 1h price change, or the climb off the lowest point this desk measured |
| `uniqueBuyers` | 0.20 | how many *different* wallets bought this hour |
| `buySellRatio` | 0.15 | buying wallets against selling wallets (falls back to the trade split) |
| `holderGrowth` | 0.20 | holders per hour, from the desk's own repeated samples |
| `liqMcap` | 0.15 | pool depth for the size of the coin |
| `smartWallets` | 0.10 | do wallets with a record of being early show up among the buyers |

Unknown parts score a neutral 0.5 and are reported as unknown, so a coin is never punished for a
field a source did not fill in — and never rewarded for one either. A coin with nothing measured
scores exactly 50, comfortably under the pass mark, so nothing is ever bought on a shrug. The score
is logged with `measured` ("4/6"), because a 72 built from four readings and two neutrals is a
weaker 72 than one built from six.

**Smart wallets are learned here, not bought in** (`src/smartwallets.js`). Once per coin the analyst
samples the wallets buying the pool and writes down the market cap at that moment; half an hour
later it checks what the coin did, and credits or debits those wallets. A wallet's score is its hit
rate, flattened towards neutral until it has a real record behind it. **On night one it knows
nothing and says so** — every wallet scores 0.5 and the part is neutral. It becomes worth something
after a few hundred settled samples, and the report can show whether it ever separated winners from
losers.

## Agent 4 — executor (`src/agents/executor.js`)

Decides *when*, and is the only agent that touches a position. It does not decide how much, whether
a trade is allowed, or when it ends — it asks the risk agent.

1. It watches a candidate until it has measured how much that coin moves in a minute
   (`volatilityPct`, 5 samples over at least 30 seconds). **It will not buy a coin it has not
   measured.**
2. Two ways in (`ENTRY_MODE`, default `both`):
   - **`dip-and-bounce`** — the coin pulls back by more than its own usual move and reclaims part
     of it. The better price.
   - **`breakout`** — a new high. A steady climber never dips, and waiting for a pullback that
     never comes means watching the move go past.

   Both carry the same two fill guards: buy pressure must not have flipped below 50%, and a
   vertical candle (a step over 3× the coin's own volatility) waits for the next measurement rather
   than buying the spike. Those decide the *price paid*; whether the coin is worth buying at all was
   settled two agents ago. Each entry records its trigger, so the report can compare them.

## Agent 5 — risk (`src/agents/risk.js`)

Owns the money. A desk where the thing hunting for entries also sets its own size and its own stop
has no risk management, only opinions.

| Question | Answer |
|---|---|
| how much | `POSITION_PCT` (8%) of the **current** paper balance — so the desk scales itself down after a bad night instead of betting the same size into a smaller account |
| may it trade | open positions, entries today, the daily loss limit, and a `.halt` file. Every refusal is a logged kill, once per change of reason |
| the stop | a flat `STOP_PCT` (-6%), **fixed before the entry is taken** and never widened |
| the trail | nothing trails until the trade has been `TRAIL_AFTER_PCT` (+12%) up. From there the floor is the better of break-even and `TRAIL_PCT` (8%) under the peak, and it only moves up |
| when else | `stall` (not covering costs and no new highs), `breakdown` (buy share collapses while under water), `max-hold` (`MAX_HOLD_MINUTES`, 10) |

The trail arming at +12% is what makes a winner safe: once it has latched, a trade that got that far
into profit cannot come back as a loss. `TRAIL_AFTER_PCT` must be greater than `STOP_PCT` or the
stop could never fire first, and the config refuses to start rather than quietly removing the stop.

**There is no take-profit target.** A target sells a winner at exactly the moment it is working.

A position with no fresh price for a minute closes at the last known price rather than staying open
forever (`max-hold-stale`).

## Agent 6 — logger (`src/agents/logger.js`)

Every agent reports here, and the rule it exists to enforce is **log every kill**: the reason, the
agent that made it, and the numbers that caused it.

```
data/scout.jsonl   every sighting
data/kills.jsonl   every refusal and every pass, from any stage
data/trades.jsonl  entries and exits
```

A coin that keeps failing the same check is written once and then at most every five minutes, so a
coin refused four times a minute all night does not bury the file. The counters stay exact either
way: deduplication affects the file, never the totals.

## Where to see what happened

- **`npm run report`** — what the scout saw and at what ages; **the funnel**, which is every kill
  broken down by the agent that made it and the rule it broke; and the executor's entries, exits by
  reason, win rate, and whether a higher analyst score actually won more often.
- **The dashboard** (`npm start`, http://127.0.0.1:3000) — a row per agent, the scout's last 25
  coins, the analyst's candidates with the score each one earned, and what the executor is waiting
  for on each.
- **The three JSONL logs** in `data/`, one line per decision.

Win rate on its own is close to meaningless here, and the report is built to say so: it breaks
outcomes down by score bucket and by entry trigger, because a desk can raise its win rate and lose
more money. Judge it on total PnL per bucket.

## Tuning from evidence

The weights in `DESK_WEIGHTS`, the pass mark, and the window itself are hand-picked starting
points, **not validated against outcomes**. After a few hundred paper trades, `npm run report`
shows whether the score separates winners from losers and which rule dominates the kills; change
those, not a per-coin setting.

A measured warning from the previous version of this desk, over 180 trades: the 0.80+ score bucket
had the *worst* total PnL of any bucket, and the second-best win rate bucket still lost money. A
score that has not been checked against outcomes is decoration.

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
- **The funding graph is one hop, and only for wallets it can read.** It answers "who paid for this
  wallet's first transaction", which catches a dev handing supply to addresses he created. It does
  not catch wallets linked by transfers *between* each other (what a bubble map actually draws), a
  cluster funded through a different intermediary each time, or any holder with a long transaction
  history. Treat an empty `clusters` list as "nothing visible from here", not "clean".
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
