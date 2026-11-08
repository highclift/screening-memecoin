# Solana memecoin sniper — paper trading

This project includes a local web dashboard and a paper bot for new Pump.fun launches on Solana. It filters candidates by early trading activity, waits for a configurable pullback and rebound, and simulates entries and exits. It does **not** sign or send Solana transactions.

The bot cannot know a token's future low in advance. Its entry signal waits for a drop from the observed local peak and a bounce from the observed low. Paper prices use PumpPortal market-cap data as a proxy; they do not guarantee that a real order could fill at that price.

## Run the web dashboard

Requirements: Node.js 22 or newer and a PumpPortal API key.

```powershell
npm.cmd install
npm.cmd start
```

Open **http://127.0.0.1:3000**. The dashboard is bound to this computer only. Paste the API key into the password field and choose **Mulai paper scanner**. The dashboard keeps the key in server memory while it runs and does not write it to a file or browser storage. Alternatively, set only `PUMPPORTAL_API_KEY` in `.env` before starting the server. To run the command-line bot directly, use `npm.cmd run bot`.

To get a key, open [PumpPortal Getting Started](https://pumpportal.fun/trading-api/setup/) and generate a linked wallet and API key. Save the API key and wallet secret securely before leaving the page; PumpPortal says they cannot be recovered. Treat the API key as sensitive because it is linked to a wallet and can authorize trading through PumpPortal. This dashboard uses it only to connect the data feed.

PumpPortal requires a key linked to a wallet with at least 0.02 SOL for token-trade subscriptions. It charges 0.01 SOL per 10,000 streamed trades; new-token launch events are free. This bot receives new-launch events but tracks trades for at most `MAX_ACTIVE_CANDIDATES` tokens at once. See the [real-time data docs](https://pumpportal.fun/data-api/real-time/) and [fee page](https://pumpportal.fun/fees/).

The bot saves its simulated balance, open positions, and trade history under `data/paper-state.json`. That directory is ignored by Git. To stop new paper entries while keeping the feed and exit management running, create a `.halt` file in the project root; remove it to resume entries. `Ctrl+C` stops the bot.

The dashboard also has buttons to stop the scanner and reset the paper account. Reset is available only while the scanner is stopped.

## Strategy settings

Set strategy parameters in the dashboard. While the scanner is running, click **Terapkan setting sekarang** to send changes to the active bot without restarting the server or scanner. The default signal requires at least 8 observed trades, 5 buys, and 4 distinct buyers; then it waits for an 18% pullback from a local peak and a 6% bounce from the observed low. A position exits when estimated net proceeds reach the take-profit or stop-loss threshold, or when the maximum hold time expires. Starting balance applies when the paper account is initialized or reset.

Paper fee and slippage assumptions apply on each side of a simulated trade; they are not live quotes. The daily loss limit stops new entries after the realized loss reaches its configured value. Existing positions remain monitored for exits.

## Limits

- This version covers Pump.fun launches surfaced by PumpPortal, not every token on Solana or other chains.
- It uses market cap from the feed as a relative price proxy and has no on-chain liquidity, authority, or sellability checks.
- Paper results can differ sharply from live results due to latency, fees, liquidity, failed transactions, and price impact.
- Live execution is intentionally not implemented in this first version.
