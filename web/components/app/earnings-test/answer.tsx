"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { CartesianGrid, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from "recharts";
import { Pct } from "@/components/app/cells";
import { Control, Toggle, WindowControl, windowLabel } from "@/components/app/earnings-test/explorer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtSignedPct } from "@/lib/format";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONTEXT,
  DEFAULT_ANSWER,
  PATH_DAYS,
  answer,
  prepare,
  type AnswerSettings,
  type Cell,
  type ContextRow,
  type ExploreEvent,
} from "@/lib/earnings-explore";

// The hypothesis asked directly: does what a stock did BEFORE a report
// (direction, size, shape) go with what it does AFTER (direction, size)?

const BEFORE: { label: string; v: [number, number] }[] = [
  { label: "Day before", v: [-1, -1] },
  { label: "Last 5 days", v: [-5, -1] },
  { label: "Last 10 days", v: [-10, -1] },
  { label: "Last 20 days", v: [-20, -1] },
];
const AFTER: { label: string; v: [number, number] }[] = [
  { label: "Reaction day", v: [0, 0] },
  { label: "First week", v: [0, 4] },
  { label: "First month", v: [0, 20] },
];
const CLIP = 0.3; // scatter shows moves within ±30%

/** "the 10 days before", "the reaction day", "the reaction day + next 4 days" … */
function friendly([a, b]: [number, number]): string {
  if (b === -1) return a === -1 ? "the day before" : `the ${-a} days before`;
  if (a === 0) return b === 0 ? "the reaction day" : `the reaction day + next ${b} day${b === 1 ? "" : "s"}`;
  return windowLabel([a, b]);
}

