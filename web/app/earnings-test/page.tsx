import { FlaskConicalIcon } from "lucide-react";
import { Pct, Ticker } from "@/components/app/cells";
import { PageHeader } from "@/components/app/page-header";
import { TableCard } from "@/components/app/table-card";
import { EarningsAnswer } from "@/components/app/earnings-test/answer";
import { EarningsExplorer } from "@/components/app/earnings-test/explorer";
import { SeasonChart } from "@/components/app/earnings-test/season-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchEarningsTest, fetchExplorer, type CohortScore, type LiveEvent, type Spread } from "@/lib/earnings-test";

export const dynamic = "force-dynamic";

// Earnings test — Vijay's hypothesis that the move before an earnings report
// predicts the move after (CLAUDE.md §2.2 note on the earnings test). Every
// list here is sorted by date or by group number, never by return.

const SESSION = {
  bmo: "before open",
  intraday: "during market",
  amc: "after close",
  unknown: "time unknown",
};

const STATUS = {
  scheduled: { variant: "muted", label: "awaiting report" },
  reported: { variant: "muted", label: "awaiting close" },
  reacted: { variant: "info", label: "awaiting 20-day drift" },
  complete: { variant: "outline", label: "complete" },
  excluded: { variant: "warning", label: "excluded" },
  no_report: { variant: "warning", label: "no report" },
} as const;

