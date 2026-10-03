// Server-side loader for /funds. Calls the fund_flows() SQL function (migration
// 027), which does all the counting; the pure rules in fund-flow-rules.ts then
// label, filter and sort. Server Components only (uses the secret key).

import { supabaseServer } from "@/lib/supabase";
import type { FlowRow, Filters } from "@/lib/fund-flow-rules";

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
  return { status: "ok", rows };
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
  return out as FlowRow;
}
