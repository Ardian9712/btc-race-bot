# btc-race-bot

A long-only trading bot for the make.fun 24-hour cbBTC/USDC replay
(`agent-fun/bars-replay/v1`, Node 22, `node main.ts`).

## What it does

The dev window falls about 2.3% over its 1,440 one-minute bars with long flat
stretches, so trend following and dip buying both lose to the ~26 bps
round-trip cost (4 bps fee + 2 bps slippage + price impact per side). What the
window does pay for is ignition: two consecutive one-minute gains of at least a
volatility-scaled size are followed, on average, by a further gain over the next
few minutes.

Each bar the bot keeps an O(1) running state per symbol:

- the last 30 one-minute returns, whose population standard deviation scales the
  entry threshold (`max(8 bps, 1 sigma)`), so a calmer or wilder window trades
  the same way;
- Wilder RSI(14), used only to refuse an entry while the market is already
  overbought (RSI at or above 80).

When it holds nothing and the last two one-minute returns both clear the
threshold with RSI below the cap, it buys 80% of its cash at the next minute's
open (`max_slippage_bps` 100). While it holds, it exits the whole position on a
+25 bps gain against cost, a -70 bps loss against cost, or 120 bars held,
whichever comes first; anything still held at the end is sold by the replay's
own flattening. It is otherwise in cash.

Every decision is float64 arithmetic over the bars alone: no clock, no
randomness, no I/O, so two runs on the same bars answer identically.

## Dev window result

Graded with the kit's local grader on the frozen dev window
(`dataset/bars/CBBTC.ndjson.gz`, 1,439 bars, one missing minute):

```
net PnL   8.368025 USDC  (return 0.008368025)
trading   10 trades, win rate 1.000000000, max drawdown 0.002986500
fees      3.217958 USDC; at 2x fees net PnL 5.149394 USDC
```

The bot clears the dev gate (net PnL above 0 after every fee) and beats every
kit baseline on the same window (buy-and-hold -25.97, momentum -23.31,
adx-momentum -53.35, rsi-bollinger -46.52, ema-cross -95.88, hold-cash 0.00).

## Layout

- `main.ts` - the bot (erasable TypeScript, `.ts` import extensions)
- `vendor/makefun-bars.ts` - byte-identical copy of the kit's SDK shim
- `LICENSE` - MIT
