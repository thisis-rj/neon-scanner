import { supabaseServer } from "@/lib/supabase";
import { fmtShares, fmtUsd } from "@/lib/format";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { DateCell, SecLink, Ticker } from "@/components/app/cells";
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

// Clusters: the universe-wide insider-buy signal (3+ insiders buying the same US
// company inside a 30-day window, NOT limited to tracked filers) plus notable
// insider sells (≥ $5M) for context. Renamed from the old "Events" page — the
// 13D/G and tracked-filer Form-4 rows now live on Filings, and 8-K corporate
// events moved to /corporate. Route kept as /events so existing links don't break.

type EventForm4 = {
  filing_id: string;
  reporter_cik: string | null;
  reporter_name: string | null;
  issuer_name: string | null;
  ticker: string | null;
  transaction_date: string;
  transaction_code: string;
  shares: number | null;
  price: number | null;
  primary_doc_url: string | null;
};

type ClusterRow = {
  issuer_cik: string;
  issuer_name: string | null;
  issuer_ticker: string | null;
  n_buyers: number;
  total_value: number;
  total_shares: number;
  earliest_date: string;
  latest_date: string;
  buyers: { name: string; date: string; shares: number; price: number; value: number; title: string | null }[];
};

async function fetchInsiderClusters(): Promise<ClusterRow[]> {
  const sb = supabaseServer();
  // Rolling 30-day window
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  type RawTx = {
    issuer_cik: string;
    issuer_name: string | null;
    issuer_ticker: string | null;
    reporter_cik: string | null;
    reporter_name: string | null;
    officer_title: string | null;
    transaction_date: string;
    shares: number | null;
    price: number | null;
    value_usd: number | null;
  };

  const all: RawTx[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("insider_transactions")
      .select(
        "issuer_cik,issuer_name,issuer_ticker,reporter_cik,reporter_name,officer_title,transaction_date,shares,price,value_usd",
      )
      .eq("transaction_code", "P")
      .gte("transaction_date", cutoff)
      .order("transaction_date", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as RawTx[]));
    if (data.length < 1000) break;
    from += 1000;
  }

  // Group by issuer
  const groups = new Map<string, RawTx[]>();
  for (const tx of all) {
    if (!groups.has(tx.issuer_cik)) groups.set(tx.issuer_cik, []);
    groups.get(tx.issuer_cik)!.push(tx);
  }

  const clusters: ClusterRow[] = [];
  for (const [cik, txs] of groups.entries()) {
    const buyerCiks = new Set(txs.map((t) => t.reporter_cik).filter(Boolean));
    if (buyerCiks.size < 3) continue;  // cluster threshold

    const totalValue = txs.reduce((s, t) => s + (t.value_usd ?? 0), 0);
    const totalShares = txs.reduce((s, t) => s + (t.shares ?? 0), 0);
    const dates = txs.map((t) => t.transaction_date).sort();
    clusters.push({
      issuer_cik: cik,
      issuer_name: txs[0].issuer_name,
      issuer_ticker: txs[0].issuer_ticker,
      n_buyers: buyerCiks.size,
      total_value: totalValue,
      total_shares: totalShares,
      earliest_date: dates[0],
      latest_date: dates[dates.length - 1],
      buyers: txs.map((t) => ({
        name: t.reporter_name ?? "?",
        date: t.transaction_date,
        shares: t.shares ?? 0,
        price: t.price ?? 0,
        value: t.value_usd ?? 0,
        title: t.officer_title,
      })),
    });
  }

  // Sort by n_buyers desc, then total_value desc
  clusters.sort((a, b) => b.n_buyers - a.n_buyers || b.total_value - a.total_value);
  return clusters;
}

// Notable insider sales: code 'S' with transaction value >= NOTABLE_SALE_USD.
// Most sales are noise (taxes, planned 10b5-1, diversification) — but large
// sales by named executives still carry signal worth surfacing.
const NOTABLE_SALE_USD = 5_000_000;

async function fetchNotableSales(): Promise<EventForm4[]> {
  const sb = supabaseServer();
  // We can't filter by computed shares*price in Supabase directly, so we
  // pull a wider net and filter in JS.
  const { data, error } = await sb
    .from("events_form4")
    .select(
      "filing_id,reporter_cik,reporter_name,issuer_name,ticker,transaction_date,transaction_code,shares,price,filings_raw!inner(primary_doc_url)",
    )
    .eq("transaction_code", "S")
    .order("transaction_date", { ascending: false })
    .limit(500);
  if (error) throw error;
  return (
    data as unknown as Array<EventForm4 & { filings_raw: { primary_doc_url: string | null } }>
  )
    .map((r) => ({
      filing_id: r.filing_id,
      reporter_cik: r.reporter_cik,
      reporter_name: r.reporter_name,
      issuer_name: r.issuer_name,
      ticker: r.ticker,
      transaction_date: r.transaction_date,
      transaction_code: r.transaction_code,
      shares: r.shares,
      price: r.price,
      primary_doc_url: r.filings_raw?.primary_doc_url ?? null,
    }))
    .filter((e) => {
      const val = (e.shares ?? 0) * (e.price ?? 0);
      return val >= NOTABLE_SALE_USD;
    })
    .slice(0, 30);
}

