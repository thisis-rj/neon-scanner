import Link from "next/link";
import { supabaseServer } from "@/lib/supabase";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtUsd } from "@/lib/format";

export const dynamic = "force-dynamic";

// Daily report built by ingest/daily_report.py; the WhatsApp "Open full report"
// button links here as /report/<YYYY-MM-DD>-<person>.
type Filing = { ticker: string; form: string; filed: string; label: string; what: string; level: string; url: string; summary: string | null };
type Insider = { side: "buy" | "sell"; ticker: string; name: string; role: string; date: string; usd: number };
type Rating = { ticker: string; firm: string; kind: string; grade: string; target: string; at: string };
type Earn = { ticker: string; name: string | null; date: string };
type Content = {
  person: string;
  date: string;
  window_start: string;
  tickers: string[];
  market: { asof: string | null; rows: { label: string; symbol: string; last: number; change: string; delta?: number; line?: string }[] };
  filings: Filing[];
  insider: Insider[];
  ratings: Rating[];
  earnings: Earn[];
};

const nice = (iso: string) =>
  new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function Section({ title, children, empty }: { title: string; children: React.ReactNode; empty?: string | false }) {
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</CardTitle>
      </CardHeader>
      <CardContent>{empty ? <p className="text-sm text-muted-foreground">{empty}</p> : children}</CardContent>
    </Card>
  );
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = id.match(/^(\d{4}-\d{2}-\d{2})-([a-z]+)$/);
  const person = m ? m[2][0].toUpperCase() + m[2].slice(1) : null;
  const { data } = m
    ? await supabaseServer().from("daily_reports").select("content,built_at").eq("person", person).eq("report_date", m[1]).maybeSingle()
    : { data: null };
  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Daily report" description="No report found for this link." />
        <Link href="/my-stocks" className="text-sm text-primary underline-offset-4 hover:underline">
          Go to My Stocks
        </Link>
      </div>
    );
  }
  const c = data.content as Content;
  const byTicker = new Map<string, Rating[]>();
  for (const r of c.ratings) byTicker.set(r.ticker, [...(byTicker.get(r.ticker) ?? []), r]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={`${c.person}'s daily report · ${nice(c.date)}`}
        description={`New since ${new Date(c.window_start).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} IST · ${c.tickers.length} stocks: ${c.tickers.join(", ")}`}
      />

      <Section title="Company news (SEC filings)" empty={c.filings.length === 0 && "No new filings on your stocks."}>
        <ul className="flex flex-col divide-y divide-border text-sm">
          {c.filings.map((f, i) => (
            <li key={i} className="flex flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-medium">{f.ticker}</span>
                {f.level === "high" ? <Badge variant="warning">{f.label}</Badge> : <Badge variant="outline">{f.label}</Badge>}
                <span className="text-xs text-muted-foreground">
                  {f.form} · {nice(f.filed)}
                </span>
                <a href={f.url} target="_blank" rel="noreferrer" className="ml-auto text-xs text-primary underline-offset-4 hover:underline">
                  Filing ↗
                </a>
              </div>
              <p className="text-muted-foreground">{f.summary ?? f.what}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Market${c.market.asof ? ` · ${nice(c.market.asof)}` : ""}`} empty={c.market.rows.length === 0 && "Market data unavailable."}>
        <ul className="flex flex-col gap-1.5 text-sm">
          {c.market.rows.map((r) => {
            const d = r.delta ?? 0;
            const inverse = r.symbol === "^TNX" || r.symbol === "^VIX"; // up is bad for stocks
            return (
              <li key={r.label} className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className={`inline-block size-2 shrink-0 translate-y-[-1px] rounded-full ${d > 0 ? "bg-positive" : d < 0 ? "bg-negative" : "bg-muted-foreground"}`}
                />
                <span className="w-56 shrink-0 text-muted-foreground">
                  {r.label}
                  {inverse && <span className="text-[11px]"> · up is bad for stocks</span>}
                </span>
                <span className="font-mono tabular-nums">{(r.line ?? r.change).replace(/^[🟢🔴⚪]\s*/u, "")}</span>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Insider trades (non-routine)" empty={c.insider.length === 0 && "None on your stocks. Planned (10b5-1) sales are left out."}>
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Stock</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Date</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.insider.map((x, i) => (
              <TableRow key={i}>
                <TableCell className="font-mono font-medium">{x.ticker}</TableCell>
                <TableCell>{x.name}</TableCell>
                <TableCell className="text-muted-foreground">{x.role}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{x.date}</TableCell>
                <TableCell className={`text-right tabular-nums ${x.side === "buy" ? "text-positive" : "text-negative"}`}>
                  {x.side === "buy" ? "Bought " : "Sold "}
                  {fmtUsd(x.usd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Short-seller reports" empty="Not connected yet." >
        {null}
      </Section>

      <Section title="Analyst rating changes" empty={c.ratings.length === 0 && "No changes on your stocks."}>
        <div className="flex flex-col gap-4">
          {[...byTicker.entries()].map(([t, rs]) => (
            <div key={t} className="flex flex-col gap-1">
              <span className="font-mono text-sm font-medium">{t}</span>
              <Table className="text-xs">
                <TableBody>
                  {rs.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="w-40">{r.firm}</TableCell>
                      <TableCell>
                        <Badge variant={r.kind === "downgrade" ? "negative" : r.kind === "upgrade" ? "positive" : "outline"} className="font-normal">
                          {r.kind}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.grade}</TableCell>
                      <TableCell className="text-muted-foreground">{r.target}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">{r.at}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Earnings in the next 2 weeks" empty={c.earnings.length === 0 && "None."}>
        <ul className="flex flex-col gap-1 text-sm">
          {c.earnings.map((e) => (
            <li key={e.ticker} className="flex gap-3">
              <span className="w-28 text-muted-foreground tabular-nums">{nice(e.date)}</span>
              <span className="font-mono font-medium">{e.ticker}</span>
              <span className="text-muted-foreground">{e.name}</span>
            </li>
          ))}
        </ul>
      </Section>
      <p className="text-[11px] text-muted-foreground">
        Built {new Date(data.built_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })} IST from SEC filings, Yahoo prices and rating changes, and the scanner&apos;s insider data. Not investment advice.
      </p>
    </div>
  );
}
