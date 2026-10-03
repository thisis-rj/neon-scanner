import { SparklesIcon } from "lucide-react";
import { supabaseServer } from "@/lib/supabase";
import { filerInfo, tier } from "@/lib/filers";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { DateCell, SecLink } from "@/components/app/cells";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const dynamic = "force-dynamic";

// Corporate events — 8-K material events (M&A, leadership changes, big contracts,
// strategic investments). Split out of the old Events page into its own tab.

type Event8K = {
  accession_number: string;
  cik: string;
  filer_name: string | null;
  filed_at: string;
  items: string;  // comma-separated like "1.01,9.01"
  primary_doc_url: string | null;
  summary: string | null;  // LLM-generated one-sentence headline
};

// 8-K item-number → plain-English label
const ITEM_LABELS: Record<string, string> = {
  "1.01": "Material agreement (M&A, partnership, etc.)",
  "1.02": "Termination of material agreement",
  "2.01": "Acquisition completed",
  "2.02": "Earnings results",
  "5.02": "Officer / director change (CEO, CFO, board)",
  "5.07": "Shareholder vote results",
  "7.01": "Reg FD disclosure",
  "8.01": "Other material event",
  "9.01": "Exhibits (supporting documents)",
};
const ITEM_PRIORITY = new Set(["1.01", "2.01", "5.02", "8.01"]);

function describeItems(itemsStr: string): { labels: string[]; priority: boolean } {
  const items = itemsStr.split(",").map((s) => s.trim()).filter(Boolean);
  let priority = false;
  const labels = items.map((i) => {
    if (ITEM_PRIORITY.has(i)) priority = true;
    return ITEM_LABELS[i] ? `${i} — ${ITEM_LABELS[i]}` : i;
  });
  return { labels, priority };
}

async function fetch8Ks(): Promise<Event8K[]> {
  const sb = supabaseServer();
  const { data, error } = await sb
    .from("filings_raw")
    .select("accession_number,cik,filer_name,filed_at,primary_doc_url,raw_payload,summary")
    .in("form_type", ["8-K", "8-K/A"])
    .order("filed_at", { ascending: false })
    .limit(60);
  if (error) throw error;
  return (data as Array<Event8K & { raw_payload: { items?: string } }>).map((r) => ({
    accession_number: r.accession_number,
    cik: r.cik,
    filer_name: r.filer_name,
    filed_at: r.filed_at,
    items: r.raw_payload?.items ?? "",
    primary_doc_url: r.primary_doc_url,
    summary: r.summary ?? null,
  }));
}

// Left accent for filer type: amber = activist, blue = corporate strategic.
const ACCENT = { 2: "bg-warning", 1: "bg-info", 0: "" } as const;

export default async function CorporateEventsPage() {
  const eightKs = await fetch8Ks();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Corporate events"
        description={
          <>
            8-K filings — the &ldquo;something happened&rdquo; disclosures a company must file within four
            business days: M&amp;A, leadership changes, big contracts, strategic investments. High-signal
            item numbers (1.01, 2.01, 5.02, 8.01) are highlighted.
          </>
        }
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{eightKs.length}</span> most recent 8-Ks
            </span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-info" />corporate strategic</span>
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" />activist</span>
          </>
        }
      />

      <TableCard
        title="8-K material events"
        description="Headlines are machine-generated summaries of the filing. Read the filing before acting on one."
      >
        {eightKs.length === 0 ? (
          <Empty className="py-16">
            <EmptyHeader>
              <EmptyTitle>No 8-K filings ingested yet</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Filed</TableHead>
                <TableHead>Filer</TableHead>
                <TableHead>What happened</TableHead>
                <TableHead className="pr-6 text-right">Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eightKs.map((e) => {
                const info = filerInfo(e.cik);
                const t = tier(e.cik);
                const desc = describeItems(e.items);
                return (
                  <TableRow key={e.accession_number} className="align-top">
                    <TableCell className="relative pl-6 align-top">
                      {t > 0 && <span className={`absolute inset-y-2 left-0 w-0.5 rounded-full ${ACCENT[t]}`} aria-hidden />}
                      <DateCell iso={e.filed_at} />
                    </TableCell>
                    <TableCell className="max-w-60 align-top">
                      <div className="flex flex-col leading-tight">
                        <span className="truncate">{info?.entity ?? e.filer_name ?? e.cik}</span>
                        {(info?.manager || info?.category) && (
                          <span className="truncate text-xs text-muted-foreground">
                            {[info?.manager, info?.category?.replace("_", " ")].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-2xl align-top whitespace-normal">
                      <div className="flex flex-col gap-1.5">
                        {e.summary ? (
                          <p className="text-pretty">
                            {e.summary}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <SparklesIcon className="ml-1.5 inline size-3 text-muted-foreground" aria-label="Auto-summary" />
                              </TooltipTrigger>
                              <TooltipContent>Auto-summary of the filing — may be wrong. Read the 8-K.</TooltipContent>
                            </Tooltip>
                          </p>
                        ) : (
                          <p className="text-muted-foreground italic">No summary yet — see the item codes.</p>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {desc.labels.map((label) => {
                            const code = label.split(" ")[0];
                            return (
                              <Tooltip key={label}>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant={ITEM_PRIORITY.has(code) ? "brand" : "muted"}
                                    className="cursor-help rounded-sm px-1.5 font-mono text-[11px]"
                                  >
                                    {code}
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>{label}</TooltipContent>
                              </Tooltip>
                            );
                          })}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="pr-6 text-right align-top"><SecLink href={e.primary_doc_url} /></TableCell>
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
