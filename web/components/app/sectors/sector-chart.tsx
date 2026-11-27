"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pct } from "@/components/app/cells";
import { cn } from "cn";
import { fmtUsdExact } from "@/lib/format";
import { SECTOR_LINES, lineStyle, type SectorRow } from "@/lib/sectors";

const RANGES = { "1M": 21, "3M": 63, "6M": 126, "1Y": 252, "3Y": 756, "5Y": 1260 } as const;
type Range = keyof typeof RANGES;
const DEFAULT_ON = ["btc", "gold", "semis", "defense"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtPct = (v: number) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;

const config = Object.fromEntries(
  SECTOR_LINES.map((l, i) => [l.key, { label: l.label, color: lineStyle(i).color }]),
) satisfies ChartConfig;

function Swatch({ i }: { i: number }) {
  const { color, dashed } = lineStyle(i);
  return (
    <svg width="18" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="17" y2="4" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dashed ? "4 3" : undefined} />
    </svg>
  );
}

export function SectorChart({ rows }: { rows: SectorRow[] }) {
  const [on, setOn] = useState<string[]>(DEFAULT_ON);
  const [range, setRange] = useState<Range>("1Y");

  // Slice to the range, then index each line to its first value in the range.
  const { data, summary } = useMemo(() => {
    const slice = rows.slice(-RANGES[range]);
    const base: Record<string, number | null> = {};
    for (const l of SECTOR_LINES) base[l.key] = (slice.find((r) => r[l.key] != null)?.[l.key] as number) ?? null;
    const data = slice.map((r) => {
      const out: Record<string, number | string | null> = { date: r.date };
      for (const l of SECTOR_LINES) {
        const px = r[l.key] as number | null;
        const b = base[l.key];
        out[l.key] = px != null && b ? px / b - 1 : null;
        out[`${l.key}__px`] = px;
      }
      return out;
    });
    const lastRow = slice[slice.length - 1];
    const summary = SECTOR_LINES.map((l, i) => {
      const px = (lastRow?.[l.key] as number | null) ?? null;
      const b = base[l.key];
      let peak = -Infinity;
      let dd = 0;
      for (const r of slice) {
        const v = r[l.key] as number | null;
        if (v == null) continue;
        peak = Math.max(peak, v);
        dd = Math.min(dd, v / peak - 1);
      }
      return { l, i, px, chg: px != null && b ? px / b - 1 : null, dd };
    }).sort((a, z) => (z.chg ?? -9) - (a.chg ?? -9));
    return { data, summary };
  }, [rows, range]);

  const monthLabel = (iso: string) =>
    RANGES[range] <= 126 ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;
  const visible = SECTOR_LINES.map((l, i) => ({ l, i })).filter(({ l }) => on.includes(l.key));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ToggleGroup
          type="multiple"
          size="sm"
          variant="outline"
          value={on}
          onValueChange={(v) => setOn(v)}
          className="flex flex-wrap justify-start gap-1.5"
          aria-label="Lines shown on the chart"
        >
          {SECTOR_LINES.map((l, i) => (
            <ToggleGroupItem
              key={l.key}
              value={l.key}
              title={l.what}
              className={cn("gap-1.5 rounded-md! border! px-2.5", !on.includes(l.key) && "text-muted-foreground opacity-60")}
            >
              <Swatch i={i} />
              {l.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={range}
          onValueChange={(v) => v && setRange(v as Range)}
          aria-label="Time range"
        >
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <ToggleGroupItem key={r} value={r}>
              {r}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Card size="sm">
        <CardContent>
          {visible.length === 0 ? (
            <p className="py-24 text-center text-sm text-muted-foreground">Switch on at least one line above.</p>
          ) : (
            <ChartContainer config={config} className="aspect-auto h-[420px] w-full">
              <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={40} tickFormatter={monthLabel} />
                <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={(v: number) => fmtPct(v)} domain={["auto", "auto"]} />
                <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1.5} />
                <ChartTooltip
                  itemSorter={(item) => -Number(item.value ?? 0)}
                  content={
                    <ChartTooltipContent
                      indicator="line"
                      labelFormatter={(_, p) => p?.[0]?.payload?.date ?? ""}
                      formatter={(value, name, item) => {
                        const i = SECTOR_LINES.findIndex((l) => l.key === name);
                        const px = item.payload?.[`${String(name)}__px`] as number | null;
                        return (
                          <>
                            <Swatch i={i} />
                            <span className="text-muted-foreground">{SECTOR_LINES[i]?.label}</span>
                            <span className="ml-auto pl-3 font-mono text-foreground tabular-nums">{fmtPct(Number(value))}</span>
                            <span className="w-24 text-right font-mono text-muted-foreground tabular-nums">
                              {px == null ? "—" : fmtUsdExact(px, px < 1000)}
                            </span>
                          </>
                        );
                      }}
                    />
                  }
                />
                {visible.map(({ l, i }) => {
                  const s = lineStyle(i);
                  return (
                    <Line
                      key={l.key}
                      dataKey={l.key}
                      type="monotone"
                      stroke={s.color}
                      strokeDasharray={s.dashed ? "6 4" : undefined}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={false}
                    />
                  );
                })}
              </LineChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card size="sm" className="p-0">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>Line</TableHead>
              <TableHead>Tracks</TableHead>
              <TableHead className="text-right">Latest price</TableHead>
              <TableHead className="text-right">Change ({range})</TableHead>
              <TableHead className="text-right" title="Largest fall from a high within the range">Worst fall ({range})</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.map(({ l, i, px, chg, dd }) => (
              <TableRow key={l.key} className={cn(!on.includes(l.key) && "opacity-50")}>
                <TableCell>
                  <span className="flex items-center gap-2 font-medium">
                    <Swatch i={i} />
                    {l.label}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{l.what}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{px == null ? "—" : fmtUsdExact(px, px < 1000)}</TableCell>
                <TableCell className="text-right">{chg == null ? "—" : <Pct value={chg * 100} />}</TableCell>
                <TableCell className="text-right">
                  <Pct value={dd * 100} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="text-[11px] text-muted-foreground">
        Daily closes from Yahoo, refreshed each evening. Bitcoin and futures are shown on US trading days only.
      </p>
    </div>
  );
}
