import { supabaseServer } from "@/lib/supabase";

// Shapes written by ingest/earnings_test.py (score() → earnings_test_summary.data).

export type Spread = { mean: number | null; t: number | null; seasons: number; positive: number };

export type Quintile = {
  q: number;
  events: number;
  pre_excess: number;
  react_excess: number;
  react_median: number;
  react_up_share: number;
  drift_excess: number | null;
};

export type Season = { season: string; events: number; react_spread: number | null; drift_spread: number | null };

export type CohortScore = {
  events: number;
  complete: number;
  seasons: Season[];
  quintiles: Quintile[];
  react_spread: Spread;
  drift_spread: Spread;
  same_sign: number | null;
  spearman_react: number | null;
  spearman_drift: number | null;
};

export type LiveEvent = {
  ticker: string;
  scheduled_date: string;
  source: "live" | "late";
  status: "scheduled" | "reported" | "reacted" | "complete" | "excluded" | "no_report";
  note: string | null;
  registered_at: string;
  report_date: string | null;
  session: "bmo" | "intraday" | "amc" | "unknown" | null;
  reaction_date: string | null;
  pre_excess: number | null;
  react_excess: number | null;
  drift_excess: number | null;
};

export type EarningsTestData = {
  backtest: CohortScore | null;
  live: CohortScore | null;
  computedAt: string | null;
  firstBacktestSeason: string | null;
  log: LiveEvent[]; // newest scheduled date first
};

const LOG_ROWS = 400;
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** null = tables missing (migration 033 not applied). */
export async function fetchEarningsTest(): Promise<EarningsTestData | null> {
  const sb = supabaseServer();
  const [sum, log] = await Promise.all([
    sb.from("earnings_test_summary").select("cohort,data,computed_at"),
    sb
      .from("earnings_test_events")
      .select(
        "ticker,scheduled_date,source,status,note,registered_at,report_date,session,reaction_date,pre_excess,react_excess,drift_excess",
      )
      .in("source", ["live", "late"])
      .order("scheduled_date", { ascending: false })
      .order("ticker")
      .limit(LOG_ROWS),
  ]);
  if (sum.error || log.error) return null;

  const by = new Map((sum.data ?? []).map((r) => [r.cohort as string, r]));
  const backtest = (by.get("backtest")?.data as CohortScore | undefined) ?? null;
  return {
    backtest,
    live: (by.get("live")?.data as CohortScore | undefined) ?? null,
    computedAt: (by.get("backtest")?.computed_at as string | undefined) ?? null,
    firstBacktestSeason: backtest?.seasons[0]?.season ?? null,
    log: (log.data ?? []).map((r) => ({
      ...r,
      pre_excess: numOrNull(r.pre_excess),
      react_excess: numOrNull(r.react_excess),
      drift_excess: numOrNull(r.drift_excess),
    })) as LiveEvent[],
  };
}