const pct1 = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const pts = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)} pts`);

const scatterConfig = { pt: { label: "Report", color: "var(--chart-1)" } } satisfies ChartConfig;

function Verdict({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-4">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
      <p className="text-sm leading-relaxed text-pretty">{children}</p>
    </div>
  );
}

function CellCells({ c }: { c: Cell }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{c.events.toLocaleString()}</TableCell>
      <TableCell className="text-right tabular-nums">
        {pct1(c.upShare)}
        {c.upNoise != null && c.events > 0 && (
          <span className="ml-1 text-xs text-muted-foreground">± {(c.upNoise * 100).toFixed(1)}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Pct value={c.avg} fraction />
      </TableCell>
      <TableCell className="text-right">
        <Pct value={c.median} fraction />
      </TableCell>
      <TableCell className="pr-6 text-right tabular-nums">{pct1(c.avgSize)}</TableCell>
    </>
  );
}

const CONTEXT_GROUPS = [...new Set(CONTEXT.map((c) => c.group))];

function ContextGroup({ group, rows }: { group: string; rows: ContextRow[] }) {
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={6} className="bg-muted/40 pl-6 text-xs font-medium text-muted-foreground">
          {group}
        </TableCell>
      </TableRow>
      {rows.map((c) => (
        <TableRow key={c.key}>
          <TableCell className="pl-6">
            <div className="flex flex-col">
              <span>{c.label}</span>
              {c.rule && <span className="text-xs text-muted-foreground">{c.rule}</span>}
            </div>
          </TableCell>
          <CellCells c={c} />
        </TableRow>
      ))}
    </>
  );
}

function CellHead({ first }: { first: string }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="pl-6">{first}</TableHead>
        <TableHead className="text-right">Reports</TableHead>
        <TableHead className="text-right">After was up</TableHead>
        <TableHead className="text-right">Avg after</TableHead>
        <TableHead className="text-right">Median after</TableHead>
        <TableHead className="pr-6 text-right">Typical size after</TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function EarningsAnswer({
  events,
  spyDates,
  spyRet,
  hasLive,
}: {
  events: ExploreEvent[];
  spyDates: string[];
  spyRet: number[];
  hasLive: boolean;
}) {
  const [s, setS] = useState<AnswerSettings>(DEFAULT_ANSWER);
  const set = <K extends keyof AnswerSettings>(k: K, v: AnswerSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const prepared = useMemo(() => prepare(events, spyDates, spyRet), [events, spyDates, spyRet]);
  const deferred = useDeferredValue(s);
  const a = useMemo(() => answer(prepared, deferred), [prepared, deferred]);

  const before = friendly(s.pre);
  const after = friendly(s.post);
  const vs = s.excess ? " (minus SPY)" : "";
  const overlap = s.pre[1] >= s.post[0];
  const shown = a.points.filter((p) => Math.abs(p.x) <= CLIP && Math.abs(p.y) <= CLIP);

  // Plain-language reading of each number against the range chance alone produces.
  const dirReal = a.dirDiff != null && a.dirNoise != null && Math.abs(a.dirDiff) > a.dirNoise;
  const sizeReal = a.corrSize != null && a.corrNoise != null && a.corrSize > a.corrNoise;
  const quiet = a.buckets.find((b) => b.key === "flat");
  const onlyLabel = CONTEXT.find((c) => c.key === s.only)?.label ?? "";
  const big = a.buckets.filter((b) => b.key === "fell_big" || b.key === "rose_big");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>The question</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Does what a stock did in the days before its earnings report tell you what it does after? Day 0 is the first
            trading session after the report (the report day if it came before the open, the next day if after the
            close). Pick the two windows; everything below updates.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <WindowControl
            label="Before"
            value={s.pre}
            onChange={(v) => set("pre", v)}
            min={-PATH_DAYS}
            max={-1}
            presets={BEFORE}
          />
          <WindowControl
            label="After"
            value={s.post}
            onChange={(v) => set("post", v)}
            min={0}
            max={PATH_DAYS}
            presets={AFTER}
          />
          <div className="flex flex-wrap gap-x-6 gap-y-4 lg:col-span-2">
            <Control label="Moves measured as">
              <Toggle
                label="Moves measured as"
                value={s.excess ? "excess" : "plain"}
                onChange={(v) => set("excess", v === "excess")}
                options={[
                  { v: "plain", label: "Plain price change" },
                  { v: "excess", label: "Minus SPY (market removed)" },
                ]}
              />
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
            <Control label="Only reports where">
              <Select value={s.only} onValueChange={(v) => set("only", v)}>
                <SelectTrigger className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All reports</SelectItem>
                  {CONTEXT_GROUPS.map((g) => (
                    <SelectGroup key={g}>
                      <SelectLabel>{g}</SelectLabel>
                      {CONTEXT.filter((c) => c.group === g).map((c) => (
                        <SelectItem key={c.key} value={c.key}>
                          {c.label}
                          {c.after ? " (after the report)" : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </Control>
          </div>
          {s.only !== "all" && (
            <p className="text-xs text-muted-foreground lg:col-span-2">
              Showing only reports where: <strong className="text-foreground">{onlyLabel}</strong>. Every section below
              uses just these {a.events.toLocaleString()} reports.
              {CONTEXT.find((c) => c.key === s.only)?.after &&
                " EPS is known only once the report is out, so this can't be used to predict the reaction day."}
            </p>
          )}
          {overlap && <p className="text-xs text-warning lg:col-span-2">The windows overlap.</p>}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Verdict title="Direction → direction">
          {a.beforeUp.upShare == null || a.beforeDown.upShare == null ? (
            "Not enough reports."
          ) : (
            <>
              When the stock <strong>rose</strong> over {before}, it rose over {after} in{" "}
              <strong>{pct1(a.beforeUp.upShare)}</strong> of reports. When it <strong>fell</strong>, it rose in{" "}
              <strong>{pct1(a.beforeDown.upShare)}</strong>. Gap: {pts(a.dirDiff)}; chance alone easily makes a gap up
              to ± {pts(a.dirNoise)}.{" "}
              <strong>
                {dirReal
                  ? (a.dirDiff as number) > 0
                    ? "The gap is bigger than chance: moves tended to continue."
                    : "The gap is bigger than chance: moves tended to reverse."
                  : "No link: the direction before doesn't tell you the direction after."}
              </strong>
            </>
          )}
        </Verdict>
        <Verdict title="Size → size">
          {a.corrSize == null ? (
            "Not enough reports."
          ) : (
            <>
              A stock that moved within ±3% beforehand then moved <strong>{pct1(quiet?.avgSize ?? null)}</strong> on
              average (either way). One that moved more than 10% moved{" "}
              {big.map((b, i) => (
                <span key={b.key}>
                  {i > 0 && " / "}
                  <strong>{pct1(b.avgSize)}</strong>
                </span>
              ))}{" "}
              (fell / rose). Size correlation {a.corrSize.toFixed(2)}, chance range ± {a.corrNoise?.toFixed(2)}.{" "}
              <strong>
                {sizeReal
                  ? "Bigger moves before go with bigger moves after — but not in a predictable direction."
                  : "No link between the size before and the size after."}
              </strong>
            </>
          )}
        </Verdict>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1 · Direction before → after</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            {a.events.toLocaleString()} reports, split by whether the stock rose over {before}
            {vs}. &ldquo;± &rdquo; is the range chance alone easily produces (95%); reports on the same day move
            together, so treat it as a minimum. &ldquo;Typical size&rdquo; is the average move ignoring direction.
          </CardDescription>
        </CardHeader>
        <CardContent className="border-t px-0">
          <Table>
            <CellHead first={`Over ${before}`} />
            <TableBody>
              <TableRow>
                <TableCell className="pl-6">Rose</TableCell>
                <CellCells c={a.beforeUp} />
              </TableRow>
              <TableRow>
                <TableCell className="pl-6">Fell (or flat)</TableCell>
                <CellCells c={a.beforeDown} />
              </TableRow>
              <TableRow className="text-muted-foreground">
                <TableCell className="pl-6">All reports</TableCell>
                <CellCells c={a.all} />
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 · Size of the move before → after</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Same reports, split by how far the stock moved over {before}
            {vs}.
          </CardDescription>
        </CardHeader>
        <CardContent className="border-t px-0">
          <Table>
            <CellHead first={`Over ${before}`} />
            <TableBody>
              {a.buckets.map((b) => (
                <TableRow key={b.key}>
                  <TableCell className="pl-6">{b.label}</TableCell>
                  <CellCells c={b} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3 · Shape of the move before → after</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Named patterns over {before}
            {vs}, each with its rule. A report can match several. Compare each row with &ldquo;All reports&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent className="border-t px-0">
          <Table>
            <CellHead first="Pattern" />
            <TableBody>
              {a.patterns.map((p) => (
                <TableRow key={p.key}>
                  <TableCell className="pl-6">
                    <div className="flex flex-col">
                      <span>{p.label}</span>
                      <span className="text-xs text-muted-foreground">{p.rule}</span>
                    </div>
                  </TableCell>
                  <CellCells c={p} />
                </TableRow>
              ))}
              <TableRow className="text-muted-foreground">
                <TableCell className="pl-6">All reports</TableCell>
                <CellCells c={a.all} />
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4 · Other information before the report → after</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            Same after-move ({after}
            {vs}), split by information other than the price move. Insider buys count only once their Form 4 was filed,
            so the public could see them. Volume is measured over {before}. EPS is known only once the report is out: it
            can explain the reaction day but not predict it; the after-report days are the useful part. Compare each row
            with &ldquo;All reports&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent className="border-t px-0">
          <Table>
            <CellHead first="Group" />
            <TableBody>
              {CONTEXT_GROUPS.map((g) => (
                <ContextGroup key={g} group={g} rows={a.context.filter((c) => c.group === g)} />
              ))}
              <TableRow className="text-muted-foreground">
                <TableCell className="pl-6">All reports</TableCell>
                <CellCells c={a.all} />
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>5 · Every report, before vs after</CardTitle>
          <CardDescription className="max-w-3xl text-pretty">
            One dot per report: across = move over {before}, up = move over {after}
            {vs}. If the before-move predicted direction, the dots would lean from bottom-left to top-right (or the
            reverse); a round cloud means no link. Direction correlation{" "}
            <strong className="text-foreground">{a.corrDirection?.toFixed(2) ?? "—"}</strong>, size correlation{" "}
            <strong className="text-foreground">{a.corrSize?.toFixed(2) ?? "—"}</strong> (−1 opposite · 0 none · +1
            same; chance range ± {a.corrNoise?.toFixed(2) ?? "—"}).{" "}
            {a.points.length - shown.length > 0 &&
              `${(a.points.length - shown.length).toLocaleString()} reports beyond ±30% not drawn.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={scatterConfig} className="aspect-auto h-96 w-full">
            <ScatterChart margin={{ left: 4, right: 12, top: 8, bottom: 8 }}>
              <CartesianGrid />
              <XAxis
                type="number"
                dataKey="x"
                name="Before"
                domain={[-CLIP, CLIP]}
                tickFormatter={(v: number) => fmtSignedPct(v, true).replace(".0%", "%")}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="number"
                dataKey="y"
                name="After"
                domain={[-CLIP, CLIP]}
                width={52}
                tickFormatter={(v: number) => fmtSignedPct(v, true).replace(".0%", "%")}
                tickLine={false}
                axisLine={false}
              />
              <ZAxis range={[10, 10]} />
              <ReferenceLine x={0} stroke="var(--muted-foreground)" />
              <ReferenceLine y={0} stroke="var(--muted-foreground)" />
              <ChartTooltip
                cursor={false}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload as { x: number; y: number; t: string; d: string } | undefined;
                  if (!p) return null;
                  return (
                    <div className="rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                      <div className="font-mono font-medium">
                        {p.t} · {p.d}
                      </div>
                      <div>
                        Before <Pct value={p.x} fraction /> · After <Pct value={p.y} fraction />
                      </div>
                    </div>
                  );
                }}
              />
              <Scatter data={shown} fill="var(--color-pt)" fillOpacity={0.35} isAnimationActive={false} />
            </ScatterChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
