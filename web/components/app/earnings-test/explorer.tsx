"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, XAxis, YAxis } from "recharts";
import { Pct } from "@/components/app/cells";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtSignedPct } from "@/lib/format";
import {
  DEFAULT_SETTINGS,
  PATH_DAYS,
  prepare,
  run,
  type ExploreEvent,
  type Settings,
  type Stats,
} from "@/lib/earnings-explore";

// Interactive what-if over the stored ±30-day return paths. Every number on
// it is recomputed from the reports' daily returns as the controls move.

export const dayLabel = (d: number) => (d === 0 ? "day 0" : d > 0 ? `+${d}` : `${d}`);
export const windowLabel = ([a, b]: [number, number]) =>
  a === b ? `day ${a > 0 ? "+" : ""}${a}` : `days ${dayLabel(a)} to ${dayLabel(b)}`;

const PRESETS_BEFORE: { label: string; v: [number, number] }[] = [
  { label: "10 days before", v: [-10, -1] },
  { label: "5 days before", v: [-5, -1] },
  { label: "Day before", v: [-1, -1] },
  { label: "30 days before", v: [-30, -1] },
];
const PRESETS_AFTER: { label: string; v: [number, number] }[] = [
  { label: "Reaction day", v: [0, 0] },
  { label: "20 days after", v: [1, 20] },
  { label: "Reaction + 30 days", v: [0, 30] },
  { label: "Day 2–5", v: [1, 5] },
];

const pathConfig = {
  top: { label: "Group that rose most before", color: "var(--chart-1)" },
  bottom: { label: "Group that fell most before", color: "var(--chart-2)" },
  all: { label: "All reports", color: "var(--chart-3)" },
} satisfies ChartConfig;

const seasonConfig = {
  spread: { label: "Top − bottom group", color: "var(--chart-1)" },
} satisfies ChartConfig;

const pctTick = (v: number) => fmtSignedPct(v, true).replace(".0%", "%");

export function Control({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

export function WindowControl({
  label,
  value,
  onChange,
  min,
  max,
  presets,
}: {
  label: string;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  min: number;
  max: number;
  presets: { label: string; v: [number, number] }[];
}) {
  return (
    <Control
      label={
        <>
          {label}: <span className="font-medium text-foreground">{windowLabel(value)}</span>
        </>
      }
    >
      <Slider
        min={min}
        max={max}
        step={1}
        minStepsBetweenThumbs={0}
        value={value}
        onValueChange={(v) => onChange([v[0], v[1]] as [number, number])}
        aria-label={label}
      />
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{dayLabel(min)}</span>
        <span>{dayLabel(max)}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p.label}
            size="xs"
            variant={p.v[0] === value[0] && p.v[1] === value[1] ? "secondary" : "outline"}
            onClick={() => onChange(p.v)}
          >
            {p.label}
          </Button>
        ))}
      </div>
    </Control>
  );
}

