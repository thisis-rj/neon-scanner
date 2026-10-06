import { supabaseServer } from "@/lib/supabase";

// Shapes written by ingest/earnings_test.py (score() → earnings_test_summary.data).

export type Spread = {
  mean: number | null;
  t: number | null;
  seasons: number;
  positive: number;
};

export type Quintile = {
  q: number;
  events: number;
  pre_excess: number;
  react_excess: number;
  react_median: number;
  react_up_share: number;
  drift_excess: number | null;
};

export type Season = {
  season: string;
  events: number;
  react_spread: number | null;
  drift_spread: number | null;
};

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

export type ScanRow = {
  cut: string[];
  label: string;
  outcome: "react" | "week" | "drift" | "size";
  search_effect: number;
  search_t: number;
  search_n: number;
  search_q: number;
  check_effect: number;
  check_t: number;
  check_n: number;
  verdict: "confirmed" | "same direction" | "did not hold";
  up_share: number | null;
  base_up: number | null;
};

export type ScanResult = {
  tested: number;
  kept: ScanRow[];
  split: string;
  fdr_q: number;
  min_n: number;
  reports: number;
  tiers: Record<string, number>;
  computed: string;
};

export type EarningsTestData = {
  scan: ScanResult | null;
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
    scan: (by.get("scan")?.data as ScanResult | undefined) ?? null,
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

export type ExplorerData = {
  events: import("@/lib/earnings-explore").ExploreEvent[];
  spyDates: string[];
  spyRet: number[];
  sectors: string[];
};

async function fetchPaged<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** Every measured report with its ±30-day return path, plus SPY's daily returns. */
export async function fetchExplorer(): Promise<ExplorerData> {
  const sb = supabaseServer();
  type Row = {
    ticker: string;
    reaction_date: string;
    session: "bmo" | "intraday" | "amc";
    sector: string | null;
    surprise_pct: number | null;
    source: "backtest" | "live";
    path: (number | null)[];
    insider_buyers: number | null;
    vol_path: (number | null)[] | null;
    ma50_gap: number | null;
    ma200_gap: number | null;
    mcap_at_report: number | null;
  };
  const [rows, spy] = await Promise.all([
    fetchPaged<Row>((a, b) =>
      sb
        .from("earnings_test_events")
        .select(
          "ticker,reaction_date,session,sector,surprise_pct,source,path,insider_buyers,vol_path,ma50_gap,ma200_gap,mcap_at_report",
        )
        .in("status", ["reacted", "complete"])
        .in("source", ["backtest", "live"])
        .not("path", "is", null)
        .order("ticker")
        .order("scheduled_date")
        .range(a, b),
    ),
    fetchPaged<{ date: string; ret: number }>((a, b) =>
      sb.from("earnings_test_spy").select("date,ret").order("date").range(a, b),
    ),
  ]);
  return {
    events: rows.map((r) => ({
      t: r.ticker,
      d: r.reaction_date,
      s: r.session,
      sec: r.sector,
      sur: r.surprise_pct == null ? null : Number(r.surprise_pct),
      src: r.source,
      p: r.path,
      ib: r.insider_buyers,
      v: r.vol_path,
      m50: r.ma50_gap == null ? null : Number(r.ma50_gap),
      m200: r.ma200_gap == null ? null : Number(r.ma200_gap),
      mc: r.mcap_at_report == null ? null : Number(r.mcap_at_report),
    })),
    spyDates: spy.map((x) => x.date),
    spyRet: spy.map((x) => Number(x.ret)),
    sectors: [...new Set(rows.map((r) => r.sector).filter((x): x is string => !!x))].sort(),
  };
}
