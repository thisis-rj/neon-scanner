import { supabaseServer } from "@/lib/supabase";
import { filerInfo, tier } from "@/lib/filers";
import { daysAgo, fmtShares, fmtUsd } from "@/lib/format";
import { cn } from "cn";
import { TierFilter } from "@/components/TierFilter";
import { FilerCardTabs } from "@/components/FilerCardTabs";
import { PageHeader } from "@/components/app/page-header";
import { Hint, ThirteenFDelayNote, TierBadge } from "@/components/app/cells";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoIcon } from "lucide-react";

// Force dynamic rendering. Without this, Next.js statically renders the page
// at build time and serves the snapshot from the deploy. After May 17 we
// caught the holdings page serving Q3 2025 data because the cached build
// pre-dated the Q1 2026 13F ingestion. Fresh DB read on every request.
export const dynamic = "force-dynamic";


// Holdings view: per-filer most recent 13F snapshot, with top positions by value.
// This is *plumbing inspection*, not signal generation — confluence scoring
// will be built fresh after all plumbing lands.

type Holding = {
  cik: string;
  filer_name: string | null;
  period_of_report: string;
  filed_at: string;  // when the 13F was actually filed (≠ period_of_report)
  cusip: string;
  ticker: string | null;
  issuer_name: string | null;
  shares: number | null;
  value_usd: number | null;
  put_call: string | null;  // Always null: holdings_recent() reads holdings_13f_effective, which drops option rows (migration 023).
};

// Cost-basis estimate per (filer, ticker) — keyed `${cik}|${ticker}`.
type CostEstimate = { estimated_cost_basis: number; first_seen_period: string };

// 13F-clone trailing return per filer (from filer_performance table).
// oneY/threeY are %; cov is the priced-coverage reliability indicator.
type FilerPerf = { oneY: number | null; threeY: number | null; covOneY: number | null; covThreeY: number | null };

