import { supabaseServer } from "@/lib/supabase";
import { PageHeader } from "@/components/app/page-header";
import { SectorChart } from "@/components/app/sectors/sector-chart";
import { SECTOR_LINES, type SectorRow } from "@/lib/sectors";

export const dynamic = "force-dynamic";

async function load(): Promise<SectorRow[]> {
  const sb = supabaseServer();
  // ~15k rows; PostgREST caps responses at 1000, so page with a stable order.
  const { count } = await sb.from("sector_prices").select("symbol", { count: "exact", head: true });
  const pages = Math.ceil((count ?? 0) / 1000);
  const chunks = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      sb
        .from("sector_prices")
        .select("symbol,date,close")
        .order("symbol")
        .order("date")
        .range(i * 1000, i * 1000 + 999),
    ),
  );
  const bySym = new Map<string, Map<string, number>>();
  for (const c of chunks)
    for (const r of c.data ?? []) {
      const s = String(r.symbol);
      if (!bySym.has(s)) bySym.set(s, new Map());
      bySym.get(s)!.set(String(r.date), Number(r.close));
    }
  const calendar = [...(bySym.get("SMH")?.keys() ?? [])].sort();
  const last: Record<string, number | null> = {};
  return calendar.map((date) => {
    const row: SectorRow = { date };
    for (const l of SECTOR_LINES) {
      const v = bySym.get(l.symbol)?.get(date);
      if (v != null) last[l.key] = v;
      row[l.key] = last[l.key] ?? null;
    }
    return row;
  });
}

export default async function SectorsPage() {
  const rows = await load();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sectors"
        description="Bitcoin, metals and sector funds on one chart. Every line starts at 0% on the first day of the range, so moves are comparable; hover for the dollar price. Switch lines on and off to look for patterns."
      />
      <SectorChart rows={rows} />
    </div>
  );
}
