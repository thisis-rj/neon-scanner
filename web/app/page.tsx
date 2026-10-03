import Link from "next/link";
import { supabaseServer } from "@/lib/supabase";
import { daysAgo } from "@/lib/format";
import { FormTooltip } from "@/components/FormTooltip";
import { FORMS } from "@/lib/glossary";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { DateCell, SecLink, Ticker } from "@/components/app/cells";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Read Supabase live on EVERY request, like every other page. We briefly used
// ISR (revalidate = 1800) to avoid re-pulling ~8K rows per load — but on a
// low-traffic site ISR served a stale cached snapshot for days (stale-while-
// revalidate only regenerates when someone visits, and even then serves the
// old page first). That was the recurring "stale data" bug. Freshness wins
// over the ~1s fetch; force-dynamic never caches.
export const dynamic = "force-dynamic";

type Filing = {
  id: string;
  accession_number: string;
  cik: string;
  filer_name: string | null;
  form_type: string;
  filed_at: string;
  period_of_report: string | null;
  primary_doc_url: string | null;
};

// Pull every row of the trimmed metadata (no raw_payload). 9k rows is fine
// server-side; the network cost is the bottleneck, not memory.
async function fetchAllFilings(): Promise<Filing[]> {
  const sb = supabaseServer();
  const out: Filing[] = [];
  let from = 0;
  const page = 1000;
  while (true) {
    const { data, error } = await sb
      .from("filings_raw")
      .select("id,accession_number,cik,filer_name,form_type,filed_at,period_of_report,primary_doc_url")
      .order("filed_at", { ascending: false })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as Filing[]));
    if (data.length < page) break;
    from += page;
  }
  return out;
}

// ── Enrichment: target company + insider buy/sell for the visible rows ──────
// filings_raw is metadata only; the issuer and insider direction live in the
// parsed tables (events_13d, events_form4), keyed by filing_id → filings_raw.id.
// We enrich only the ~50 shown rows, so this is two small `.in()` lookups.
type Enrichment = { company: string | null; ticker: string | null; f4dir: "BUY" | "SELL" | "MIXED" | null };

async function enrichRecent(recent: Filing[]): Promise<Map<string, Enrichment>> {
  const sb = supabaseServer();
  const ids = recent.map((f) => f.id).filter(Boolean);
  const map = new Map<string, Enrichment>();
  if (ids.length === 0) return map;

  // 13D / 13G → issuer company
  const { data: e13 } = await sb
    .from("events_13d")
    .select("filing_id,issuer_name,ticker")
    .in("filing_id", ids);
  for (const r of (e13 ?? []) as { filing_id: string; issuer_name: string | null; ticker: string | null }[]) {
    if (!map.has(r.filing_id)) map.set(r.filing_id, { company: r.issuer_name, ticker: r.ticker, f4dir: null });
  }

  // Form 4 → issuer company + buy/sell (a filing can carry several txn rows)
  const { data: e4 } = await sb
    .from("events_form4")
    .select("filing_id,issuer_name,ticker,transaction_code")
    .in("filing_id", ids);
  const byFiling = new Map<string, { name: string | null; ticker: string | null; codes: Set<string> }>();
  for (const r of (e4 ?? []) as {
    filing_id: string; issuer_name: string | null; ticker: string | null; transaction_code: string | null;
  }[]) {
    const cur = byFiling.get(r.filing_id) ?? { name: null, ticker: null, codes: new Set<string>() };
    cur.name ??= r.issuer_name;
    cur.ticker ??= r.ticker;
    if (r.transaction_code) cur.codes.add(r.transaction_code);
    byFiling.set(r.filing_id, cur);
  }
  for (const [fid, v] of byFiling) {
    const p = v.codes.has("P");
    const s = v.codes.has("S");
    map.set(fid, { company: v.name, ticker: v.ticker, f4dir: p && s ? "MIXED" : p ? "BUY" : s ? "SELL" : null });
  }
  return map;
}

// Plain-English meaning + a tone for color. Buys are green, sells red — the only
// two "highlight if it's a buy/sell" cases. Everything else states what the form
// *is* (activist / passive / portfolio / corporate event). §2.1: observable fact
// from the filing, not interpretation.
type Tone = "buy" | "sell" | "mixed" | "activist" | "passive" | "portfolio" | "event" | "neutral";

const TONE_VARIANT = {
  buy: "positive",
  sell: "negative",
  mixed: "warning",
  activist: "warning",
  passive: "muted",
  portfolio: "info",
  event: "outline",
  neutral: "muted",
} as const;

function classify(formType: string, f4dir: Enrichment["f4dir"]): { label: string; tone: Tone } {
  const t = formType.toUpperCase();
  const amend = t.includes("/A");
  if (t.startsWith("4")) {
    if (f4dir === "BUY") return { label: "Insider buy", tone: "buy" };
    if (f4dir === "SELL") return { label: "Insider sell", tone: "sell" };
    if (f4dir === "MIXED") return { label: "Insider buy + sell", tone: "mixed" };
    return { label: "Insider trade", tone: "neutral" };
  }
  if (t.includes("13D")) return { label: amend ? "Activist stake — updated" : "Activist stake", tone: "activist" };
  if (t.includes("13G")) return { label: amend ? "Passive 5%+ — updated" : "Passive 5%+ stake", tone: "passive" };
  if (t.includes("13F")) return { label: amend ? "Portfolio — amended" : "Quarterly portfolio", tone: "portfolio" };
  if (t.startsWith("8-K")) return { label: "Corporate event", tone: "event" };
  return { label: formType, tone: "neutral" };
}