// Normalize issuer_name → matchable key. Mirror of cost_basis.py's normalize_name.
// holdings_13f.ticker is NULL for 100% of rows (parse_13f only stores CUSIP),
// so we resolve to ticker at render time against the tickers universe.
const SUFFIX_RE = /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HLDGS|GROUP|GRP|LLC|LP|TRUST|N V|NV|SA|AG|TR|CL A|CL B|CLASS A|CLASS B|COM|ORD|ORDINARY|SHARES)\b\.?/gi;
const PUNCT_RE = /[.,&/\-()']/g;
function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toUpperCase()
    .replace(PUNCT_RE, " ")
    .replace(SUFFIX_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Resolve issuer_name → ticker with truncation-aware fallback.
// SEC 13F XML truncates names at fixed widths, leaving partial words like
// "PRAXIS PRECISION MEDICINES I" (instead of "...INC"). Try exact match
// first, then strip a trailing 1-2 letter token and retry. Caught May 22 —
// Perceptive's PRAX/CELC/ASND all had Est. cost = "—" for this reason.
function resolveTicker(issuer: string | null | undefined, m: Record<string, string>): string | null {
  const n = normalizeName(issuer);
  if (!n) return null;
  if (m[n]) return m[n];
  const trimmed = n.replace(/\s[A-Z]{1,2}$/, "").trim();
  if (trimmed && trimmed !== n && m[trimmed]) return m[trimmed];
  return null;
}

// Key for matching the same issuer across quarters (case/space-normalized
// name). priorByCusip is keyed by this, not by CUSIP — see FilerSummary.
function normIssuer(n: string | null): string {
  return (n ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

async function fetchHoldings(): Promise<{
  filers: FilerSummary[];
  total: number;
  prices: Record<string, number>;
  costs: Record<string, CostEstimate>;
  nameToTicker: Record<string, string>;
  perf: Record<string, FilerPerf>;
}> {
  const sb = supabaseServer();
  // Pull ONLY the latest 2 periods per filer via the holdings_recent() RPC
  // (migration 015). Previously this paginated the ENTIRE 147K-row holdings_13f
  // table into the server component on every request, which exceeded Vercel's
  // function timeout — the page returned 0 bytes and users saw stale browser
  // cache. The RPC pushes the per-filer period-ranking into Postgres and
  // returns ~25K rows instead of 147K.
  const out: Holding[] = [];
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await sb
      .rpc("holdings_recent", { max_periods: 2 })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data as Array<{
      cik: string; period_of_report: string; cusip: string; ticker: string | null;
      issuer_name: string | null; shares: number | null; value_usd: number | null;
      put_call: string | null; filer_name: string | null; filed_at: string;
    }>) {
      out.push({
        cik: r.cik,
        filer_name: r.filer_name ?? null,
        period_of_report: r.period_of_report,
        filed_at: r.filed_at ?? "",
        cusip: r.cusip,
        ticker: r.ticker,
        issuer_name: r.issuer_name,
        shares: r.shares,
        value_usd: r.value_usd,
        put_call: r.put_call ?? null,
      });
    }
    if (data.length < page) break;
    from += page;
    if (from > 60000) break; // safety cap. RPC returns ~25K rows (2 periods × all filers); 60K is generous headroom.
  }

  // holdings_recent() reads holdings_13f_effective (migration 023), which
  // already resolves amendments per (cik, period): a RESTATEMENT replaces the
  // original (the Oaktree 13F + 2 amendments case shows each position once),
  // a NEW HOLDINGS amendment adds to it (Berkshire Q1-2025 = 110 + 4). Rows can
  // therefore come from two filings in one quarter — don't dedupe by filed_at here.

  // For each filer, collect positions GROUPED BY period so we can diff the
  // latest quarter vs the prior quarter (CLAUDE.md §6.1: emit new/add/trim/exit).
  const byFilerByPeriod = new Map<string, Map<string, Holding[]>>();
  const filerMeta = new Map<string, { name: string; filedAt: Record<string, string> }>();
  for (const h of out) {
    if (!byFilerByPeriod.has(h.cik)) byFilerByPeriod.set(h.cik, new Map());
    const periods = byFilerByPeriod.get(h.cik)!;
    if (!periods.has(h.period_of_report)) periods.set(h.period_of_report, []);
    periods.get(h.period_of_report)!.push(h);
    if (!filerMeta.has(h.cik)) filerMeta.set(h.cik, { name: h.filer_name ?? h.cik, filedAt: {} });
    const filedAt = filerMeta.get(h.cik)!.filedAt;
    if (!filedAt[h.period_of_report] || h.filed_at > filedAt[h.period_of_report]) filedAt[h.period_of_report] = h.filed_at;
  }

  // Aggregate by issuer (case-normalized name). Options and bond principal are
  // already excluded by the view. Aggregating by
  // issuer collapses cases where one issuer has multiple CUSIPs (e.g.
  // Chesapeake legacy CUSIP + post-merger Expand Energy CUSIP).
  function aggregateByIssuer(positions: Holding[]): Holding[] {
    const m = new Map<string, Holding>();
    for (const p of positions) {
      const key = normIssuer(p.issuer_name);
      if (!key) continue;
      const existing = m.get(key);
      if (!existing) {
        m.set(key, { ...p });
      } else {
        existing.shares = (existing.shares ?? 0) + (p.shares ?? 0);
        existing.value_usd = (existing.value_usd ?? 0) + (p.value_usd ?? 0);
      }
    }
    return Array.from(m.values());
  }

  const byFiler = new Map<string, FilerSummary>();
  for (const [cik, periods] of byFilerByPeriod) {
    const sortedPeriods = Array.from(periods.keys()).sort().reverse();
    const latest = sortedPeriods[0];
    const prior = sortedPeriods[1] ?? null;
    const meta = filerMeta.get(cik)!;
    const latestAgg = aggregateByIssuer(periods.get(latest)!);
    const priorAgg = prior ? aggregateByIssuer(periods.get(prior)!) : [];
    const priorByIssuer = new Map(priorAgg.map((p) => [normIssuer(p.issuer_name), p]));
    const latestIssuers = new Set(latestAgg.map((p) => normIssuer(p.issuer_name)));

    // News: in latest, not in prior. Sort by latest value desc.
    const news: Holding[] = prior
      ? latestAgg
          .filter((p) => !priorByIssuer.has(normIssuer(p.issuer_name)))
          .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0))
      : [];
    // Adds: in both, shares up ≥10%. Sort by % desc.
    const adds: Array<{ pos: Holding; prevShares: number; pct: number }> = [];
    // Trims: in both, shares down ≥10%. Sort by % asc (most-trimmed first).
    const trims: Array<{ pos: Holding; prevShares: number; pct: number }> = [];
    if (prior) {
      for (const p of latestAgg) {
        const prev = priorByIssuer.get(normIssuer(p.issuer_name));
        if (!prev || !prev.shares || prev.shares === 0) continue;
        const ratio = ((p.shares ?? 0) - prev.shares) / prev.shares;
        if (ratio >= 0.10) adds.push({ pos: p, prevShares: prev.shares, pct: ratio * 100 });
        else if (ratio <= -0.10) trims.push({ pos: p, prevShares: prev.shares, pct: ratio * 100 });
      }
      adds.sort((a, b) => b.pct - a.pct);
      trims.sort((a, b) => a.pct - b.pct);
    }
    // Exits: in prior, not in latest. Sort by prior value desc.
    const exits: Holding[] = prior
      ? priorAgg
          .filter((p) => !latestIssuers.has(normIssuer(p.issuer_name)))
          .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0))
      : [];

    byFiler.set(cik, {
      cik,
      name: meta.name,
      latestPeriod: latest,
      latestFiledAt: meta.filedAt[latest] ?? "",
      priorPeriod: prior,
      positions: latestAgg,
      priorByCusip: priorByIssuer,  // now keyed by normalized issuer name (still called "ByCusip" for type compat — TODO rename)
      news,
      adds,
      trims,
      exits,
      totalValue: 0,
      totalPositions: 0,
    });
  }
  // Compute totals across all positions in the latest quarter, THEN trim to top 10.
  //
  // 13F value normalization: SEC's pre-2024 instruction was "value in thousands",
  // post-2024 is "value in dollars". Different filers transitioned at different
  // times and some still use the old scale. Detection heuristic: if the median
  // implied per-share price (value/shares) across the filer's top positions is
  // suspiciously low (<$5), the value field is in thousands — multiply by 1000.
  for (const f of byFiler.values()) {
    f.positions.sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0));
    const topForScale = f.positions.slice(0, 10);
    const marks = topForScale
      .map((p) => (p.value_usd && p.shares ? p.value_usd / p.shares : null))
      .filter((m): m is number => m != null && m > 0)
      .sort((a, b) => a - b);
    const medianMark = marks.length ? marks[Math.floor(marks.length / 2)] : null;
    const inThousands = medianMark != null && medianMark < 5;
    const scale = inThousands ? 1000 : 1;
    if (scale !== 1) {
      for (const p of f.positions) {
        if (p.value_usd != null) p.value_usd *= scale;
      }
    }
    f.totalValue = f.positions.reduce((sum, p) => sum + (p.value_usd ?? 0), 0);
    f.totalPositions = f.positions.length;
    f.positions = f.positions.slice(0, 10);
  }
  // Sort filers by RECENCY of latest filing (newest first) so freshly-updated
  // filers float to the top of the page.
  const filers = Array.from(byFiler.values()).sort(
    (a, b) => b.latestFiledAt.localeCompare(a.latestFiledAt),
  );

  // Build normalized-name → ticker map FIRST (so we can resolve at render
  // time + use those resolved tickers to drive the price lookup below).
  const nameToTicker: Record<string, string> = {};
  {
    let off = 0;
    while (true) {
      const { data } = await sb.from("tickers").select("ticker,name").range(off, off + 999);
      if (!data || data.length === 0) break;
      for (const row of data) {
        const norm = normalizeName(row.name);
        if (norm && !(norm in nameToTicker)) nameToTicker[norm] = row.ticker;
      }
      if (data.length < 1000) break;
      off += 1000;
    }
  }

  // Build CUSIP → ticker map from cusip_ticker_map (populated by
  // ingest/cusip_resolver.py via OpenFIGI). This is the authoritative
  // resolver for SEC-truncated names and ambiguous ETF prefixes that the
  // name normalizer can't disambiguate (caught May 22 — "ISHARES TR" /
  // "ACACIA RESH CORP" had empty cells).
  const cusipToTicker: Record<string, string> = {};
  {
    let off = 0;
    while (true) {
      const { data } = await sb
        .from("cusip_ticker_map")
        .select("cusip,ticker")
        .not("ticker", "is", null)
        .range(off, off + 999);
      if (!data || data.length === 0) break;
      for (const row of data) {
        if (row.ticker) cusipToTicker[row.cusip] = row.ticker;
      }
      if (data.length < 1000) break;
      off += 1000;
    }
  }

  // Resolve each position's ticker. Order:
  //   1) holdings_13f.ticker (rarely populated by parse_13f)
  //   2) CUSIP → ticker (authoritative, from OpenFIGI)
  //   3) issuer_name normalize (fallback for CUSIPs we haven't resolved yet)
  const tickerSet = new Set<string>();
  for (const f of filers) {
    for (const p of f.positions) {
      const resolved =
        p.ticker
        || cusipToTicker[p.cusip]
        || resolveTicker(p.issuer_name, nameToTicker);
      if (resolved) {
        p.ticker = resolved;  // mutate in place so the render path picks it up
        tickerSet.add(resolved);
      }
    }
  }
  const prices: Record<string, number> = {};
  if (tickerSet.size > 0) {
    // Batch tickers so we don't blow Supabase's URL length on 800+ tickers
    const tickersArr = Array.from(tickerSet);
    const batchSize = 200;
    for (let i = 0; i < tickersArr.length; i += batchSize) {
      const batch = tickersArr.slice(i, i + batchSize);
      const { data } = await sb.from("tickers").select("ticker,price").in("ticker", batch);
      for (const row of data ?? []) {
        if (row.price != null) prices[row.ticker] = row.price;
      }
    }
  }
  // Cost-basis estimates (keyed cik|ticker). Populated by ingest/cost_basis.py.
  //
  // Supabase default-limits any query to 1000 rows. With ~84 filers × ~150 cost
  // rows = ~12K total, a single .in() call silently truncates to 1000 (caught
  // May 22 — Perceptive's PRAX/CELC/etc all showed Est.cost = "—" because the
  // 1000-row window cut their entries). Must paginate via .range().
  const costs: Record<string, CostEstimate> = {};
  {
    const cikSet = new Set(filers.map((f) => f.cik));
    if (cikSet.size > 0) {
      const ciksArr = Array.from(cikSet);
      let off = 0;
      while (true) {
        const { data } = await sb
          .from("filer_position_cost")
          .select("cik,ticker,estimated_cost_basis,first_seen_period")
          .in("cik", ciksArr)
          .range(off, off + 999);
        if (!data || data.length === 0) break;
        for (const row of data) {
          costs[`${row.cik}|${row.ticker}`] = {
            estimated_cost_basis: row.estimated_cost_basis,
            first_seen_period: row.first_seen_period,
          };
        }
        if (data.length < 1000) break;
        off += 1000;
      }
    }
  }

  // 13F-clone trailing returns per filer (filer_performance, from
  // ingest/filer_returns.py). Small table (~2 rows/filer) — single query.
  const perf: Record<string, FilerPerf> = {};
  {
    const { data } = await sb
      .from("filer_performance")
      .select("cik,horizon,return_pct,priced_coverage");
    for (const row of data ?? []) {
      const p = (perf[row.cik] ??= { oneY: null, threeY: null, covOneY: null, covThreeY: null });
      if (row.horizon === "1Y") { p.oneY = row.return_pct; p.covOneY = row.priced_coverage; }
      else if (row.horizon === "3Y") { p.threeY = row.return_pct; p.covThreeY = row.priced_coverage; }
    }
  }

  return { filers, total: out.length, prices, costs, nameToTicker, perf };
}

