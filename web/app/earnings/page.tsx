import { Fragment } from "react";
import { supabaseServer } from "@/lib/supabase";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { Pct, Ticker } from "@/components/app/cells";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

// Earnings: upcoming earnings dates for large-caps + tracked-filer holdings,
// soonest first, with trailing 1w / 1m return context. Sorted by DATE, not
// return — a calendar, not a momentum leaderboard (CLAUDE.md §2.2).

type Row = {
  ticker: string;
  name: string | null;
  next_earnings: string | null;
  return_1w: number | null;
  return_1m: number | null;
  in_smart_money: boolean;
};

async function fetchRows(): Promise<Row[]> {
  const sb = supabaseServer();
  const out: Row[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("earnings_calendar")
      .select("ticker,name,next_earnings,return_1w,return_1m,in_smart_money")
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as Row[]));
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function daysUntil(iso: string): string {
  const d = Math.ceil((new Date(iso + "T00:00:00").getTime() - Date.now()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 14) return `in ${d}d`;
  return `in ${Math.round(d / 7)}w`;
}

// Group consecutive rows by report date so the list reads like a calendar.
function groupByDate(rows: Row[]): [string, Row[]][] {
  const out: [string, Row[]][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0] === r.next_earnings) last[1].push(r);
    else out.push([r.next_earnings!, [r]]);
  }
  return out;
}

export default async function EarningsPage() {
  const rows = await fetchRows();
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = rows
    .filter((r) => r.next_earnings && r.next_earnings >= today)
    .sort((a, b) => a.next_earnings!.localeCompare(b.next_earnings!));
  const days = groupByDate(upcoming);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Earnings"
        description="Upcoming report dates for large caps (> $10B) and every stock a tracked filer holds, soonest first. Trailing returns are context only — the list is ordered by date, never by performance."
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{upcoming.length}</span> upcoming
            </span>
            <span className="flex items-center gap-1.5">
              <Badge variant="warning" className="h-4 rounded-sm px-1 text-[10px]">SM</Badge>
              held by a tracked filer
            </span>
            <span>Dates are Yahoo estimates and can shift a day or two until confirmed.</span>
          </>
        }
      />

      <TableCard title="Calendar">
        {upcoming.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyTitle>No upcoming earnings loaded</EmptyTitle>
              <EmptyDescription>The ingester may still be populating — refresh in a few minutes.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Stock</TableHead>
                <TableHead className="text-right">1W return</TableHead>
                <TableHead className="pr-6 text-right">1M return</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map(([date, items]) => (
                <Fragment key={date}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={3} className="py-1.5 pl-6">
                      <span className="text-xs font-medium">{fmtDate(date)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {daysUntil(date)} · {items.length} report{items.length === 1 ? "" : "s"}
                      </span>
                    </TableCell>
                  </TableRow>
                  {items.map((r) => (
                    <TableRow key={r.ticker}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-2">
                          <Ticker className="w-14 text-sm">{r.ticker}</Ticker>
                          <span className="max-w-80 truncate text-muted-foreground">{r.name}</span>
                          {r.in_smart_money && (
                            <Badge variant="warning" className="h-4 rounded-sm px-1 text-[10px]" title="Held by a tracked filer">
                              SM
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right"><Pct value={r.return_1w} fraction /></TableCell>
                      <TableCell className="pr-6 text-right"><Pct value={r.return_1m} fraction /></TableCell>
                    </TableRow>
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}
