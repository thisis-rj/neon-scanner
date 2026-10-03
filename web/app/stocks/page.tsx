import { supabaseServer } from "@/lib/supabase";
import { filerInfo, allFilers } from "@/lib/filers";
import { fmtUsd } from "@/lib/format";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { ThirteenFDelayNote } from "@/components/app/cells";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

// Stock-level view: pivot of holdings_13f by issuer (CUSIP).
// Tells you, for each stock, which tracked funds own it and how much.
// This is the "confluence" lens — stocks held by many smart funds rise to top.

type StockRow = {
  cusip: string;
  issuer_name: string;
  n_funds: number;
  pct_funds: number;
  total_shares: number;
  total_value_usd: number;
  avg_price_per_share: number | null;   // value / shares (quarter-end mark)
  earliest_period: string;               // when first held in our 3-year window
  latest_period: string;
  fund_list: { name: string; manager: string | null; category: string; value: number; shares: number }[];
};

type RawHolding = {
  cik: string;
  cusip: string;
  issuer_name: string | null;
  shares: number | null;
  value_usd: number | null;
  period_of_report: string;
};

async function fetchAggregated(): Promise<{ stocks: StockRow[]; totalFunds: number }> {
  const sb = supabaseServer();
  const all: RawHolding[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      // Effective long-equity rows (migration 019): amendments resolved,
      // options and bond principal excluded. Ordered by id too so pages are stable.
      .from("holdings_13f_effective")
      .select("cik,cusip,issuer_name,shares,value_usd,period_of_report")
      .order("period_of_report", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as RawHolding[]));
    if (data.length < 1000) break;
    from += 1000;
    if (from > 60000) break;
  }

  // Group by CUSIP, taking each filer's MOST-RECENT position only.
  const byKey = new Map<
    string,
    {
      cusip: string;
      issuer_name: string;
      perFund: Map<string, { shares: number; value: number; period: string }>;
      earliest: string;
      latest: string;
    }
  >();

  for (const h of all) {
    if (!h.cusip || !h.issuer_name) continue;
    const k = h.cusip;
    if (!byKey.has(k)) {
      byKey.set(k, {
        cusip: k,
        issuer_name: h.issuer_name,
        perFund: new Map(),
        earliest: h.period_of_report,
        latest: h.period_of_report,
      });
    }
    const bucket = byKey.get(k)!;
    if (h.period_of_report < bucket.earliest) bucket.earliest = h.period_of_report;
    if (h.period_of_report > bucket.latest) bucket.latest = h.period_of_report;
    // For each filer, keep only their latest position on this stock
    const existing = bucket.perFund.get(h.cik);
    if (!existing || h.period_of_report > existing.period) {
      bucket.perFund.set(h.cik, {
        shares: h.shares ?? 0,
        value: h.value_usd ?? 0,
        period: h.period_of_report,
      });
    }
  }

  const totalFunds = allFilers().filter((f) => f.category !== "corporate_strategic").length;

  const stocks: StockRow[] = [];
  for (const b of byKey.values()) {
    if (b.perFund.size === 0) continue;
    let totalShares = 0;
    let totalValue = 0;
    const fundList: StockRow["fund_list"] = [];
    for (const [cik, pos] of b.perFund.entries()) {
      totalShares += pos.shares;
      totalValue += pos.value;
      const info = filerInfo(cik);
      fundList.push({
        name: info?.entity ?? cik,
        manager: info?.manager ?? null,
        category: info?.category ?? "?",
        value: pos.value,
        shares: pos.shares,
      });
    }
    fundList.sort((a, b) => b.value - a.value);

    stocks.push({
      cusip: b.cusip,
      issuer_name: b.issuer_name,
      n_funds: b.perFund.size,
      pct_funds: (b.perFund.size / totalFunds) * 100,
      total_shares: totalShares,
      total_value_usd: totalValue,
      avg_price_per_share: totalShares > 0 ? totalValue / totalShares : null,
      earliest_period: b.earliest,
      latest_period: b.latest,
      fund_list: fundList,
    });
  }

  // Sort by # funds holding desc, then by total value desc
  stocks.sort((a, b) => b.n_funds - a.n_funds || b.total_value_usd - a.total_value_usd);

  return { stocks, totalFunds };
}

export default async function StocksPage() {
  const { stocks, totalFunds } = await fetchAggregated();
  // Surface only stocks held by ≥2 funds — that's where confluence starts.
  const confluence = stocks.filter((s) => s.n_funds >= 2).slice(0, 100);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Stocks by tracked-fund confluence"
        description={`One row per stock: how many of the ${totalFunds} tracked funds hold it, and their combined position. Sorted by number of funds, then total dollars. Only stocks held by 2+ funds are shown.`}
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{confluence.length}</span> of{" "}
              <span className="tabular-nums">{stocks.length.toLocaleString()}</span> issuers
            </span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" />held by an activist</span>
            <ThirteenFDelayNote />
          </>
        }
      />

      <TableCard
        title="Confluence stocks"
        description="Avg price = total value ÷ total shares — the quarter-end market price, not anyone's entry price."
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6">Issuer</TableHead>
              <TableHead className="text-right">Funds</TableHead>
              <TableHead className="text-right">Total value</TableHead>
              <TableHead className="text-right">Avg price</TableHead>
              <TableHead>First held</TableHead>
              <TableHead className="pr-6">Top holders</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {confluence.map((s) => {
              const hasActivist = s.fund_list.some((f) => f.category === "activist");
              return (
                <TableRow key={s.cusip} className="align-top">
                  <TableCell className="relative pl-6 align-top">
                    {hasActivist && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-warning" aria-hidden />}
                    <div className="flex flex-col leading-tight">
                      <span className="max-w-72 truncate">{s.issuer_name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{s.cusip}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">
                    <span className="font-medium">{s.n_funds}</span>
                    <span className="text-muted-foreground">/{totalFunds}</span>
                    <div className="text-[11px] text-muted-foreground">{s.pct_funds.toFixed(0)}%</div>
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">{fmtUsd(s.total_value_usd)}</TableCell>
                  <TableCell className="text-right align-top text-muted-foreground tabular-nums">
                    {s.avg_price_per_share != null ? `$${s.avg_price_per_share.toFixed(2)}` : "—"}
                  </TableCell>
                  <TableCell className="align-top font-mono text-[11px] text-muted-foreground">{s.earliest_period}</TableCell>
                  <TableCell className="pr-6 align-top">
                    <ul className="flex flex-col gap-0.5 text-xs">
                      {s.fund_list.slice(0, 3).map((f, i) => (
                        <li key={i} className="flex items-baseline gap-2">
                          <span className={f.category === "activist" ? "text-warning" : undefined}>{f.manager ?? f.name}</span>
                          <span className="text-muted-foreground tabular-nums">{fmtUsd(f.value)}</span>
                        </li>
                      ))}
                      {s.fund_list.length > 3 && <li className="text-muted-foreground">+{s.fund_list.length - 3} more</li>}
                    </ul>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>
    </div>
  );
}