type FilerSummary = {
  cik: string;
  name: string;
  latestPeriod: string;
  latestFiledAt: string;
  // Prior-quarter snapshot for diff display (CLAUDE.md §6.1: new/add/trim/exit).
  // priorPeriod = the immediately-preceding 13F period we have for this filer (null if none).
  // priorByCusip = O(1) lookup for "did they hold this last quarter?".
  // exits = positions present last quarter but missing this quarter, sorted by prior value desc.
  priorPeriod: string | null;
  priorByCusip: Map<string, Holding>;  // keyed by normalized issuer name (not cusip — legacy field name)
  news: Holding[];
  adds: Array<{ pos: Holding; prevShares: number; pct: number }>;
  trims: Array<{ pos: Holding; prevShares: number; pct: number }>;
  exits: Holding[];
  positions: Holding[];
  totalValue: number;       // sum of value_usd across ALL positions that quarter (not just top 10)
  totalPositions: number;   // count of all positions that quarter
};

// Compact % formatter for the Δ shares column. Caps massive values that
// otherwise overflow the column (e.g. NEW positions building from 1 share
// to 100k → "+10,000,000%" looks broken). Renders ≥1000% as multiples ("12×").
function fmtPctCompact(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  const abs = Math.abs(pct);
  if (abs >= 1000) {
    const mult = pct / 100;  // 1234% = 12.34×
    return `${sign}${mult.toFixed(0)}×`;
  }
  if (abs >= 100) return `${sign}${pct.toFixed(0)}%`;
  return `${sign}${pct.toFixed(1)}%`;
}


