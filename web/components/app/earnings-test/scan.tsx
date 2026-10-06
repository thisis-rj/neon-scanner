import { Pct } from "@/components/app/cells";
import { TableCard } from "@/components/app/table-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ScanResult, ScanRow } from "@/lib/earnings-test";

// Results of ingest/earnings_scan.py: many cuts tested on the earlier half,
// survivors re-tested once on the later half. Sorted by verdict, then by how
// strong the search-half result was — never by stock return (§2.2).

const OUTCOME = {
  react: "Reaction day",
  week: "First week",
  drift: "Next 20 days",
  size: "Size of reaction-day move",
} as const;

const VERDICT = {
  confirmed: { variant: "info", label: "held in check half" },
  "same direction": { variant: "warning", label: "same direction, weaker" },
  "did not hold": { variant: "muted", label: "did not hold" },
} as const;

const SHOW = 60;

function Half({ effect, t, n }: { effect: number; t: number; n: number }) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <Pct value={effect} fraction />
      <span className="text-[11px] text-muted-foreground tabular-nums">
        t {t.toFixed(1)} · {n.toLocaleString()}
      </span>
    </div>
  );
}

function ScanTable({ rows, size }: { rows: ScanRow[]; size: boolean }) {
  if (rows.length === 0) {
    return (
      <Empty className="py-10">
        <EmptyDescription>No cut passed the search half.</EmptyDescription>
      </Empty>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Cut (known before the report)</TableHead>
          {!size && <TableHead>After window</TableHead>}
          <TableHead className="text-right">
            {size ? "Extra move size" : "Beat same-week reports by"}, search half
          </TableHead>
          <TableHead className="text-right">Check half</TableHead>
          {!size && <TableHead className="text-right">Went up</TableHead>}
          <TableHead className="pr-6">Verdict</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.slice(0, SHOW).map((r) => (
          <TableRow key={r.cut.join("+") + r.outcome}>
            <TableCell className="pl-6 whitespace-normal">{r.label}</TableCell>
            {!size && <TableCell className="text-muted-foreground">{OUTCOME[r.outcome]}</TableCell>}
            <TableCell className="text-right">
              <Half effect={r.search_effect} t={r.search_t} n={r.search_n} />
            </TableCell>
            <TableCell className="text-right">
              <Half effect={r.check_effect} t={r.check_t} n={r.check_n} />
            </TableCell>
            {!size && (
              <TableCell className="text-right tabular-nums">
                {r.up_share == null ? "—" : `${(r.up_share * 100).toFixed(0)}%`}
                <span className="ml-1 text-xs text-muted-foreground">
                  vs {r.base_up == null ? "—" : `${(r.base_up * 100).toFixed(0)}%`}
                </span>
              </TableCell>
            )}
            <TableCell className="pr-6">
              <Badge variant={VERDICT[r.verdict].variant}>{VERDICT[r.verdict].label}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function EarningsScan({ scan }: { scan: ScanResult | null }) {
  if (!scan) {
    return (
      <Empty className="border py-16">
        <EmptyDescription>No scan yet. Run python -m ingest.earnings_scan.</EmptyDescription>
      </Empty>
    );
  }
  const direction = scan.kept.filter((r) => r.outcome !== "size");
  const size = scan.kept.filter((r) => r.outcome === "size");
  const held = (rs: ScanRow[]) => rs.filter((r) => r.verdict === "confirmed").length;
  const tiers = Object.entries(scan.tiers)
    .map(([k, v]) => `${k} ${v.toLocaleString()}`)
    .join(" · ");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Scan: every cut, tested the honest way</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            {scan.tested.toLocaleString()} tests: each condition known before a report (size, move before, shape,
            volume, insider buying, trend, report time, sector, last report&rsquo;s reaction) and every pair of them,
            against four outcomes, over {scan.reports.toLocaleString()} reports ({tiers}). Trying that many finds dozens
            of flukes, so it is a two-step test:
          </CardDescription>
        </CardHeader>
        <CardContent className="flex max-w-3xl flex-col gap-2 text-sm text-pretty text-muted-foreground">
          <p>
            <strong className="font-medium text-foreground">1 · Search half</strong> (reports before {scan.split}): keep
            a cut only if it passes a false-discovery correction (q &lt; {scan.fdr_q}: at most ~
            {Math.round(scan.fdr_q * 100)}% of kept cuts expected to be flukes). {scan.kept.length} of{" "}
            {scan.tested.toLocaleString()} passed.
          </p>
          <p>
            <strong className="font-medium text-foreground">2 · Check half</strong> ({scan.split} on): re-test only
            those, once. &ldquo;Held&rdquo; = same direction and strong enough after correcting for how many were
            re-tested. A cut that only worked in the search half was most likely chance.
          </p>
          <p>
            Each report is compared with other reports whose reaction fell in the same week, so a cut can&rsquo;t win by
            landing in a good week. Returns are minus SPY; t beyond ±2 is unlikely to be chance for a single test. Cuts
            need {scan.min_n}+ reports in each half. EPS beat/miss is only used for the next 20 days, since it is known
            only once the report is out.
          </p>
          <p>
            Held: <strong className="text-foreground">{held(direction)}</strong> direction cuts,{" "}
            <strong className="text-foreground">{held(size)}</strong> size cuts. Size effects are real but the options
            market prices them before the report; only direction can be traded with the stock itself.
          </p>
        </CardContent>
      </Card>

      <TableCard
        title="Direction: did the cut do better or worse than other reports that week?"
        description={`Kept by the search half, held ones first (showing up to ${SHOW}). "Went up" = share of the cut's reports that rose over that window, vs all reports.`}
      >
        <ScanTable rows={direction} size={false} />
      </TableCard>

      <TableCard
        title="Size: did the cut move more (either way) on the reaction day?"
        description={`Extra size of the reaction-day move vs other reports that week. Kept by the search half, held ones first (showing up to ${SHOW}).`}
      >
        <ScanTable rows={size} size />
      </TableCard>
    </div>
  );
}