export function Toggle<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string }[];
  label: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
      className="flex-wrap"
    >
      {options.map((o) => (
        <ToggleGroupItem key={o.v} value={o.v}>
          {o.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function StatBlock({ title, s }: { title: string; s: Stats }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-xs text-muted-foreground">{title}</span>
      {s.seasons === 0 ? (
        <span className="text-sm text-muted-foreground">no scored season</span>
      ) : (
        <>
          <span className="text-lg font-semibold tabular-nums">
            <Pct value={s.mean} fraction />
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            t {s.t == null ? "—" : s.t.toFixed(2)} · above zero in {s.positive} of {s.seasons} seasons
          </span>
        </>
      )}
    </div>
  );
}

export function EarningsExplorer({
  events,
  spyDates,
  spyRet,
  sectors,
  hasLive,
}: {
  events: ExploreEvent[];
  spyDates: string[];
  spyRet: number[];
  sectors: string[];
  hasLive: boolean;
}) {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const prepared = useMemo(() => prepare(events, spyDates, spyRet), [events, spyDates, spyRet]);
  const deferred = useDeferredValue(s);
  const r = useMemo(() => run(prepared, deferred), [prepared, deferred]);
  const G = s.groups;
  const vs = s.excess ? " minus SPY" : "";
  const overlap = s.pre[1] >= s.post[0];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Advanced: groups by season</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Pick the days whose move might predict (&ldquo;before&rdquo;) and the days you want predicted
            (&ldquo;after&rdquo;). Day 0 is the first session that can react to the report. Reports are split into
            groups by their &ldquo;before&rdquo; move; if it predicts, the groups&rsquo; &ldquo;after&rdquo; moves line
            up in order, season after season.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <WindowControl
            label="Before (predictor)"
            value={s.pre}
            onChange={(v) => set("pre", v)}
            min={-PATH_DAYS}
            max={PATH_DAYS}
            presets={PRESETS_BEFORE}
          />
          <WindowControl
            label="After (outcome)"
            value={s.post}
            onChange={(v) => set("post", v)}
            min={-PATH_DAYS}
            max={PATH_DAYS}
            presets={PRESETS_AFTER}
          />
          <div className="flex flex-wrap gap-x-6 gap-y-4 lg:col-span-2">
            <Control label="Returns">
              <Toggle
                label="Returns"
                value={s.excess ? "excess" : "raw"}
                onChange={(v) => set("excess", v === "excess")}
                options={[
                  { v: "excess", label: "Minus SPY" },
                  { v: "raw", label: "Raw" },
                ]}
              />
            </Control>
            <Control label="Groups">
              <Toggle
                label="Groups"
                value={String(s.groups)}
                onChange={(v) => set("groups", Number(v))}
                options={[
                  { v: "3", label: "3" },
                  { v: "5", label: "5" },
                  { v: "10", label: "10" },
                ]}
              />
            </Control>
            <Control label="Rank reports">
              <Toggle
                label="Rank reports"
                value={s.withinSeason ? "season" : "pooled"}
                onChange={(v) => set("withinSeason", v === "season")}
                options={[
                  { v: "season", label: "Within each season" },
                  { v: "pooled", label: "All together" },
                ]}
              />
            </Control>
            <Control label="Report time">
              <Toggle
                label="Report time"
                value={s.session}
                onChange={(v) => set("session", v)}
                options={[
                  { v: "all", label: "All" },
                  { v: "before", label: "Before open / during" },
                  { v: "after", label: "After close" },
                ]}
              />
            </Control>
            <Control label="EPS vs estimate (known only after the report)">
              <Toggle
                label="EPS vs estimate"
                value={s.surprise}
                onChange={(v) => set("surprise", v)}
                options={[
                  { v: "all", label: "All" },
                  { v: "beat", label: "Beat" },
                  { v: "miss", label: "Missed" },
                ]}
              />
            </Control>
            <Control label="Sector">
              <Select value={s.sector} onValueChange={(v) => set("sector", v)}>
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sectors</SelectItem>
                  {sectors.map((x) => (
                    <SelectItem key={x} value={x}>
                      {x}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Control>
            {hasLive && (
              <Control label="Reports">
                <Toggle
                  label="Reports"
                  value={s.cohort}
                  onChange={(v) => set("cohort", v)}
                  options={[
                    { v: "backtest", label: "Backtest" },
                    { v: "live", label: "Live log" },
                    { v: "both", label: "Both" },
                  ]}
                />
              </Control>
            )}
            <Button variant="ghost" size="sm" className="self-end" onClick={() => setS(DEFAULT_SETTINGS)}>
              Reset
            </Button>
          </div>
          {overlap && (
            <p className="text-xs text-warning lg:col-span-2">
              The &ldquo;before&rdquo; window reaches day 0 or later, so it already contains part of the
              &ldquo;after&rdquo; move. That can&rsquo;t be known when you would trade.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Top − bottom group, {windowLabel(s.post)}
            {vs}
          </CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Average &ldquo;after&rdquo; move of the group that rose most over {windowLabel(s.pre)}, minus the group that
            fell most, per season. Above zero = moves continued; below = they reversed. {r.events.toLocaleString()}{" "}
            reports. A real pattern shows up in both halves; one that appears in only one half is likely chance.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatBlock title="All seasons" s={r.all} />
          <StatBlock title={`Earlier half (before ${r.lateFrom ?? "—"})`} s={r.early} />
          <StatBlock title={`Later half (from ${r.lateFrom ?? "—"})`} s={r.late} />
          <div className="flex flex-col gap-1 rounded-lg border p-3">
            <span className="text-xs text-muted-foreground">Same direction before and after</span>
            <span className="text-lg font-semibold tabular-nums">
              {r.sameSign == null ? "—" : `${(r.sameSign * 100).toFixed(1)}%`}
            </span>
            <span className="text-xs text-muted-foreground">a coin flip is 50%</span>
          </div>
          <div className="flex flex-col gap-1 rounded-lg border p-3">
            <span className="text-xs text-muted-foreground">Rank correlation</span>
            <span className="text-lg font-semibold tabular-nums">
              {r.spearman == null ? "—" : r.spearman.toFixed(3)}
            </span>
            <span className="text-xs text-muted-foreground">−1 reverse … 0 none … +1 same order</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Average path around the report</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Average cumulative return{vs} from day −30 to +30, relative to the close the day before day 0 (so every line
            crosses zero at day −1). Shaded: your &ldquo;before&rdquo; and &ldquo;after&rdquo; windows. The top and
            bottom groups are split on the &ldquo;before&rdquo; window, so they diverge there by construction; what
            matters is what they do afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={pathConfig} className="aspect-auto h-80 w-full">
            <LineChart data={r.path} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="day"
                type="number"
                domain={[-PATH_DAYS, PATH_DAYS]}
                ticks={[-30, -20, -10, 0, 10, 20, 30]}
                tickLine={false}
                axisLine={false}
              />
              <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={pctTick} />
              <ReferenceArea
                x1={s.pre[0] - 0.5}
                x2={s.pre[1] + 0.5}
                fill="var(--muted-foreground)"
                fillOpacity={0.08}
              />
              <ReferenceArea
                x1={s.post[0] - 0.5}
                x2={s.post[1] + 0.5}
                fill="var(--muted-foreground)"
                fillOpacity={0.16}
              />
              <ReferenceLine y={0} stroke="var(--border)" />
              <ReferenceLine x={0} stroke="var(--border)" strokeDasharray="3 3" />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, p) => dayLabel(Number(p?.[0]?.payload?.day))}
                    formatter={(value, name, item) => (
                      <>
                        <div
                          className="size-2.5 shrink-0 rounded-[2px] bg-(--color-bg)"
                          style={{ "--color-bg": item.color } as React.CSSProperties}
                        />
                        <span className="text-muted-foreground">
                          {pathConfig[name as keyof typeof pathConfig]?.label ?? name}
                        </span>
                        <span className="ml-auto pl-3 font-mono font-medium text-foreground tabular-nums">
                          {value == null ? "—" : fmtSignedPct(Number(value), true)}
                        </span>
                      </>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {(Object.keys(pathConfig) as (keyof typeof pathConfig)[]).map((k) => (
                <Line
                  key={k}
                  dataKey={k}
                  stroke={`var(--color-${k})`}
                  dot={false}
                  strokeWidth={2}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By group</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Group 1 moved least over {windowLabel(s.pre)}
            {vs}; group {G} moved most.
          </CardDescription>
        </CardHeader>
        <CardContent className="border-t px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">Group</TableHead>
                <TableHead className="text-right">Reports</TableHead>
                <TableHead className="text-right">Avg before</TableHead>
                <TableHead className="text-right">Avg after</TableHead>
                <TableHead className="text-right">Median after</TableHead>
                <TableHead className="pr-6 text-right">After was up</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.groups.map((g) => (
                <TableRow key={g.g}>
                  <TableCell className="pl-6">
                    {g.g === 1 ? "1 · fell most" : g.g === G ? `${G} · rose most` : g.g}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{g.events.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Pct value={g.x} fraction />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pct value={g.y} fraction />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pct value={g.yMedian} fraction />
                  </TableCell>
                  <TableCell className="pr-6 text-right tabular-nums">{(g.upShare * 100).toFixed(0)}%</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {r.groups.length === 0 && (
            <p className="px-6 py-6 text-sm text-muted-foreground">
              Too few reports to split into {G} groups (at least {G * 5} per season needed).
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Season by season</CardTitle>
          <CardDescription>
            Top − bottom group&rsquo;s &ldquo;after&rdquo; move in each earnings season.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ChartContainer config={seasonConfig} className="aspect-auto h-56 w-full">
            <BarChart data={r.seasons.filter((x) => x.spread != null)} margin={{ left: 4, right: 4, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="season"
                tickLine={false}
                axisLine={false}
                tickFormatter={(x: string) => (x.endsWith("Q1") ? x.slice(0, 4) : "")}
              />
              <YAxis tickLine={false} axisLine={false} width={52} tickFormatter={pctTick} />
              <ReferenceLine y={0} stroke="var(--border)" />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent formatter={(v) => fmtSignedPct(Number(v), true)} />}
              />
              <Bar dataKey="spread" fill="var(--color-spread)" radius={2} isAnimationActive={false} />
            </BarChart>
          </ChartContainer>
          <div className="-mx-6 border-t">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Season</TableHead>
                  <TableHead className="text-right">Reports</TableHead>
                  <TableHead className="pr-6 text-right">Top − bottom</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...r.seasons].reverse().map((x) => (
                  <TableRow key={x.season}>
                    <TableCell className="pl-6 font-mono text-xs">{x.season}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.events.toLocaleString()}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Pct value={x.spread} fraction />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