type Tier = "S" | "A" | "B" | "C";

function EmptyDiff({ priorPeriod, msg }: { priorPeriod: string | null; msg: string }) {
  return (
    <p className="px-4 py-8 text-center text-xs text-muted-foreground">
      {priorPeriod
        ? `${msg} vs prior quarter ${priorPeriod}.`
        : "No prior 13F to compare — first quarter on file for this filer."}
    </p>
  );
}

// One labelled block inside the Bought / Sold tabs.
function DiffSection({
  label,
  count,
  tone,
  children,
}: {
  label: string;
  count: number;
  tone: "positive" | "warning" | "negative";
  children: React.ReactNode;
}) {
  const dot = { positive: "bg-positive", warning: "bg-warning", negative: "bg-negative" }[tone];
  return (
    <div>
      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-1.5 text-[11px] font-medium text-muted-foreground uppercase">
        <span className={cn("size-1.5 rounded-full", dot)} />
        {label}
        <span className="tabular-nums">({count})</span>
      </div>
      <Table className="text-xs">
        <TableBody>{children}</TableBody>
      </Table>
    </div>
  );
}

const cell = "py-1.5";

// "Bought" view: positions the filer ADDED to or INITIATED this quarter.
function BoughtView({ f }: { f: FilerSummary }) {
  if (f.news.length + f.adds.length === 0) {
    return <EmptyDiff priorPeriod={f.priorPeriod} msg="No new positions or adds ≥10%" />;
  }
  return (
    <div>
      {f.news.length > 0 && (
        <DiffSection label="New positions" count={f.news.length} tone="positive">
          {f.news.map((p) => (
            <TableRow key={`new-${p.cusip}`}>
              <TableCell className={cn(cell, "max-w-56 truncate pl-4")} title={p.issuer_name ?? ""}>{p.issuer_name ?? "?"}</TableCell>
              <TableCell className={cn(cell, "text-right text-muted-foreground tabular-nums")}>{fmtShares(p.shares)} sh</TableCell>
              <TableCell className={cn(cell, "pr-4 text-right tabular-nums")}>{fmtUsd(p.value_usd)}</TableCell>
            </TableRow>
          ))}
        </DiffSection>
      )}
      {f.adds.length > 0 && (
        <DiffSection label="Added ≥10%" count={f.adds.length} tone="positive">
          {f.adds.map((a) => (
            <TableRow key={`add-${a.pos.cusip}`}>
              <TableCell className={cn(cell, "max-w-56 truncate pl-4")} title={a.pos.issuer_name ?? ""}>{a.pos.issuer_name ?? "?"}</TableCell>
              <TableCell className={cn(cell, "text-right text-muted-foreground tabular-nums")}>{fmtShares(a.prevShares)} → {fmtShares(a.pos.shares)}</TableCell>
              <TableCell className={cn(cell, "pr-4 text-right font-medium text-positive tabular-nums")}>{fmtPctCompact(a.pct)}</TableCell>
            </TableRow>
          ))}
        </DiffSection>
      )}
    </div>
  );
}

