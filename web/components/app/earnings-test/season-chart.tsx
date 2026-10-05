"use client";

import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { fmtSignedPct } from "@/lib/format";
import type { Season } from "@/lib/earnings-test";

const config = {
  react_spread: { label: "Reaction day", color: "var(--chart-1)" },
  drift_spread: { label: "Next 20 days", color: "var(--chart-2)" },
} satisfies ChartConfig;
const ORDER = Object.keys(config);

// One pair of bars per earnings season: top pre-move group minus bottom group.
// Above zero = continuation that season; below = reversal.
export function SeasonChart({ data }: { data: Season[] }) {
  const scored = data.filter((s) => s.react_spread != null);
  return (
    <ChartContainer config={config} className="aspect-auto h-72 w-full">
      <BarChart data={scored} margin={{ left: 4, right: 4, top: 8 }} barGap={1}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="season"
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
          tickFormatter={(s: string) => (s.endsWith("Q1") ? s.slice(0, 4) : "")}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v: number) => fmtSignedPct(v, true).replace(".0%", "%")}
        />
        <ReferenceLine y={0} stroke="var(--border)" />
        <ChartTooltip
          itemSorter={(item) => ORDER.indexOf(String(item.dataKey))}
          cursor={false}
          content={
            <ChartTooltipContent
              formatter={(value, name, item) => (
                <>
                  <div
                    className="size-2.5 shrink-0 rounded-[2px] bg-(--color-bg)"
                    style={{ "--color-bg": item.color } as React.CSSProperties}
                  />
                  <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
                  <span className="ml-auto pl-3 font-mono font-medium text-foreground tabular-nums">
                    {value == null ? "—" : fmtSignedPct(Number(value), true)}
                  </span>
                </>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
        {(Object.keys(config) as (keyof typeof config)[]).map((k) => (
          <Bar key={k} dataKey={k} fill={`var(--color-${k})`} radius={2} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartContainer>
  );
}
