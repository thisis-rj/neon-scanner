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

const config = {
  ret_3m: { label: "3-month", color: "var(--chart-1)" },
  ret_6m: { label: "6-month", color: "var(--chart-2)" },
  ret_12m: { label: "12-month", color: "var(--chart-3)" },
} satisfies ChartConfig;
const ORDER = Object.keys(config);

type Row = { ticker: string; ret_3m: number; ret_6m: number | null; ret_12m: number | null };

// The three inputs to this month's ranks, per stock, in the table's order.
export function ReturnsChart({ data }: { data: Row[] }) {
  return (
    <ChartContainer config={config} className="aspect-auto h-72 w-full">
      <BarChart data={data} margin={{ left: 4, right: 4, top: 8 }} barGap={2}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="ticker" tickLine={false} axisLine={false} />
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
                    {fmtSignedPct(Number(value), true)}
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
