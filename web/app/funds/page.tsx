import Link from "next/link";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { cn } from "cn";
import { getWatchlist } from "@/lib/watchlist";
import { fmtUsd } from "@/lib/format";
import { filerShortLabel } from "@/lib/filers";
import { fetchFundFlows } from "@/lib/fund-flows";
import {
  CATEGORIES,
  LABEL_RULE_TEXT,
  applyFilters,
  label,
  parseParams,
  quarterCoverage,
  quarterName,
  rollup,
  sortQuery,
  sortRollup,
  sortRows,
  toQuery,
  type Filters,
  type FlowRow,
  type FundDetail,
  type Label,
  type Params,
  type RollupSort,
  type StockSort,
} from "@/lib/fund-flow-rules";
import { WatchlistToggle } from "@/components/WatchlistToggle";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { SortableHead } from "@/components/app/sortable-head";
import { Hint, Pct, SecLink, ThirteenFDelayNote, Ticker, TierBadge, type Tier } from "@/components/app/cells";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label as FieldLabel } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// /funds — which stocks the tracked funds are buying or leaving, by industry.
// Every number is a count of named 13F changes (opened / added / trimmed /
// exited, ≥10% split-adjusted) from fund_flows() (migration 027); the label is
// a printed threshold rule over those counts (§2.4). Sells sit in the same list
// with the same prominence as buys (§2.3).
export const dynamic = "force-dynamic";

const MAX_STOCK_ROWS = 300;

const LABEL_VARIANT: Record<Label, "positive" | "info" | "muted" | "negative"> = {
  Strong: "positive",
  Moderate: "info",
  Weak: "muted",
  "Net selling": "negative",
};

const EVENT_TEXT: Record<FundDetail["event"], string> = {
  opened: "opened",
  added: "added",
  trimmed: "trimmed",
  exited: "exited",
};

export default async function FundsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const f = parseParams(await searchParams);
  const [result, watchlist] = await Promise.all([fetchFundFlows(f), getWatchlist()]);

  if (result.status === "not_computed") {
    return (
      <div className="flex flex-col gap-8">
        <Header f={f} />
        <Card>
          <CardContent>
            <Empty className="py-16">
              <EmptyHeader>
                <EmptyTitle>Fund flows haven&apos;t been computed yet</EmptyTitle>
                <EmptyDescription>
                  The nightly job creates this data after migration 027 is applied (
                  <code className="font-mono text-xs">python -m ingest.migrate</code>, then{" "}
                  <code className="font-mono text-xs">python -m ingest.compute_fund_flows</code>).
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      </div>
    );
  }

  const all = result.rows;
  const rows = applyFilters(all, f, watchlist);
  const coverage = quarterCoverage(all);
  const computedAt = all.reduce<string | null>((m, r) => (r.computed_at && (!m || r.computed_at > m) ? r.computed_at : m), null);

  return (
    <div className="flex flex-col gap-8">
      <Header
        f={f}
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{all.length.toLocaleString()}</span> stocks with
              fund changes
            </span>
            {coverage.length > 0 && (
              <span>
                Funds&apos; newest filings:{" "}
                {coverage.map((c, i) => (
                  <span key={c.period}>
                    {i > 0 && " · "}
                    <span className="text-foreground">{quarterName(c.period)}</span> ({c.funds} funds)
                  </span>
                ))}
              </span>
            )}
            {computedAt && <span>computed {new Date(computedAt).toLocaleString()}</span>}
            <ThirteenFDelayNote />
          </>
        }
      />

      <FilterForm f={f} />

      {f.view === "industries" ? (
        <IndustryTable f={f} rows={rows} />
      ) : (
        <StockTable f={f} rows={rows} watchlist={watchlist} />
      )}

      <Footnotes />
    </div>
  );
}

