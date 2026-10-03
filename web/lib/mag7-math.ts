// Pure Mag7 sleeve math, shared by the server page and the trade form.
// Mirrors ingest/mag7.py (which owns the signal + model sleeve).

// Mag7 + SpaceX (listed 2026-06-12; ranked on the returns it has).
export const LAG7_TICKERS = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "SPCX"] as const;
export type Lag7Ticker = (typeof LAG7_TICKERS)[number];
export const START_CAPITAL = 100_000;

export type ActualTrade = {
  id: number;
  trade_date: string;
  side: "buy" | "sell";
  ticker: string;
  shares: number;
  price: number;
  amount: number;
  note: string | null;
};

export type ActualSleeve = {
  shares: Record<string, number>; // strategy-owned shares per ticker (> 0 only)
  cash: number; // START_CAPITAL − buys + sells; never topped up
  invested: number; // Σ buy amounts
};

/** Replay YOUR ledger. Only shares this sleeve bought are ever counted. */
export function actualSleeve(trades: ActualTrade[]): ActualSleeve {
  const shares: Record<string, number> = {};
  let cash = START_CAPITAL;
  let invested = 0;
  for (const t of [...trades].sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.id - b.id)) {
    const sign = t.side === "buy" ? 1 : -1;
    shares[t.ticker] = (shares[t.ticker] ?? 0) + sign * t.shares;
    cash -= sign * t.amount;
    if (t.side === "buy") invested += t.amount;
  }
  for (const k of Object.keys(shares)) if (Math.abs(shares[k]) < 1e-6) delete shares[k];
  return { shares, cash, invested };
}

export type Order = { side: "buy" | "sell"; ticker: string; shares: number; estAmount: number };

/**
 * Orders that make your sleeve hold only `selected`: sell every strategy-owned
 * share of anything else, then put all sleeve cash into `selected`. Estimated
 * at the latest close — your fill will differ. Never adds outside capital.
 */
export function proposedOrders(sleeve: ActualSleeve, selected: string, closes: Record<string, number>): Order[] {
  const orders: Order[] = [];
  let cash = sleeve.cash;
  for (const [t, n] of Object.entries(sleeve.shares)) {
    if (t === selected || n <= 0) continue;
    const amt = n * (closes[t] ?? 0);
    orders.push({ side: "sell", ticker: t, shares: n, estAmount: amt });
    cash += amt;
  }
  const px = closes[selected];
  if (px && cash >= 1) orders.push({ side: "buy", ticker: selected, shares: cash / px, estAmount: cash });
  return orders;
}