function Fact({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

function SpreadFact({ label, s }: { label: string; s: Spread }) {
  if (s.seasons === 0) return <Fact label={label}>not enough seasons yet</Fact>;
  return (
    <Fact label={label}>
      <Pct value={s.mean} fraction /> per season{" · "}
      <span className="text-muted-foreground">
        t {s.t == null ? "—" : s.t.toFixed(2)} · above zero in {s.positive} of {s.seasons}
      </span>
    </Fact>
  );
}

function CohortCard({ title, description, s }: { title: string; description: string; s: CohortScore | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="text-pretty">{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {!s || s.events === 0 ? (
          <p className="text-sm text-muted-foreground sm:col-span-2">No measured reports yet.</p>
        ) : (
          <>
            <Fact label="Reports measured">
              {s.events.toLocaleString()}{" "}
              <span className="text-muted-foreground">({s.complete.toLocaleString()} with 20-day drift)</span>
            </Fact>
            <Fact label="Pre-move and reaction in the same direction">
              {s.same_sign == null ? "—" : `${(s.same_sign * 100).toFixed(1)}%`}
              <span className="text-muted-foreground"> (a coin flip is 50%)</span>
            </Fact>
            <SpreadFact label="Top − bottom group, reaction day" s={s.react_spread} />
            <SpreadFact label="Top − bottom group, next 20 days" s={s.drift_spread} />
            <Fact label="Rank correlation with pre-move">
              reaction {s.spearman_react == null ? "—" : s.spearman_react.toFixed(3)}
              {" · "}drift {s.spearman_drift == null ? "—" : s.spearman_drift.toFixed(3)}
            </Fact>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function QuintileTable({ s }: { s: CohortScore }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Pre-move group</TableHead>
          <TableHead className="text-right">Reports</TableHead>
          <TableHead className="text-right">Avg pre-move</TableHead>
          <TableHead className="text-right">Avg reaction</TableHead>
          <TableHead className="text-right">Median reaction</TableHead>
          <TableHead className="text-right">Reaction up</TableHead>
          <TableHead className="pr-6 text-right">Avg 20-day drift</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {s.quintiles.map((q) => (
          <TableRow key={q.q}>
            <TableCell className="pl-6">{q.q === 1 ? "1 · fell most" : q.q === 5 ? "5 · rose most" : q.q}</TableCell>
            <TableCell className="text-right tabular-nums">{q.events.toLocaleString()}</TableCell>
            <TableCell className="text-right">
              <Pct value={q.pre_excess} fraction />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={q.react_excess} fraction />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={q.react_median} fraction />
            </TableCell>
            <TableCell className="text-right tabular-nums">{(q.react_up_share * 100).toFixed(0)}%</TableCell>
            <TableCell className="pr-6 text-right">
              <Pct value={q.drift_excess} fraction />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function LogTable({ rows }: { rows: LiveEvent[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">Ticker</TableHead>
          <TableHead>Report</TableHead>
          <TableHead>Logged</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Pre-move</TableHead>
          <TableHead className="text-right">Reaction</TableHead>
          <TableHead className="pr-6 text-right">20-day drift</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.ticker + r.scheduled_date}>
            <TableCell className="pl-6">
              <Ticker>{r.ticker}</Ticker>
            </TableCell>
            <TableCell className="font-mono text-xs">
              {r.report_date ?? `${r.scheduled_date} (scheduled)`}
              {r.session && <span className="ml-2 font-sans text-muted-foreground">{SESSION[r.session]}</span>}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">{r.registered_at.slice(0, 10)}</TableCell>
            <TableCell>
              <span className="inline-flex items-center gap-1.5">
                <Badge variant={STATUS[r.status].variant} title={r.note ?? undefined}>
                  {STATUS[r.status].label}
                </Badge>
                {r.source === "late" && (
                  <Badge variant="warning" title="Logged after the reaction session opened, so it isn't scored">
                    logged late
                  </Badge>
                )}
              </span>
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.pre_excess} fraction />
            </TableCell>
            <TableCell className="text-right">
              <Pct value={r.react_excess} fraction />
            </TableCell>
            <TableCell className="pr-6 text-right">
              <Pct value={r.drift_excess} fraction />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default async function EarningsTestPage() {
  const [data, explorer] = await Promise.all([fetchEarningsTest(), fetchExplorer().catch(() => null)]);
  const title = "Earnings test";
  const description = (
    <>
      Does what a stock does in the days <em>before</em> its earnings report tell you what it does <em>after</em>?{" "}
      <strong className="font-medium text-foreground">Answer</strong> asks that directly: direction, size and shape
      before, against direction and size after. <strong className="font-medium text-foreground">Advanced</strong> ranks
      reports into groups season by season. <strong className="font-medium text-foreground">Fixed test</strong> is the
      one rule set before looking (10 days before vs the reaction day and 20 days after).{" "}
      <strong className="font-medium text-foreground">Live log</strong> records reports before they happen.
    </>
  );

  if (!data || !data.backtest) {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title={title} description={description} />
        <Empty className="border py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FlaskConicalIcon />
            </EmptyMedia>
            <EmptyTitle>Earnings test not set up yet</EmptyTitle>
            <EmptyDescription>
              {data
                ? "Run python -m ingest.earnings_test --backfill once to build the history."
                : "Apply migration 033, then run python -m ingest.earnings_test --backfill once."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const { backtest, live, log, computedAt, firstBacktestSeason } = data;
  const pending = log.filter((r) => ["scheduled", "reported", "reacted"].includes(r.status)).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={title}
        description={description}
        meta={
          <>
            {computedAt && <span>Scored {computedAt.slice(0, 10)}</span>}
            <span>{backtest.events.toLocaleString()} backtest reports</span>
            <span>{log.length.toLocaleString()} logged live</span>
            {pending > 0 && <span>{pending} awaiting prices</span>}
          </>
        }
      />

      <Tabs defaultValue="answer" className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="answer">Answer</TabsTrigger>
          <TabsTrigger value="explore">Advanced</TabsTrigger>
          <TabsTrigger value="fixed">Fixed test</TabsTrigger>
          <TabsTrigger value="live">Live log</TabsTrigger>
        </TabsList>

        <TabsContent value="answer">
          {explorer && explorer.events.length > 0 ? (
            <EarningsAnswer
              events={explorer.events}
              spyDates={explorer.spyDates}
              spyRet={explorer.spyRet}
              hasLive={explorer.events.some((e) => e.src === "live")}
            />
          ) : (
            <Empty className="border py-16">
              <EmptyDescription>
                No return paths stored yet. Run python -m ingest.earnings_test --backfill.
              </EmptyDescription>
            </Empty>
          )}
        </TabsContent>

        <TabsContent value="explore">
          {explorer && explorer.events.length > 0 ? (
            <EarningsExplorer
              events={explorer.events}
              spyDates={explorer.spyDates}
              spyRet={explorer.spyRet}
              sectors={explorer.sectors}
              hasLive={explorer.events.some((e) => e.src === "live")}
            />
          ) : (
            <Empty className="border py-16">
              <EmptyDescription>
                No return paths stored yet. Run python -m ingest.earnings_test --backfill.
              </EmptyDescription>
            </Empty>
          )}
        </TabsContent>

        <TabsContent value="fixed" className="flex flex-col gap-8">
          <div className="grid gap-4 lg:grid-cols-2">
            <CohortCard
              title="Backtest"
              description={`Every report since ${firstBacktestSeason ?? "2021Q4"} for the 30 largest stocks on the Earnings tab, rebuilt from Yahoo history. A backtest: the list is today's 30 largest, so it is made of companies that grew; ones that shrank or were delisted are missing.`}
              s={backtest}
            />
            <CohortCard
              title="Live log"
              description="Each upcoming report is written down before it happens, then measured once prices exist. This is the clean test; it grows by roughly one season per quarter."
              s={live}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>How to read the numbers</CardTitle>
            </CardHeader>
            <CardContent className="flex max-w-3xl flex-col gap-2 text-sm text-pretty text-muted-foreground">
              <p>
                <strong className="font-medium text-foreground">Top − bottom group</strong> is the average reaction of
                the 20% of reports whose stock rose most beforehand, minus the 20% that fell most, averaged over
                seasons. Above zero means moves continued; below zero means they reversed.
              </p>
              <p>
                <strong className="font-medium text-foreground">t</strong> is that average divided by its standard error
                across seasons. Beyond ±2 is unlikely to be chance (about 1 in 20). Seasons with fewer than 25 reports
                aren&rsquo;t scored. With 30 stocks a group holds about 6 reports, so one season alone says little; the
                count across seasons is what matters.
              </p>
              <p>
                The windows (10 days before, reaction session, 20 days after) were fixed before any result was seen.
                Trying other windows on the same data would find one that &ldquo;works&rdquo; by chance. Returns exclude
                trading costs, which are highest around earnings.
              </p>
            </CardContent>
          </Card>

          <TableCard
            title="Backtest by pre-move group"
            description="Groups are formed within each season, then pooled. Group 1 fell most against SPY in the 10 days before the report; group 5 rose most."
          >
            {backtest.quintiles.length === 0 ? (
              <Empty className="py-10">
                <EmptyDescription>No season has 25 reports yet.</EmptyDescription>
              </Empty>
            ) : (
              <QuintileTable s={backtest} />
            )}
          </TableCard>

          {live && live.quintiles.length > 0 && (
            <TableCard title="Live log by pre-move group" description="Same table, live log only.">
              <QuintileTable s={live} />
            </TableCard>
          )}

          <TableCard
            title="Top − bottom group, season by season (backtest)"
            description="One experiment per earnings season. If the pre-move predicts the reaction, the bars sit on the same side of zero most seasons."
          >
            <div className="px-6 pb-2">
              <SeasonChart data={backtest.seasons} />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Season</TableHead>
                  <TableHead className="text-right">Reports</TableHead>
                  <TableHead className="text-right">Reaction day</TableHead>
                  <TableHead className="pr-6 text-right">Next 20 days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...backtest.seasons].reverse().map((s) => (
                  <TableRow key={s.season}>
                    <TableCell className="pl-6 font-mono text-xs">{s.season}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.events.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <Pct value={s.react_spread} fraction />
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Pct value={s.drift_spread} fraction />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        </TabsContent>

        <TabsContent value="live">
          <TableCard
            title="Live log"
            description="Newest first. Reports are logged up to 7 days ahead from the Earnings tab's calendar. A report logged after its reaction session opened is marked 'logged late' and left out of the score."
          >
            {log.length === 0 ? (
              <Empty className="py-10">
                <EmptyDescription>
                  Nothing logged yet. The daily job logs reports scheduled in the next 7 days.
                </EmptyDescription>
              </Empty>
            ) : (
              <LogTable rows={log} />
            )}
          </TableCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