// "Sold" view: positions the filer TRIMMED or EXITED this quarter.
// Per CLAUDE.md §2.3 — exits/trims get equal prominence to entries.
function SoldView({ f }: { f: FilerSummary }) {
  if (f.trims.length + f.exits.length === 0) {
    return <EmptyDiff priorPeriod={f.priorPeriod} msg="No trims ≥10% or exits" />;
  }
  return (
    <div>
      {f.exits.length > 0 && (
        <DiffSection label="Exited" count={f.exits.length} tone="negative">
          {f.exits.map((e) => (
            <TableRow key={`exit-${e.cusip}`}>
              <TableCell className={cn(cell, "max-w-56 truncate pl-4")} title={e.issuer_name ?? ""}>{e.issuer_name ?? "?"}</TableCell>
              <TableCell className={cn(cell, "text-right text-muted-foreground tabular-nums")}>{fmtShares(e.shares)} sh</TableCell>
              <TableCell className={cn(cell, "pr-4 text-right text-negative tabular-nums")}>{fmtUsd(e.value_usd)} sold</TableCell>
            </TableRow>
          ))}
        </DiffSection>
      )}
      {f.trims.length > 0 && (
        <DiffSection label="Trimmed ≥10%" count={f.trims.length} tone="warning">
          {f.trims.map((t) => (
            <TableRow key={`trim-${t.pos.cusip}`}>
              <TableCell className={cn(cell, "max-w-56 truncate pl-4")} title={t.pos.issuer_name ?? ""}>{t.pos.issuer_name ?? "?"}</TableCell>
              <TableCell className={cn(cell, "text-right text-muted-foreground tabular-nums")}>{fmtShares(t.prevShares)} → {fmtShares(t.pos.shares)}</TableCell>
              <TableCell className={cn(cell, "pr-4 text-right font-medium text-warning tabular-nums")}>{fmtPctCompact(t.pct)}</TableCell>
            </TableRow>
          ))}
        </DiffSection>
      )}
    </div>
  );
}

