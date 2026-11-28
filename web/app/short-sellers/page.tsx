import { supabaseServer } from "@/lib/supabase";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

// Short-seller news (ingest/short_sellers.py, Google News + AI target check):
// which of our holdings short sellers are betting against, and every short
// report in the news market-wide.
type Row = { url: string; ticker: string | null; firms: string[]; title: string; source: string | null; published: string; kind: "report" | "commentary" };

const nice = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function Item({ r }: { r: Row }) {
  return (
    <li className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
      <a href={r.url} target="_blank" rel="noreferrer" className="text-sm text-foreground underline-offset-4 hover:underline">
        {r.title}
      </a>
      <span className="text-xs text-muted-foreground">
        {nice(r.published)}
        {r.source ? ` · ${r.source}` : ""}
        {r.firms.length ? ` · ${r.firms.join(", ")}` : ""}
      </span>
    </li>
  );
}

export default async function ShortSellersPage() {
  const sb = supabaseServer();
  const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const [{ data: news }, { data: pos }] = await Promise.all([
    sb.from("short_seller_news").select("url,ticker,firms,title,source,published,kind").gte("published", since).order("published", { ascending: false }).limit(1000),
    sb.from("portfolio_positions").select("person,ticker,stock_name").gt("qty", 0),
  ]);
  const rows = (news ?? []) as Row[];
  const owners = new Map<string, { name: string | null; people: Set<string> }>();
  for (const p of pos ?? []) {
    const o = owners.get(String(p.ticker)) ?? { name: p.stock_name ?? null, people: new Set<string>() };
    o.people.add(String(p.person));
    owners.set(String(p.ticker), o);
  }
  const mine = new Map<string, Row[]>();
  const seenMine = new Set<string>();
  for (const r of rows) {
    if (!r.ticker) continue;
    const k = `${r.ticker}|${r.title.toLowerCase()}`; // same story syndicated by several outlets
    if (seenMine.has(k)) continue;
    seenMine.add(k);
    mine.set(r.ticker, [...(mine.get(r.ticker) ?? []), r]);
  }
  const ranked = [...mine.entries()].sort(
    (a, b) => b[1].filter((r) => r.kind === "report").length - a[1].filter((r) => r.kind === "report").length || b[1][0].published.localeCompare(a[1][0].published),
  );
  const seen = new Set<string>();
  const market = rows.filter((r) => !r.ticker && r.kind === "report").filter((r) => (seen.has(r.title) ? false : (seen.add(r.title), true)));
  const clean = [...owners.keys()].filter((t) => !mine.has(t)).sort();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Short sellers"
        description="Short sellers bet a stock will fall and often publish a report saying why. A new short report on a stock you own is worth reading the same day. Sources: news coverage (Google News), with each headline checked for who the short seller is actually betting against. Last 60 days."
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">On your stocks</h2>
        {ranked.length === 0 && <p className="text-sm text-muted-foreground">No short-seller activity on your stocks in the last 60 days.</p>}
        {ranked.map(([t, rs]) => {
          const reports = rs.filter((r) => r.kind === "report");
          const firms = [...new Set(rs.flatMap((r) => r.firms))];
          const o = owners.get(t);
          return (
            <Card key={t} size="sm">
              <CardHeader className="border-b">
                <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono">{t}</span>
                  <span className="font-normal text-muted-foreground">{o?.name}</span>
                  {reports.length > 0 ? (
                    <Badge variant="negative">{reports.length} short report{reports.length > 1 ? "s" : ""}</Badge>
                  ) : (
                    <Badge variant="outline">commentary only</Badge>
                  )}
                  {firms.length > 0 && <span className="text-xs font-normal text-muted-foreground">{firms.join(", ")}</span>}
                </CardTitle>
                <CardAction className="text-[11px] text-muted-foreground">
                  held by {[...(o?.people ?? [])].join(" & ")} · latest {nice(rs[0].published)}
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {reports.length > 0 && (
                  <div>
                    <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Reports / attacks</p>
                    <ul className="flex flex-col divide-y divide-border">{reports.slice(0, 8).map((r) => <Item key={r.url} r={r} />)}</ul>
                  </div>
                )}
                {rs.length > reports.length && (
                  <div>
                    <p className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Commentary</p>
                    <ul className="flex flex-col divide-y divide-border">
                      {rs.filter((r) => r.kind === "commentary").slice(0, 6).map((r) => <Item key={r.url} r={r} />)}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
        {clean.length > 0 && (
          <p className="text-xs text-muted-foreground">No short-seller news in 60 days: {clean.join(", ")}</p>
        )}
      </section>

      <Card size="sm">
        <CardHeader className="border-b">
          <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">All short reports in the news</CardTitle>
          <CardAction className="text-[11px] text-muted-foreground">any company · last 60 days</CardAction>
        </CardHeader>
        <CardContent>
          {market.length === 0 ? (
            <p className="text-sm text-muted-foreground">None found.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">{market.slice(0, 60).map((r) => <Item key={r.url} r={r} />)}</ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