function SignalBadge({ tone, children }: { tone: Tone; children: string }) {
  return <Badge variant={TONE_VARIANT[tone]}>{children}</Badge>;
}

// The EDGAR poll runs daily; a newest filing older than this means ingestion
// has probably stalled (same threshold as lib/staleness.ts).
const STALE_AFTER_DAYS = 7;

const LEGEND: { tone: Tone; label: string; meaning: string }[] = [
  { tone: "buy", label: "Insider buy", meaning: "an officer or director bought their own company’s stock" },
  { tone: "sell", label: "Insider sell", meaning: "an insider sold shares" },
  { tone: "activist", label: "Activist stake", meaning: "a 5%+ stake taken to push for change (13D)" },
  { tone: "passive", label: "Passive 5%+ stake", meaning: "a big stake held passively, no activist intent (13G)" },
  { tone: "portfolio", label: "Quarterly portfolio", meaning: "a fund’s full holdings snapshot (13F) — see Holdings" },
  { tone: "event", label: "Corporate event", meaning: "a company’s own material announcement (8-K)" },
];

const FORM_LEGEND: { code: string; text: string }[] = [
  { code: "13F", text: FORMS["13F-HR"].short },
  { code: "13D", text: FORMS["SC 13D"].short },
  { code: "13G", text: FORMS["SC 13G"].short },
  { code: "Form 4", text: FORMS["4"].short },
  { code: "8-K", text: FORMS["8-K"].short },
  { code: "…/A", text: "an amendment (update) to a prior filing" },
];

export default async function FilingsPage() {
  const filings = await fetchAllFilings();
  const filerCount = new Set(filings.map((f) => f.cik)).size;
  const recent = filings.slice(0, 50);
  const enrich = await enrichRecent(recent);

  const newest = filings[0]?.filed_at ?? null;
  const newestAgeDays = newest ? Math.floor((Date.now() - new Date(newest).getTime()) / 86_400_000) : null;
  const stale = newestAgeDays != null && newestAgeDays > STALE_AFTER_DAYS;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Filings log"
        description={
          <>
            Every filing from the tracked filers, newest first. Each row shows the target company and
            what the filing <em>is</em>. 13F rows are whole portfolios, so they have no single company —
            open <Link href="/holdings" className="text-foreground underline underline-offset-4">Holdings</Link> for
            the positions.
          </>
        }
        meta={
          <>
            <span>
              <span className="font-medium text-foreground tabular-nums">{filings.length.toLocaleString()}</span> filings
            </span>
            <span>
              <span className="font-medium text-foreground tabular-nums">{filerCount}</span> filers
            </span>
            {newest && (
              <Badge variant={stale ? "warning" : "muted"} className="font-normal">
                <span className={stale ? "size-1.5 rounded-full bg-warning" : "size-1.5 rounded-full bg-positive"} />
                {stale
                  ? `Newest filing is ${daysAgo(newest)} — ingest may have stalled`
                  : `Newest filing ${daysAgo(newest)}`}
              </Badge>
            )}
          </>
        }
      />

      <TableCard
        title="Most recent activity"
        description="The latest 50 filings. Hover a form code for its definition; every row links to the filing on sec.gov."
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6">Filed</TableHead>
              <TableHead>Filer</TableHead>
              <TableHead>Company</TableHead>
              <TableHead>Form</TableHead>
              <TableHead>Signal</TableHead>
              <TableHead className="pr-6 text-right">Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recent.map((f) => {
              const e = enrich.get(f.id);
              const sig = classify(f.form_type, e?.f4dir ?? null);
              const isCorpEvent = f.form_type.toUpperCase().startsWith("8-K");
              const company = e?.company ?? (isCorpEvent ? f.filer_name : null);
              const ticker = e?.ticker ?? null;
              return (
                <TableRow key={f.accession_number}>
                  <TableCell className="pl-6">
                    <DateCell iso={f.filed_at} />
                  </TableCell>
                  <TableCell className="max-w-64 truncate" title={f.filer_name ?? f.cik}>
                    {f.filer_name ?? f.cik}
                  </TableCell>
                  <TableCell className="max-w-72">
                    {company ? (
                      <div className="flex items-center gap-2">
                        <span className="truncate" title={company}>{company}</span>
                        {ticker && <Ticker className="text-muted-foreground">{ticker}</Ticker>}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <FormTooltip term={f.form_type} />
                  </TableCell>
                  <TableCell>
                    <SignalBadge tone={sig.tone}>{sig.label}</SignalBadge>
                  </TableCell>
                  <TableCell className="pr-6 text-right">
                    <SecLink href={f.primary_doc_url} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableCard>

      <Card size="sm">
        <CardHeader>
          <CardTitle>How to read this</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-2">
          <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
            {LEGEND.map((l) => (
              <li key={l.tone} className="flex items-baseline gap-2">
                <SignalBadge tone={l.tone}>{l.label}</SignalBadge>
                <span className="text-pretty">{l.meaning}</span>
              </li>
            ))}
          </ul>
          <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
            {FORM_LEGEND.map((f) => (
              <li key={f.code} className="flex items-baseline gap-2">
                <span className="w-12 shrink-0 font-mono text-foreground">{f.code}</span>
                <span className="text-pretty">{f.text}</span>
              </li>
            ))}
            <li className="pt-1">
              <Link href="/learn" className="text-primary underline-offset-4 hover:underline">
                Full glossary →
              </Link>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