const COLUMN_GUIDE: [string, string][] = [
  ["% of port", "Position value as a share of the filer's whole US-equity book. ≥10% = high conviction."],
  ["$/sh", "Under each value: quarter-end value ÷ shares. A mark, NOT the price the filer paid."],
  ["Est. cost", "Estimated entry: per-quarter VWAP weighted across the quarters they accumulated. Typically ±15–25% off."],
  ["P&L", "(Now − Est. cost) ÷ Est. cost — the filer's approximate paper gain on this position."],
  ["Δ shares", "Change in share count vs their prior 13F. NEW = not held last quarter."],
  ["Filed", "Green = filed in the last 14 days. Red = older than 120 days (stale)."],
  ["Left bar", "Amber = activist filer. Blue = corporate strategic (a public company)."],
];

function ColumnGuide() {
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        <Button variant="outline" size="sm">
          <InfoIcon data-icon="inline-start" />
          Column guide
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-96">
        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-2 text-xs">
          {COLUMN_GUIDE.map(([term, def]) => (
            <div key={term} className="contents">
              <dt className="font-medium">{term}</dt>
              <dd className="text-pretty text-muted-foreground">{def}</dd>
            </div>
          ))}
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

function recencyTone(days: number | null): string {
  if (days == null) return "text-muted-foreground";
  if (days <= 14) return "text-positive";
  if (days > 120) return "text-negative";
  if (days <= 60) return "text-foreground";
  return "text-muted-foreground";
}

function perfTone(v: number | null): string {
  return v == null ? "text-muted-foreground" : v >= 0 ? "text-positive" : "text-negative";
}

export default async function HoldingsPage() {
  const { filers, total, prices, costs, perf } = await fetchHoldings();
  // (nameToTicker mutation already applied to position.ticker in fetchHoldings)

  // Counts per tier for the filter badges. Filtering itself is client-side
  // (TierFilter toggles .hidden on each card via data-tier).
  const tierCounts: Record<Tier, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (const f of filers) {
    const t = (filerInfo(f.cik)?.signalTier ?? "B") as Tier;
    tierCounts[t] = (tierCounts[t] ?? 0) + 1;
  }

  if (filers.length === 0) {
    return (
      <Empty className="py-24">
        <EmptyHeader>
          <EmptyTitle>No parsed 13F positions yet</EmptyTitle>
          <EmptyDescription>
            Run <code className="font-mono text-xs">python -m ingest.parse_13f</code> to populate.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Holdings"
        description="Each tracked filer's latest 13F: their 10 largest positions, plus what they bought and sold versus the prior quarter. Newest filings first. The gap between “period” and “filed” is the legal disclosure delay."
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{filers.length}</span> filers
            </span>
            <span>
              <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span> position rows
            </span>
            <ThirteenFDelayNote />
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TierFilter counts={tierCounts} />
        <ColumnGuide />
      </div>

      <Empty id="tier-filter-empty" className="hidden border py-16">
        <EmptyHeader>
          <EmptyTitle>No filers match the selected tiers</EmptyTitle>
          <EmptyDescription>Turn a tier back on to see its filers.</EmptyDescription>
        </EmptyHeader>
      </Empty>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {filers.map((f) => {
          const info = filerInfo(f.cik);
          const t = tier(f.cik);
          const signalTier = info?.signalTier ?? "B";
          const daysSinceFile = f.latestFiledAt
            ? Math.floor((Date.now() - new Date(f.latestFiledAt).getTime()) / 86_400_000)
            : null;
          const fp = perf[f.cik];
          const fmtPerf = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`);

          return (
            <Card key={f.cik} data-tier={signalTier} className="relative gap-3 pb-0">
              {t > 0 && (
                <span
                  className={cn("absolute inset-y-0 left-0 w-0.5", t === 2 ? "bg-warning" : "bg-info")}
                  aria-hidden
                />
              )}
              <CardHeader>
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <TierBadge tier={signalTier} />
                  <span className="truncate" title={f.name}>{info?.entity ?? f.name}</span>
                </CardTitle>
                {(info?.manager || info?.badge) && (
                  <CardDescription className="truncate text-xs">
                    {[info?.manager, info?.badge].filter(Boolean).join(" · ")}
                  </CardDescription>
                )}
                <CardAction className="text-right">
                  <div className={cn("text-xs tabular-nums", recencyTone(daysSinceFile))}>
                    filed {daysSinceFile != null ? daysAgo(f.latestFiledAt) : "?"}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    period {f.latestPeriod}
                  </div>
                </CardAction>
              </CardHeader>

              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 text-xs text-muted-foreground">
                <span>
                  <span className="text-foreground tabular-nums">{fmtUsd(f.totalValue)}</span> across{" "}
                  <span className="text-foreground tabular-nums">{f.totalPositions}</span> positions
                </span>
                {fp && (fp.oneY != null || fp.threeY != null) && (
                  <Hint
                    label={
                      <span className="tabular-nums">
                        13F book 1Y <span className={perfTone(fp.oneY)}>{fmtPerf(fp.oneY)}</span>
                        {" · "}3Y <span className={perfTone(fp.threeY)}>{fmtPerf(fp.threeY)}</span>
                      </span>
                    }
                  >
                    {"13F-clone return: what mirroring this filer's disclosed long book at period-start prices and holding to today would have returned.\n\nNOT the fund's actual return — 13F omits shorts, cash, options and non-US holdings."}
                  </Hint>
                )}
              </div>

              <FilerCardTabs
                changesCount={f.news.length + f.adds.length}
                soldCount={f.trims.length + f.exits.length}
                current={
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="h-8 pl-4">Issuer</TableHead>
                        <TableHead className="h-8 text-right">Value</TableHead>
                        <TableHead className="h-8 text-right">% port</TableHead>
                        <TableHead className="h-8 text-right">Now</TableHead>
                        <TableHead className="h-8 text-right">Est. cost</TableHead>
                        <TableHead className="h-8 text-right">P&amp;L</TableHead>
                        <TableHead className="h-8 pr-4 text-right">Δ sh</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {f.positions.map((h, i) => {
                        const pct = f.totalValue > 0 && h.value_usd != null ? (h.value_usd / f.totalValue) * 100 : null;
                        const markPrice = h.value_usd != null && h.shares && h.shares > 0 ? h.value_usd / h.shares : null;
                        const nowPrice = h.ticker ? prices[h.ticker] ?? null : null;
                        // Estimated cost basis from filer_position_cost (proxy via per-quarter VWAP)
                        const costEst = h.ticker ? costs[`${f.cik}|${h.ticker}`] : undefined;
                        const estCost = costEst?.estimated_cost_basis ?? null;
                        const vsCostPct = nowPrice != null && estCost != null && estCost > 0
                          ? ((nowPrice - estCost) / estCost) * 100
                          : null;
                        // Δ shares vs prior 13F: NEW, +X% add, -X% trim, blank if within ±5%.
                        const prev = f.priorByCusip.get(normIssuer(h.issuer_name));
                        let qDiff: { label: string; cls: string } | null = null;
                        if (f.priorPeriod) {
                          if (!prev) {
                            qDiff = { label: "NEW", cls: "font-medium text-positive" };
                          } else {
                            const a = prev.shares ?? 0;
                            const b = h.shares ?? 0;
                            if (a > 0) {
                              const ratio = (b - a) / a;
                              if (ratio >= 0.05) qDiff = { label: fmtPctCompact(ratio * 100), cls: cn("text-positive", ratio >= 0.5 && "font-medium") };
                              else if (ratio <= -0.05) qDiff = { label: fmtPctCompact(ratio * 100), cls: cn("text-negative", ratio <= -0.5 && "font-medium") };
                            }
                          }
                        }
                        return (
                          <TableRow key={`${h.cusip}-${i}`}>
                            <TableCell className={cn(cell, "max-w-40 pl-4")}>
                              <div className="flex flex-col leading-tight">
                                <span className="truncate" title={`${h.issuer_name ?? ""} — CUSIP ${h.cusip}`}>{h.issuer_name ?? "—"}</span>
                                <span className="font-mono text-[10px] text-muted-foreground">
                                  {h.ticker ?? ""}{h.ticker ? " · " : ""}{fmtShares(h.shares)} sh
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className={cn(cell, "text-right")}>
                              <div className="flex flex-col leading-tight tabular-nums">
                                <span>{fmtUsd(h.value_usd)}</span>
                                <span className="font-mono text-[10px] text-muted-foreground" title="Quarter-end mark per share — NOT the filer's entry price">
                                  {markPrice != null ? `$${markPrice.toFixed(2)}/sh` : ""}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className={cn(cell, "text-right tabular-nums", pct != null && pct >= 10 ? "font-medium text-foreground" : "text-muted-foreground")}>
                              {pct != null ? `${pct.toFixed(1)}%` : "—"}
                            </TableCell>
                            <TableCell className={cn(cell, "text-right tabular-nums")}>
                              {nowPrice != null ? `$${nowPrice.toFixed(2)}` : "—"}
                            </TableCell>
                            <TableCell
                              className={cn(cell, "text-right text-muted-foreground tabular-nums")}
                              title={costEst ? `Estimated from per-quarter VWAP, accumulating since ${costEst.first_seen_period}. Proxy — typically ±15-25% off true cost.` : "No cost-basis estimate yet (no usable VWAP)."}
                            >
                              {estCost != null ? `$${estCost.toFixed(2)}` : "—"}
                            </TableCell>
                            <TableCell className={cn(cell, "text-right tabular-nums", vsCostPct == null ? "text-muted-foreground" : vsCostPct >= 0 ? "text-positive" : "text-negative")}>
                              {vsCostPct != null ? fmtPctCompact(vsCostPct) : "—"}
                            </TableCell>
                            <TableCell
                              className={cn(cell, "pr-4 text-right tabular-nums", qDiff?.cls ?? "text-muted-foreground")}
                              title={f.priorPeriod ? `vs prior 13F (period ${f.priorPeriod}): prev shares ${(prev?.shares ?? 0).toLocaleString()}` : "no prior 13F to compare"}
                            >
                              {qDiff?.label ?? "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                }
                changes={<BoughtView f={f} />}
                sold={<SoldView f={f} />}
              />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
