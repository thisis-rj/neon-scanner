// Server-side loader for /funds. Calls the fund_flows() SQL function (migration
// 027), which does all the counting; the pure rules in fund-flow-rules.ts then
// label, filter and sort. Server Components only (uses the secret key).

import { supabaseServer } from "@/lib/supabase";
import type { FlowRow, Filters } from "@/lib/fund-flow-rules";
import { onBoard } from "@/lib/fund-board";

export type FlowsResult = { status: "ok"; rows: FlowRow[] } | { status: "not_computed" };

const PAGE = 1000; // PostgREST returns at most 1000 rows per request; page through.

// Function or table missing → the migration hasn't reached this database yet.
// (Pushing to main deploys the page at once; migrations apply in the nightly job.)
const NOT_THERE = new Set(["PGRST202", "PGRST205", "42883", "42P01"]);

export async function fetchFundFlows(f: Pick<Filters, "lag" | "tiers" | "categories">): Promise<FlowsResult> {
  const sb = supabaseServer();
  const rows: FlowRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .rpc("fund_flows", { p_lag: f.lag, p_tiers: f.tiers, p_categories: f.categories })
      .order("ticker")
      .range(from, from + PAGE - 1);
    if (error) {
      if (NOT_THERE.has(error.code)) return { status: "not_computed" };
      throw error;
    }
    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch.map(toRow));
    if (batch.length < PAGE) break;
  }
  const board = keepBoardFunds(rows);
  await addDollars(board);
  return { status: "ok", rows: board };
}

// Value each fund's share change at the stock's average price in that quarter
// (ticker_quarter_vwap, filled by ingest/cost_basis.py) and sum per stock, so the
// page can rank by money moved rather than by how many funds moved.
async function addDollars(rows: FlowRow[]): Promise<void> {
  const periods = [...new Set(rows.flatMap((r) => r.funds.map((d) => d.period)))];
  const px = new Map<string, number>();
  const sb = supabaseServer();
  for (const period of periods) {
    for (let from = 0; ; from += PAGE) {
      const { data } = await sb
        .from("ticker_quarter_vwap")
        .select("ticker,vwap")
        .eq("period_of_report", period)
        .order("ticker")
        .range(from, from + PAGE - 1);
      for (const v of data ?? []) if (v.vwap != null) px.set(`${v.ticker}|${period}`, Number(v.vwap));
      if (!data || data.length < PAGE) break;
    }
  }
  for (const r of rows) {
    let bought = 0, sold = 0, priced = false;
    for (const d of r.funds) {
      const p = px.get(`${r.ticker}|${d.period}`);
      if (p == null) {
        d.usd = null;
        continue;
      }
      priced = true;
      const usd = ((d.shares_cur ?? 0) - (d.shares_prev ?? 0) * (d.split || 1)) * p;
      d.usd = usd;
      if (usd >= 0) bought += usd;
      else sold -= usd;
    }
    r.net_usd = priced ? bought - sold : null;
    r.bought_usd = priced ? bought : null;
    r.sold_usd = priced ? sold : null;
  }
}

// Postgres numeric arrives as a string or number depending on size; make every
// numeric column a JS number (or null) once, here.
const NUMERIC = [
  "market_cap_usd", "avg_dollar_volume_20d", "return_6mo", "tier_net",
  "conviction_max", "conviction_sum",
] as const;

function toRow(r: Record<string, unknown>): FlowRow {
  const out = { ...r } as Record<string, unknown>;
  for (const k of NUMERIC) out[k] = r[k] === null || r[k] === undefined ? null : Number(r[k]);
  out.funds = ((r.funds as Record<string, unknown>[] | null) ?? []).map((d) => ({
    ...d,
    pct: d.pct === null || d.pct === undefined ? null : Number(d.pct),
    shares_prev: d.shares_prev === null || d.shares_prev === undefined ? null : Number(d.shares_prev),
    shares_cur: d.shares_cur === null || d.shares_cur === undefined ? null : Number(d.shares_cur),
    split: Number(d.split ?? 1),
  }));
  out.net_usd = null;
  out.bought_usd = null;
  out.sold_usd = null;
  return out as FlowRow;
}

// Riya's fund board (lib/fund-board.ts): drop funds that aren't on it and redo
// the per-stock counts from the remaining funds, so the table never counts a
// fund she has removed. Same counting as fund_flows() (migration 027), applied
// to the filtered list. `streak` can't be redone here (needs older filings) and
// still reflects all tracked funds.
const TIER_MULT: Record<string, number> = { S: 1.5, A: 1.2, B: 1.0, C: 0.7 };
function keepBoardFunds(rows: FlowRow[]): FlowRow[] {
  const out: FlowRow[] = [];
  for (const r of rows) {
    const funds = r.funds.filter((d) => onBoard(d.cik));
    if (funds.length === 0) continue;
    const buy = (d: (typeof funds)[number]) => d.event === "opened" || d.event === "added";
    const buyers = funds.filter(buy);
    const top = [...buyers].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))[0];
    out.push({
      ...r,
      funds,
      buyers: buyers.length,
      sellers: funds.length - buyers.length,
      net: buyers.length - (funds.length - buyers.length),
      opened: funds.filter((d) => d.event === "opened").length,
      added: funds.filter((d) => d.event === "added").length,
      trimmed: funds.filter((d) => d.event === "trimmed").length,
      exited: funds.filter((d) => d.event === "exited").length,
      tier_net: funds.reduce((s, d) => s + (buy(d) ? 1 : -1) * (TIER_MULT[d.tier] ?? 1), 0),
      sa_buyers: buyers.filter((d) => d.tier === "S" || d.tier === "A").length,
      conviction_max: top?.pct ?? null,
      conviction_max_filer: top?.filer ?? null,
      conviction_sum: buyers.length ? buyers.reduce((s, d) => s + (d.pct ?? 0), 0) : null,
    });
  }
  return out;
}
