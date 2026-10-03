import { ArrowRightIcon, LineChartIcon } from "lucide-react";
import { Pct } from "@/components/app/cells";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { ActualTrades } from "@/components/app/mag7/actual-trades";
import { EquityChart } from "@/components/app/mag7/equity-chart";
import { ReturnsChart } from "@/components/app/mag7/returns-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtSharesExact, fmtUsdExact } from "@/lib/format";
import type { Mag7Data } from "@/lib/mag7";
import { START_CAPITAL, actualSleeve, proposedOrders } from "@/lib/mag7-math";

const HISTORY_ROWS = 24;

const ACTION_BADGE = {
  initial: { variant: "info", label: "first buy" },
  switch: { variant: "info", label: "switch" },
  hold: { variant: "muted", label: "hold" },
} as const;

function RankedPct({ value, rank }: { value: number | null; rank: number | null }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <Pct value={value} fraction />
      {rank != null && <span className="text-xs text-muted-foreground tabular-nums">#{rank}</span>}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

// Personal strategy tracker — CLAUDE.md §2.2 exception. Tracks and recommends;
// never executes. Model sleeve + backtest come from ingest/mag7.py; "your
// trades" are fills typed in by hand.
export function Mag7Sleeve({ data, editable }: { data: Mag7Data | null; editable: boolean }) {
  if (!data || data.signals.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Lag7" description="A personal strategy tracker for a $100,000 laggard sleeve across the Mag7 and SpaceX." />
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LineChartIcon />
            </EmptyMedia>
            <EmptyTitle>Mag7 sleeve not set up yet</EmptyTitle>
            <EmptyDescription>
              {data
                ? "No month-end signal has been computed yet. The daily job writes one after each month's last close."
                : "Apply migration 030, then run python -m ingest.mag7 once to backfill the history."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const { signals, ranks, equity, actual } = data;
  const latest = signals.at(-1)!;
  const lastEq = equity.at(-1);
  const closes = lastEq?.closes ?? {};
  const firstTrade = signals.find((s) => s.trade_date)?.trade_date;
  const switches = signals.filter((s) => s.action === "switch").length;
  const liveFrom = signals.find((s) => s.source === "live")?.signal_date;
  const equityByDate = new Map(equity.map((e) => [e.date, e]));

  const sleeve = actualSleeve(actual);
  const holdings = Object.entries(sleeve.shares).map(([t, n]) => ({ t, n, value: n * (closes[t] ?? 0) }));
  const yourValue = holdings.reduce((s, h) => s + h.value, 0) + sleeve.cash;
  const orders = proposedOrders(sleeve, latest.selected, closes);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Lag7"
        description={
          <>
            A personal strategy tracker for a $100,000 laggard sleeve across the Mag7 and SpaceX. At each month-end
            close, they are ranked on 3-, 6- and 12-month total return (#1 = highest). The pick is the
            <strong className="font-medium text-foreground">{" worst average rank"}</strong>
            {" (tie → lower return on the longest horizon each has). On the next trading day the sleeve switches into"}
            {" it, or holds if it’s unchanged. This page tracks and recommends. It never trades."}
          </>
        }
        meta={
          <>
            <span>Latest signal {latest.signal_date}</span>
            <Badge variant="muted">{latest.source}</Badge>
            {lastEq && <span>Prices through {lastEq.date}</span>}
            <span>Next signal: after the close on this month&rsquo;s last trading day</span>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardDescription>This month&rsquo;s pick</CardDescription>
            <CardTitle className="font-mono text-3xl">{latest.selected}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {latest.action == null ? (
              <>
                Signal from the {latest.signal_date} close. Rebalance on the next trading day; the model fills at that
                day&rsquo;s close.
              </>
            ) : (
              <>
                Model {ACTION_BADGE[latest.action].label} on {latest.trade_date}.
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Recommended orders for your sleeve</CardDescription>
            <CardTitle className="text-base">
              {orders.length === 0 ? `Hold ${latest.selected}. No trade.` : "To match this month's pick"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {orders.length > 0 && (
              <ol className="flex flex-col gap-1.5">
                {orders.map((o) => (
                  <li key={o.side + o.ticker} className="flex items-center gap-2">
                    <Badge variant={o.side === "buy" ? "positive" : "negative"}>{o.side}</Badge>
                    <span className="font-mono">{fmtSharesExact(o.shares)}</span>
                    <span className="font-mono">{o.ticker}</span>
                    <ArrowRightIcon className="size-3 text-muted-foreground" />
                    <span className="tabular-nums">≈ {fmtUsdExact(o.estAmount)}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="text-xs text-muted-foreground">
              Built from your ledger below: only shares this strategy bought are counted, so anything else you hold in
              Robinhood — even the same ticker — is never sold. Sizes use the last close; your fill will differ.
            </p>
          </CardContent>
        </Card>
      </div>

      <TableCard
        title="Month-end ranking"
        description={`Signal date ${latest.signal_date}. Return, then its rank among the stocks that have that return (#1 = highest). SpaceX listed 2026-06-12, so it has no 6- or 12-month return yet; its average uses only what it has. Sorted in the rule's order: worst average rank first, which is the pick.`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Ticker</TableHead>
              <TableHead className="text-right">3-month</TableHead>
              <TableHead className="text-right">6-month</TableHead>
              <TableHead className="text-right">12-month</TableHead>
              <TableHead className="pr-6 text-right">Avg rank</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ranks.map((r) => (
              <TableRow key={r.ticker}>
                <TableCell className="pl-6">
                  <span className="font-mono">{r.ticker}</span>
                  {r.ticker === latest.selected && (
                    <Badge variant="outline" className="ml-2">
                      pick
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <RankedPct value={r.ret_3m} rank={r.rank_3m} />
                </TableCell>
                <TableCell className="text-right">
                  <RankedPct value={r.ret_6m} rank={r.rank_6m} />
                </TableCell>
                <TableCell className="text-right">
                  <RankedPct value={r.ret_12m} rank={r.rank_12m} />
                </TableCell>
                <TableCell className="pr-6 text-right font-medium tabular-nums">{r.avg_rank.toFixed(2)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="px-6 pt-4">
          <ReturnsChart data={ranks} />
        </div>
      </TableCard>

      <Card>
        <CardHeader>
          <CardTitle>Model sleeve vs doing nothing</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            $100,000 into each line on {firstTrade}. Values at each month-end, plus the latest close. Model fills are
            pretend fills at the close, with no taxes, fees or slippage.
            {liveFrom ? ` Months before ${liveFrom} are a backtest.` : " Every month shown is a backtest."}{" "}
            <strong className="font-medium text-foreground">
              The seven were named &ldquo;Magnificent 7&rdquo; in 2023, before this history starts, so the stock list
              isn&rsquo;t picked with hindsight. The rule itself was still chosen in 2026, after these months happened.
            </strong>
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {lastEq && (
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <Fact label="Model sleeve">{fmtUsdExact(lastEq.strategy)}</Fact>
              <Fact label="All seven, equal & held">{fmtUsdExact(lastEq.equal_weight)}</Fact>
              <Fact label="S&P 500 (total return)">{fmtUsdExact(lastEq.sp500)}</Fact>
              <Fact label="Switches">
                {switches} in {signals.filter((s) => s.action).length} months
              </Fact>
            </div>
          )}
          <EquityChart
            data={
              firstTrade
                ? [{ date: firstTrade, strategy: START_CAPITAL, equal_weight: START_CAPITAL, sp500: START_CAPITAL }, ...equity]
                : equity
            }
          />
        </CardContent>
      </Card>

      <TableCard
        title="Your sleeve (real trades)"
        description={`Your own Robinhood fills, entered by hand. Starts at ${fmtUsdExact(START_CAPITAL)}; sells only shares this ledger bought; never adds money.`}
      >
        <div className="flex flex-wrap gap-x-8 gap-y-3 px-6 pb-4">
          <Fact label="Value at last close">{fmtUsdExact(yourValue)}</Fact>
          <Fact label="Cash in sleeve">{fmtUsdExact(sleeve.cash)}</Fact>
          {holdings.map((h) => (
            <Fact key={h.t} label={`${h.t} · ${fmtSharesExact(h.n)} sh`}>
              {fmtUsdExact(h.value)}
            </Fact>
          ))}
        </div>
        <ActualTrades trades={actual} editable={editable} />
      </TableCard>

      <TableCard
        title="Signal history"
        description={`Latest ${Math.min(HISTORY_ROWS, signals.length)} of ${signals.length} month-ends. Frozen when written — later price revisions never change a past row.`}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Signal</TableHead>
              <TableHead>Pick</TableHead>
              <TableHead>Model action</TableHead>
              <TableHead>Trade date</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="pr-6 text-right">Model value at signal</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {signals
              .slice(-HISTORY_ROWS)
              .reverse()
              .map((s) => (
                <TableRow key={s.signal_date}>
                  <TableCell className="pl-6 font-mono text-xs">{s.signal_date}</TableCell>
                  <TableCell className="font-mono">{s.selected}</TableCell>
                  <TableCell>
                    {s.action ? (
                      <Badge variant={ACTION_BADGE[s.action].variant}>{ACTION_BADGE[s.action].label}</Badge>
                    ) : (
                      <span className="text-muted-foreground">pending</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{s.trade_date ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{s.source}</TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">
                    {fmtUsdExact(equityByDate.get(s.signal_date)?.strategy)}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </TableCard>

      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        <li>
          SpaceX is ranked on the returns it has: 3-month now, 6-month from the 2026-12-31 signal, 12-month from
          2027-06-30. Ranks run 1–8 where it is ranked and 1–7 where it isn&rsquo;t, so if it is last on its only
          return it scores 8.0, above a stock last on all three (7.33).
        </li>
        <li>
          Laggard rule: the pick is the stock that has done worst. Nothing here checks why it fell — read the news and
          filings yourself.
        </li>
        <li>Past returns, backtested or live, do not predict future ones.</li>
        <li>Total return: dividends are included through adjusted closes.</li>
      </ul>
    </div>
  );
}
