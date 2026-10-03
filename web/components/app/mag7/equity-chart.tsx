"use client";

import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtUsd, fmtUsdExact } from "@/lib/format";

const config = {
  strategy: { label: "Lag7 sleeve", color: "var(--chart-1)" },
  equal_weight: { label: "All seven, equal & held", color: "var(--chart-2)" },
  sp500: { label: "S&P 500 (total return)", color: "var(--chart-3)" },
} satisfies ChartConfig;
const ORDER = Object.keys(config);

type Point = { date: string; strategy: number; equal_weight: number; sp500: number };

// Sleeve value vs two do-nothing alternatives, $100,000 each on the first trade.
// Linear by default (the sleeve starts 2025-01); log is there for comparing growth rates.
export function EquityChart({ data }: { data: Point[] }) {
  const [scale, setScale] = useState<"log" | "linear">("linear");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;
  // One tick per quarter: the first point dated in each Jan / Apr / Jul / Oct.
  const quarter = (iso: string) => `${iso.slice(0, 4)}-${Math.floor((Number(iso.slice(5, 7)) - 1) / 3)}`;
  const quarterTicks = data
    .filter((d, i) => i === 0 || quarter(d.date) !== quarter(data[i - 1].date))
    .map((d) => d.date);

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={scale}
        onValueChange={(v) => v && setScale(v as "log" | "linear")}
        className="self-end"
        aria-label="Y-axis scale"
      >
        <ToggleGroupItem value="log">Log</ToggleGroupItem>
        <ToggleGroupItem value="linear">Linear</ToggleGroupItem>
      </ToggleGroup>
      <ChartContainer config={config} className="aspect-auto h-80 w-full">
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            ticks={quarterTicks}
            interval="preserveStartEnd"
            minTickGap={24}
            tickFormatter={monthLabel}
          />
          <YAxis
            scale={scale}
            domain={["auto", "auto"]}
            allowDataOverflow
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => fmtUsd(v)}
          />
          <ChartTooltip
            itemSorter={(item) => ORDER.indexOf(String(item.dataKey))}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(_, p) => p?.[0]?.payload?.date ?? ""}
                formatter={(value, name, item) => (
                  <>
                    <div
                      className="h-2.5 w-1 shrink-0 rounded-[2px] bg-(--color-bg)"
                      style={{ "--color-bg": item.color } as React.CSSProperties}
                    />
                    <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? name}</span>
                    <span className="ml-auto pl-3 font-mono font-medium text-foreground tabular-nums">
                      {fmtUsdExact(Number(value))}
                    </span>
                  </>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} itemSorter={null} />
          {(Object.keys(config) as (keyof typeof config)[]).map((k) => (
            <Line
              key={k}
              dataKey={k}
              type="monotone"
              stroke={`var(--color-${k})`}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