export default async function ClustersPage() {
  const [clusters, notableSales] = await Promise.all([
    fetchInsiderClusters(),
    fetchNotableSales(),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Clusters"
        description={
          <>
            US companies where <span className="text-foreground">3+ different insiders</span> — officers,
            directors or 10%+ holders — bought their own stock inside a 30-day window. Universe-wide, not
            limited to tracked filers. Large insider sales are listed below for context.
          </>
        }
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{clusters.length}</span> buy clusters
            </span>
            <span>
              <span className="font-medium text-foreground tabular-nums">{notableSales.length}</span> sales ≥ $5M
            </span>
          </>
        }
      />

      <TableCard
        title="Insider buy clusters · last 30 days"
        description="Historically associated with 6–10% annual excess return on small and mid caps (Lakonishok-Lee) — a heuristic, not a forecast. The date range starts at the first buy in the window."
      >
        {clusters.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyTitle>No clusters in the last 30 days</EmptyTitle>
              <EmptyDescription>
                If this persists, the universe-wide Form 4 ingester may not have run —{" "}
                <code className="font-mono text-xs">python -m ingest.form4_universe</code> (a 60-day
                backfill takes ~3–4 hours).
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Issuer</TableHead>
                <TableHead className="text-right">Buyers</TableHead>
                <TableHead className="text-right">Total bought</TableHead>
                <TableHead>Window</TableHead>
                <TableHead className="pr-6">Buyers (price × shares)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clusters.slice(0, 30).map((c) => (
                <TableRow key={c.issuer_cik} className="align-top">
                  <TableCell className="relative pl-6 align-top">
                    <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-positive" aria-hidden />
                    <div className="flex flex-col leading-tight">
                      <span className="max-w-64 truncate" title={c.issuer_name ?? ""}>{c.issuer_name ?? "?"}</span>
                      {c.issuer_ticker && <Ticker className="text-muted-foreground">{c.issuer_ticker}</Ticker>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Badge variant="positive" className="font-mono tabular-nums">{c.n_buyers}</Badge>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">{fmtUsd(c.total_value)}</TableCell>
                  <TableCell className="align-top font-mono text-[11px] text-muted-foreground tabular-nums">
                    {c.earliest_date}
                    {c.earliest_date !== c.latest_date && <> → {c.latest_date}</>}
                  </TableCell>
                  <TableCell className="pr-6 align-top whitespace-normal">
                    <ul className="flex flex-col gap-0.5 text-xs">
                      {c.buyers.slice(0, 4).map((b, i) => (
                        <li key={i} className="flex flex-wrap items-baseline gap-x-1.5">
                          <span>{b.name}</span>
                          {b.title && <span className="text-muted-foreground">{b.title.slice(0, 25)}</span>}
                          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                            ${b.price.toFixed(2)} × {fmtShares(b.shares)}
                          </span>
                        </li>
                      ))}
                      {c.buyers.length > 4 && (
                        <li className="text-muted-foreground">+{c.buyers.length - 4} more</li>
                      )}
                    </ul>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TableCard>

      <TableCard
        title="Notable insider sales · ≥ $5M"
        description="Most insider sales are noise — taxes, 10b5-1 plans, diversification. These are the few large enough to note. A sale is context, not a signal."
      >
        {notableSales.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyTitle>No insider sales of $5M or more in current data</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">When</TableHead>
                <TableHead>Reporter</TableHead>
                <TableHead>Issuer</TableHead>
                <TableHead className="text-right">Shares</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="pr-6 text-right">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notableSales.map((e, i) => {
                const value = (e.shares ?? 0) * (e.price ?? 0);
                return (
                  <TableRow key={`${e.filing_id}-${i}`}>
                    <TableCell className="pl-6"><DateCell iso={e.transaction_date} /></TableCell>
                    <TableCell className="max-w-56 truncate">{e.reporter_name ?? "—"}</TableCell>
                    <TableCell className="max-w-72">
                      <div className="flex items-center gap-2">
                        <span className="truncate">{e.issuer_name ?? "—"}</span>
                        {e.ticker && <Ticker className="text-muted-foreground">{e.ticker}</Ticker>}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmtShares(e.shares)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.price != null ? `$${e.price.toFixed(2)}` : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-negative">{fmtUsd(value)}</TableCell>
                    <TableCell className="pr-6 text-right"><SecLink href={e.primary_doc_url} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}
