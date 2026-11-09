# Solana memecoin sniper — paper trading

This project includes a local web dashboard and a paper bot for Solana launch strategies. Launch metadata, AMM migration events, and trade data come from Pump.fun through PumpPortal. A token only enters screening after it migrates to an AMM pool; the bot then filters by trading activity, waits for a configurable pullback and rebound, and simulates entries and exits against that live data. It does **not** sign or send Solana transactions; only the paper balance and fills are simulated.

The bot cannot know a token's future low in advance. Its entry signal waits for a drop from the observed local peak and a bounce from the observed low. Token market cap from the feed is used as a price proxy; paper fills do not guarantee that a real order could fill at that price.

## Run the web dashboard

Requirements: Node.js 22 or newer. A PumpPortal API key is optional. The scanner always uses the live Pump.fun feed; the paper balance does not require a wallet connection.

```powershell
npm.cmd install
npm.cmd start
```

Open **http://127.0.0.1:3000**. The dashboard is bound to this computer only. Enter your PumpPortal API key and start the scanner. It will read actual launches and trades from Pump.fun while keeping the balance, entries, and exits in paper mode. The dashboard keeps a key entered in the page in server memory while it runs and does not write it to a file or browser storage. Alternatively, set `PUMPPORTAL_API_KEY` in `.env`. To run the command-line bot directly, set the key in `.env` and use `npm.cmd run bot`.

To get a key, open [PumpPortal Getting Started](https://pumpportal.fun/trading-api/setup/) and generate a linked wallet and API key. Save the API key and wallet secret securely before leaving the page; PumpPortal says they cannot be recovered. Treat the API key as sensitive because it is linked to a wallet and can authorize trading through PumpPortal. This dashboard uses it only to connect the data feed.

## Data sources (free by default)

`TRADE_SOURCE=free` (default) needs **no SOL and no API key**:

- Launches and AMM migrations: PumpPortal websocket (free).
- Price and buy/sell counts: DexScreener, polled every `POLL_INTERVAL_MS` (default 3000), 30 tokens per request. The bot keeps market cap in SOL for paper fill accounting and reads USD market cap for screening and display.
- Unique buyers: GeckoTerminal pool trades, fetched lazily (at most one call per poll, only for candidates that already pass the trade/buy thresholds).

Trade-offs versus the paid stream: prices arrive every few seconds instead of per trade, so pullback/bounce is detected on sampled prices; DexScreener needs a few seconds to index a new pool, so some candidates may expire before they appear; trade counts use DexScreener's 5-minute window, so keep `maxCandidateAgeSeconds` at or below 300. Free API rate limits can change; check the providers' docs.

`TRADE_SOURCE=pumpportal` restores the old per-trade stream, which needs a key linked to a wallet with at least 0.02 SOL and costs 0.01 SOL per 10,000 streamed trades. See the [real-time data docs](https://pumpportal.fun/data-api/real-time/) and [fee page](https://pumpportal.fun/fees/).

The bot saves its simulated balance, open positions, and trade history under `data/paper-state.json`. That directory is ignored by Git. To stop new paper entries while keeping the feed and exit management running, create a `.halt` file in the project root; remove it to resume entries. `Ctrl+C` stops the bot.

The dashboard also has buttons to stop the scanner and reset the paper account. Reset is available only while the scanner is stopped.

While the scanner runs, the **Debug screener** panel shows how many migrated tokens are currently being screened, the latest candidate stages, and recent filter, entry, and expiry messages. Tokens from the PumpPortal feed link to their Solana Explorer address in open positions and trade history.

## Social filter and sniper preset

The dashboard's social-link setting offers X/Twitter required, at least one link (X, Telegram, or website), at least two different link types, or no social filter. The default remains X/Twitter required. `SOCIAL_MODE` supports the same values (`twitter`, `any`, `multiple`, `off`) in `.env`. Links come from launch metadata and DexScreener token info. A token whose metadata was never seen stays at "Menunggu data sosial" until it expires. A link only shows that one was provided; it does not prove the account is real or the dev is honest.

Default strategy values are a "sniper" preset: market cap $40,000-$160,000, at least 25 trades / 14 buys / 8 unique buyers, 20% pullback then 5% bounce, take profit 10%, stop loss 15%, max hold 180s. The dashboard shows entry and exit market caps in USD; the paper balance, spend, and PnL remain in SOL. Take profit and stop loss are measured on net proceeds after the simulated fee and slippage, which already cost about 6% round trip, so a 10% target needs roughly a 17% price rise and a 15% stop triggers at roughly a 10% price drop. Judge the preset on 50+ paper trades before trusting it.

## Strategy settings

Set strategy parameters in the dashboard. While the scanner is running, click **Terapkan setting sekarang** to send changes to the active bot without restarting the server or scanner. The default signal requires at least 8 observed trades, 5 buys, and 4 distinct buyers; then it waits for an 18% pullback from a local peak and a 6% bounce from the observed low. A position exits when estimated net proceeds reach the take-profit or stop-loss threshold, or when the maximum hold time expires. Starting balance applies when the paper account is initialized or reset.

Paper fee and slippage assumptions apply on each side of a simulated trade; they are not live quotes. The daily loss limit stops new entries after the realized loss reaches its configured value. Existing positions remain monitored for exits. Set market-cap filters in USD; other account amounts remain in SOL.

## Limits

- This version covers Pump.fun tokens surfaced by PumpPortal after migration to an AMM pool, not every token on Solana or other chains.
- Migration confirms a pool was created, but the scanner does not independently verify current on-chain liquidity, token authorities, or sellability. USD market cap is derived from the feed's token price and SOL/USD quote; it is an estimate.
- Paper results can differ sharply from live results due to latency, fees, liquidity, failed transactions, and price impact.
- Live execution is intentionally not implemented in this first version.
