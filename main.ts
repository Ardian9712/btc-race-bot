// BTC race bot for the make.fun 24h cbBTC/USDC replay (agent-fun/bars-replay/v1).
//
// The dev window falls about 2.3% over its 1,440 one-minute bars with long flat
// stretches, so trend following and dip buying both lose to the ~26 bps round-trip
// cost. What the window does pay for is ignition: two consecutive one-minute gains
// of at least a volatility-scaled size are followed, on average, by a further gain
// over the next few minutes. The bot buys that ignition with most of its cash,
// takes a quick profit, gives the trade room with a wide stop, and stays in cash
// otherwise. Every decision is an O(1) update per bar in float64, so two runs on
// the same bars give the same orders.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const P = {
  impulseBps: 8,
  volLen: 30,
  volK: 1,
  rsiLen: 14,
  rsiCap: 80,
  tpBps: 25,
  stopBps: 70,
  holdBars: 120,
  sizeBps: 8000,
  maxSlipBps: 100,
};

interface Rsi {
  first: number[];
  gain: number | null;
  loss: number | null;
  value: number | null;
}

interface Series {
  prevClose: bigint | null;
  /** The last volLen one-minute returns, in bps, oldest first. */
  rets: number[];
  rsi: Rsi;
  barsHeld: number;
}

const series = new Map<string, Series>();

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = { prevClose: null, rets: [], rsi: { first: [], gain: null, loss: null, value: null }, barsHeld: 0 };
    series.set(bar.symbol, s);
  }
  const c = BigInt(bar.c);
  if (s.prevClose !== null && s.prevClose > 0n) {
    s.rets.push(Number((c - s.prevClose) * 10000n / s.prevClose));
    if (s.rets.length > P.volLen) s.rets.shift();
    const change = Number(c - s.prevClose);
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    if (s.rsi.gain === null || s.rsi.loss === null) {
      s.rsi.first.push(change);
      if (s.rsi.first.length === P.rsiLen) {
        s.rsi.gain = s.rsi.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / P.rsiLen;
        s.rsi.loss = s.rsi.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / P.rsiLen;
      }
    } else {
      s.rsi.gain = (s.rsi.gain * (P.rsiLen - 1) + up) / P.rsiLen;
      s.rsi.loss = (s.rsi.loss * (P.rsiLen - 1) + down) / P.rsiLen;
    }
    const moved = s.rsi.gain !== null && s.rsi.loss !== null ? s.rsi.gain + s.rsi.loss : null;
    if (moved === null) s.rsi.value = null;
    else s.rsi.value = moved === 0 ? 50 : (100 * s.rsi.gain!) / moved;
  }
  s.prevClose = c;
  return s;
}

/** The population standard deviation of the recent one-minute returns, in bps. */
function volBps(s: Series): number {
  const n = s.rets.length;
  if (n === 0) return 0;
  const mean = s.rets.reduce((a, x) => a + x, 0) / n;
  return Math.sqrt(s.rets.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n);
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const orders: (BuyInput | SellInput)[] = [];
    const { fees } = state.hello;
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      if (s === undefined || !fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        s.barsHeld++;
        const val = state.value(symbol, held.qty);
        const stop = val * 10000n <= held.cost * BigInt(10000 - P.stopBps);
        const gain = P.tpBps > 0 && val * 10000n >= held.cost * BigInt(10000 + P.tpBps);
        const aged = P.holdBars > 0 && s.barsHeld >= P.holdBars;
        if (stop || gain || aged) {
          s.barsHeld = 0;
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: P.maxSlipBps });
        }
        continue;
      }
      s.barsHeld = 0;
      const n = s.rets.length;
      if (n < 2) continue;
      const r1 = s.rets[n - 1]!;
      const r2 = s.rets[n - 2]!;
      const threshold = Math.max(P.impulseBps, Math.round(P.volK * volBps(s)));
      const rsiOk = s.rsi.value !== null && s.rsi.value < P.rsiCap;
      if (r1 >= threshold && r2 >= threshold && rsiOk) {
        const notional = (state.cash * BigInt(P.sizeBps)) / 10000n;
        if (notional >= BigInt(fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: P.maxSlipBps });
        }
      }
    }
    return orders;
  },
});
