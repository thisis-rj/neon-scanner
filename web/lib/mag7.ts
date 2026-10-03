import { supabaseServer } from "@/lib/supabase";
import type { ActualTrade } from "@/lib/mag7-math";

// 6/12-month fields are null for a newcomer (SpaceX) that hasn't traded that long.
export type Mag7Rank = {
  ticker: string;
  ret_3m: number;
  ret_6m: number | null;
  ret_12m: number | null;
  rank_3m: number;
  rank_6m: number | null;
  rank_12m: number | null;
  avg_rank: number;
};

export type Mag7Signal = {
  signal_date: string;
  selected: string;
  source: "backtest" | "live";
  trade_date: string | null;
  action: "initial" | "switch" | "hold" | null;
};

export type Mag7Equity = {
  date: string;
  kind: "month_end" | "latest";
  strategy: number;
  equal_weight: number;
  sp500: number; // S&P 500 total return index
  closes: Record<string, number>;
};

export type Mag7Data = {
  signals: Mag7Signal[]; // oldest → newest
  ranks: Mag7Rank[]; // latest signal's table in the rule's order: worst average (the pick) first
  equity: Mag7Equity[]; // oldest → newest
  actual: ActualTrade[];
};

const num = (v: unknown) => Number(v);
// Tie-break: the longest horizon each stock has (12-month, else 6, else 3).
const tieRet = (r: Mag7Rank) => r.ret_12m ?? r.ret_6m ?? r.ret_3m;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** Everything the sleeve panel needs. null = tables missing (migration 030 not applied). */
export async function fetchMag7(): Promise<Mag7Data | null> {
  const sb = supabaseServer();
  const [sig, eq, act] = await Promise.all([
    sb.from("mag7_signals").select("signal_date,selected,source,trade_date,action").order("signal_date").limit(5000),
    sb.from("mag7_equity").select("date,kind,strategy,equal_weight,sp500,closes").order("date").limit(5000),
    sb.from("mag7_actual_trades").select("id,trade_date,side,ticker,shares,price,amount,note").order("trade_date"),
  ]);
  if (sig.error || eq.error || act.error) return null;

  const signals = (sig.data ?? []) as Mag7Signal[];
  const latest = signals.at(-1);
  let ranks: Mag7Rank[] = [];
  if (latest) {
    const r = await sb.from("mag7_ranks").select("*").eq("signal_date", latest.signal_date);
    ranks = (r.data ?? [])
      .map((x) => ({
        ticker: x.ticker,
        ret_3m: num(x.ret_3m),
        ret_6m: numOrNull(x.ret_6m),
        ret_12m: numOrNull(x.ret_12m),
        rank_3m: x.rank_3m,
        rank_6m: x.rank_6m,
        rank_12m: x.rank_12m,
        avg_rank: num(x.avg_rank),
      }))
      .sort((a, b) => b.avg_rank - a.avg_rank || tieRet(a) - tieRet(b));
  }

  return {
    signals,
    ranks,
    equity: (eq.data ?? []).map((e) => ({
      ...e,
      strategy: num(e.strategy),
      equal_weight: num(e.equal_weight),
      sp500: num(e.sp500),
    })) as Mag7Equity[],
    actual: (act.data ?? []).map((t) => ({
      ...t,
      shares: num(t.shares),
      price: num(t.price),
      amount: num(t.amount),
    })) as ActualTrade[],
  };
}