function Header({ f, meta }: { f: Filters; meta?: React.ReactNode }) {
  return (
    <PageHeader
      title="Funds"
      description={
        <>
          What the tracked funds did in their latest 13F, stock by stock: who{" "}
          <span className="text-positive">opened or added</span> (≥10%) and who{" "}
          <span className="text-negative">trimmed or exited</span>. Grouped by industry. Each fund is compared with
          its own previous filing{f.lag === 2 ? " — here, with the filing two quarters back" : ""}. Counts only, no
          forecast: read the filings and decide.
        </>
      }
      meta={meta}
    />
  );
}

// ─── Filters ──────────────────────────────────────────────────────────────

function FilterForm({ f }: { f: Filters }) {
  const tierValue = f.tiers ? f.tiers.join(",") : "all";
  return (
    <Card size="sm">
      <CardContent>
        <form method="get" className="flex flex-col gap-3">
          {f.industry && <input type="hidden" name="industry" value={f.industry} />}
          {f.view === "stocks" && !f.industry && <input type="hidden" name="view" value="stocks" />}
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <Field label="Count funds" htmlFor="tier">
              <Select name="tier" defaultValue={["all", "S,A", "S"].includes(tierValue) ? tierValue : "all"}>
                <SelectTrigger id="tier" className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All tiers</SelectItem>
                    <SelectItem value="S,A">S + A tier</SelectItem>
                    <SelectItem value="S">S tier only</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Fund style" htmlFor="style">
              <Select name="style" defaultValue={f.categories?.length === 1 ? f.categories[0] : "all"}>
                <SelectTrigger id="style" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All styles</SelectItem>
                    {CATEGORIES.filter((c) => c !== "corporate_strategic").map((c) => (
                      <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Compare with" htmlFor="quarters">
              <Select name="quarters" defaultValue={String(f.lag)}>
                <SelectTrigger id="quarters" className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="1">Previous filing</SelectItem>
                    <SelectItem value="2">Two filings back</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Label" htmlFor="label">
              <Select name="label" defaultValue={f.label ?? "all"}>
                <SelectTrigger id="label" className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Any</SelectItem>
                    {LABEL_RULE_TEXT.map((l) => <SelectItem key={l.label} value={l.label}>{l.label}</SelectItem>)}
                    <SelectItem value="none">No label</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Min net funds" htmlFor="min_net">
              <Input id="min_net" name="min_net" type="number" step="1" defaultValue={f.minNet ?? ""} className="w-24 tabular-nums" />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
            <Field label="Mkt cap ($M)" htmlFor="cap_min">
              <div className="flex items-center gap-1.5">
                <Input id="cap_min" name="cap_min" type="number" min="0" placeholder="min" defaultValue={f.capMinM ?? ""} className="w-24 tabular-nums" />
                <span className="text-muted-foreground">–</span>
                <Input name="cap_max" type="number" min="0" placeholder="max" aria-label="Max market cap ($M)" defaultValue={f.capMaxM ?? ""} className="w-24 tabular-nums" />
              </div>
            </Field>
            <Field label="Min avg $ volume ($M/day)" htmlFor="vol_min">
              <Input id="vol_min" name="vol_min" type="number" min="0" defaultValue={f.volMinM ?? ""} className="w-28 tabular-nums" />
            </Field>
            <Field label="6M return (%)" htmlFor="ret6_min">
              <div className="flex items-center gap-1.5">
                <Input id="ret6_min" name="ret6_min" type="number" placeholder="min" defaultValue={f.ret6MinPct ?? ""} className="w-20 tabular-nums" />
                <span className="text-muted-foreground">–</span>
                <Input name="ret6_max" type="number" placeholder="max" aria-label="Max 6-month return (%)" defaultValue={f.ret6MaxPct ?? ""} className="w-20 tabular-nums" />
              </div>
            </Field>
            <label className="flex h-8 items-center gap-2 text-sm">
              <input type="checkbox" name="watch" value="1" defaultChecked={f.watchlist} className="size-4 accent-primary" />
              Watchlist only
            </label>
            <div className="flex items-center gap-2 md:ml-auto">
              <Button asChild variant="ghost" size="sm"><Link href="/funds">Reset</Link></Button>
              <Button type="submit">Apply</Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label: text, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel htmlFor={htmlFor} className="text-xs text-muted-foreground">{text}</FieldLabel>
      {children}
    </div>
  );
}

// ─── Industry rollup (first view) ─────────────────────────────────────────

function IndustryTable({ f, rows }: { f: Filters; rows: FlowRow[] }) {
  const industries = sortRollup(rollup(rows), f.sort as RollupSort, f.dir);
  const head = (key: RollupSort, text: string, align: "left" | "right" = "right", title?: string) => (
    <SortableHead href={`/funds${sortQuery(f, key)}`} active={f.sort === key} dir={f.dir} align={align} title={title}>
      {text}
    </SortableHead>
  );
  return (
    <TableCard
      title="Industries"
      description="Each row adds up one industry's stocks. Counts, not dollars, so one mega-cap can't dominate. Click an industry to see its stocks."
      action={
        <Button asChild variant="outline" size="sm">
          <Link href={`/funds${toQuery(f, { view: "stocks", sort: null, dir: null })}`}>
            All stocks <ArrowRightIcon data-icon="inline-end" />
          </Link>
        </Button>
      }
    >
      {industries.length === 0 ? (
        <NoMatches />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {head("industry", "Industry", "left")}
              <TableHead>Sector</TableHead>
              <TableHead className="text-right">Stocks</TableHead>
              {head("net_bought", "Net-bought", "right", "Stocks where more funds bought than sold")}
              {head("net_sold", "Net-sold", "right", "Stocks where more funds sold than bought")}
              {head("total_net", "Total net funds", "right", "Sum of (buying funds − selling funds) over the industry's stocks")}
              <TableHead className="pr-6">Top net-bought</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {industries.map((ind) => (
              <TableRow key={ind.industry}>
                <TableCell className="pl-3 font-medium">
                  <Link
                    href={`/funds${toQuery(f, { industry: ind.industry, view: null, sort: null, dir: null })}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {ind.industry}
                  </Link>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{ind.sector ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{ind.stocks}</TableCell>
                <TableCell className="text-right tabular-nums text-positive">{ind.netBought || "—"}</TableCell>
                <TableCell className="text-right tabular-nums text-negative">{ind.netSold || "—"}</TableCell>
                <TableCell className="text-right"><Signed value={ind.totalNet} /></TableCell>
                <TableCell className="pr-6">
                  <div className="flex gap-2">
                    {ind.top.length ? ind.top.map((t) => <Ticker key={t}>{t}</Ticker>) : <span className="text-muted-foreground/60">—</span>}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}

// ─── Stock list ───────────────────────────────────────────────────────────

function StockTable({ f, rows, watchlist }: { f: Filters; rows: FlowRow[]; watchlist: Set<string> }) {
  const sorted = sortRows(rows, f.sort as StockSort, f.dir);
  const shown = sorted.slice(0, MAX_STOCK_ROWS);
  const head = (key: StockSort, text: string, align: "left" | "right" = "left", title?: string) => (
    <SortableHead href={`/funds${sortQuery(f, key)}`} active={f.sort === key} dir={f.dir} align={align} title={title}>
      {text}
    </SortableHead>
  );
  return (
    <TableCard
      title={f.industry ?? "All stocks"}
      description={
        sorted.length > MAX_STOCK_ROWS
          ? `Showing the first ${MAX_STOCK_ROWS} of ${sorted.length.toLocaleString()} stocks in this order — narrow with the filters to see the rest.`
          : `${sorted.length.toLocaleString()} stocks. Click a column to sort; click again to flip.`
      }
      action={
        <Button asChild variant="outline" size="sm">
          <Link href={`/funds${toQuery(f, { industry: null, view: null, sort: null, dir: null })}`}>
            <ArrowLeftIcon data-icon="inline-start" /> All industries
          </Link>
        </Button>
      }
    >
      {shown.length === 0 ? (
        <NoMatches />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 pl-6"><span className="sr-only">Watchlist</span></TableHead>
              <TableHead>Stock</TableHead>
              {head("label", "Label")}
              {head("net", "Net funds", "right", "Funds buying (opened or added ≥10%) minus funds selling (trimmed ≥10% or exited)")}
              {head("tier_net", "Tier-wtd", "right", "Same count, each fund weighted by tier: S 1.5 · A 1.2 · B 1.0 · C 0.7")}
              {head("conviction_sum", "Conviction", "right", "Share of each buying fund's 13F book in this stock: Σ over buyers (largest single bet below)")}
              {head("streak", "Streak", "right", "Filings in a row, newest first, where more counted funds bought than sold")}
              {head("insiders", "Insiders", "right", "Distinct insiders buying in the open market, last 30 days")}
              {head("activist", "Activist", "left", "Initial 13D from a tracked filer, last 90 days")}
              {head("market_cap", "Mkt cap", "right")}
              {head("return_6m", "6M", "right", "Sorts least run-up first only (no momentum ranking, CLAUDE.md §2.2)")}
              <TableHead>Funds</TableHead>
              <TableHead className="pr-6 text-right">Filings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((r) => (
              <StockRow key={r.ticker} r={r} showIndustry={!f.industry} watched={watchlist.has(r.ticker)} />
            ))}
          </TableBody>
        </Table>
      )}
    </TableCard>
  );
}

function StockRow({ r, showIndustry, watched }: { r: FlowRow; showIndustry: boolean; watched: boolean }) {
  const l = label(r);
  return (
    <TableRow className={cn(r.net < 0 && "bg-negative/[0.03]")}>
      <TableCell className="pl-6">
        <WatchlistToggle ticker={r.ticker} initialAdded={watched} />
      </TableCell>
      <TableCell className="max-w-56">
        <div className="flex flex-col leading-tight">
          <Ticker className="text-sm">{r.ticker}</Ticker>
          <span className="truncate text-xs text-muted-foreground" title={r.name ?? ""}>{r.name ?? "—"}</span>
          {showIndustry && <span className="truncate text-[11px] text-muted-foreground/70">{r.industry ?? "Unclassified"}</span>}
        </div>
      </TableCell>
      <TableCell>
        {l ? <Badge variant={LABEL_VARIANT[l]}>{l}</Badge> : <span className="text-muted-foreground/60">—</span>}
      </TableCell>
      <TableCell className="text-right">
        <Hint label={<Signed value={r.net} className="text-base font-semibold" />}>
          {`opened ${r.opened} · added ${r.added}\ntrimmed ${r.trimmed} · exited ${r.exited}`}
        </Hint>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          <span className="text-positive">{r.buyers} buy</span> · <span className="text-negative">{r.sellers} sell</span>
        </div>
      </TableCell>
      <TableCell className="text-right"><Signed value={r.tier_net} decimals={1} /></TableCell>
      <TableCell className="text-right">
        {r.conviction_sum === null ? (
          <span className="text-muted-foreground/60">—</span>
        ) : (
          <div className="flex flex-col leading-tight tabular-nums">
            <span>Σ {fmtPct(r.conviction_sum)}</span>
            <span className="text-[11px] text-muted-foreground">
              max {fmtPct(r.conviction_max)} · {filerShortLabel(r.conviction_max_filer)}
            </span>
          </div>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{r.streak ? `${r.streak}Q` : <span className="text-muted-foreground/60">—</span>}</TableCell>
      <TableCell className="text-right tabular-nums">
        {r.insider_buyers ? (
          <Hint label={r.insider_buyers}>{r.insider_names.join("\n") || "Names not recorded"}</Hint>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </TableCell>
      <TableCell className="max-w-40">
        {r.activist_filers.length ? (
          <div className="flex flex-col leading-tight">
            <span className="truncate text-xs text-warning">{r.activist_filers.map((n) => filerShortLabel(n)).join(", ")}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{r.activist_latest}</span>
          </div>
        ) : (
          <span className="text-muted-foreground/60">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">{fmtUsd(r.market_cap_usd)}</TableCell>
      <TableCell className="text-right"><Pct value={r.return_6mo} fraction /></TableCell>
      <TableCell className="whitespace-normal">
        <FundList funds={r.funds} />
      </TableCell>
      <TableCell className="pr-6 text-right">
        <SecLink href={`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(r.ticker)}&type=&dateb=&owner=include&count=40`} />
      </TableCell>
    </TableRow>
  );
}

function FundList({ funds }: { funds: FundDetail[] }) {
  const lines = funds.map((d) => `${d.tier} · ${filerShortLabel(d.filer)} — ${fundChange(d)} (${quarterName(d.prev_period)} → ${quarterName(d.period)})`);
  return (
    <div className="flex min-w-48 flex-col gap-1">
      {funds.slice(0, 2).map((d) => (
        <div key={d.cik} className="flex items-center gap-1.5 text-xs">
          <TierBadge tier={(["S", "A", "B", "C"].includes(d.tier) ? d.tier : "B") as Tier} />
          <span className="truncate">{filerShortLabel(d.filer)}</span>
          <span className={cn("shrink-0", d.event === "opened" || d.event === "added" ? "text-positive" : "text-negative")}>
            {EVENT_TEXT[d.event]}
          </span>
        </div>
      ))}
      {funds.length > 0 && (
        <Hint label={<span className="text-[11px] text-muted-foreground">{funds.length > 2 ? `+${funds.length - 2} more · details` : "details"}</span>}>
          {lines.join("\n")}
        </Hint>
      )}
    </div>
  );
}

/** "added +35% of shares, 4.2% of book" — the split-adjusted change behind an event. */
function fundChange(d: FundDetail): string {
  const book = d.pct === null ? "" : `, ${fmtPct(d.pct)} of book`;
  if (d.event === "opened") return `opened${book}`;
  if (d.event === "exited") return `exited (was ${fmtPct(d.pct)} of book)`;
  const change = d.shares_prev && d.shares_cur ? d.shares_cur / (d.shares_prev * (d.split || 1)) - 1 : null;
  const split = d.split && d.split !== 1 ? `, split-adjusted ×${d.split}` : "";
  return `${d.event} ${change === null ? "" : `${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}% shares`}${split}${book}`;
}

// ─── Small pieces ─────────────────────────────────────────────────────────

function Signed({ value, decimals = 0, className }: { value: number; decimals?: number; className?: string }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted-foreground",
        className,
      )}
    >
      {value > 0 ? "+" : ""}
      {value.toFixed(decimals)}
    </span>
  );
}

function fmtPct(v: number | null): string {
  if (v === null) return "—";
  const p = v * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

function NoMatches() {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyTitle>No stocks match these filters — this is normal</EmptyTitle>
        <EmptyDescription>
          Most filters cut the list hard, and some quarters funds barely move. Loosen a filter to see weaker evidence.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function Footnotes() {
  return (
    <div className="flex max-w-4xl flex-col gap-2 text-xs leading-relaxed text-pretty text-muted-foreground">
      <p>
        <span className="text-foreground">Label rule</span> (a threshold over the counts, not a forecast):{" "}
        {LABEL_RULE_TEXT.map((l, i) => (
          <span key={l.label}>
            {i > 0 && " · "}
            <span className="text-foreground">{l.label}</span> = {l.rule}
          </span>
        ))}
        . Net 0 or −1 gets no label.
      </p>
      <p>
        Counts cover the tracked funds that file 13Fs. A fund is compared with its own previous filing, so early filers
        count the day they file; funds that stopped filing are left out. 13F shows US long equity only: a trim may be a
        hedge or a move elsewhere, and intent isn&apos;t visible. Share counts are adjusted for stock splits. Insider
        counts include every open-market buy. The Holdings page&apos;s Bought/Sold tabs use their own older comparison
        (matched by company name, not split-adjusted) and can differ.
      </p>
    </div>
  );
}
