"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BriefcaseIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import { savePositionNote, addTransaction, deleteTransaction, getStockAnalysis } from "@/app/my-stocks/actions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/app/table-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Pct, TierBadge } from "@/components/app/cells";
import { daysAgo, fmtInr, fmtQty, fmtShares, fmtUsd, fmtUsdExact, shortDate } from "@/lib/format";

type Analysis = Awaited<ReturnType<typeof getStockAnalysis>>;

const CHANGE_META: Record<string, { label: string; variant: "positive" | "negative" | "warning" | "info" | "muted" }> = {
  new: { label: "New", variant: "info" },
  add: { label: "Added", variant: "positive" },
  trim: { label: "Trimmed", variant: "warning" },
  hold: { label: "Hold", variant: "muted" },
};

// SEC EDGAR page for a reporting person — every Form 4 there states their exact
// relationship/title to the issuer (officer title, director, 10% owner).
function secInsiderUrl(cik: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4&owner=include&count=40`;
}
function InsiderName({ name, cik }: { name: string; cik: string | null }) {
  if (!cik) return <span>{name}</span>;
  return (
    <a
      href={secInsiderUrl(cik)}
      target="_blank"
      rel="noreferrer"
      title="Who is this? → their SEC Form 4 filings (states their title/role)"
      className="underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 hover:text-foreground hover:decoration-foreground"
    >
      {name}
    </a>
  );
}

function StockAnalysisPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    getStockAnalysis(ticker)
      .then((a) => active && setData(a))
      .catch(() => active && setFailed(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [ticker]);

  if (loading) {
    return (
      <div className="mt-4 space-y-2 border-t pt-4">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (failed || !data) {
    return <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">Couldn&rsquo;t load analysis for {ticker}.</p>;
  }

  const empty =
    data.holders.length === 0 && data.exited.length === 0 && data.insiderBuys.length === 0 &&
    data.insiderSells.length === 0 && data.stakes.length === 0;

  return (
    <div className="mt-4 border-t pt-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="text-[11px] font-medium tracking-wide text-foreground uppercase">Smart-money &amp; insider read</span>
        {data.holders.length > 0 && (
          <span>
            <span className="font-medium text-foreground tabular-nums">{data.nFunds}</span> tracked funds hold it ·{" "}
            <span className="tabular-nums">{fmtUsd(data.totalValue)}</span> combined
          </span>
        )}
        {data.latestPeriod && <Badge variant="warning" className="font-normal">13F as of {data.latestPeriod} · 45-day delayed</Badge>}
      </div>

      {empty ? (
        <p className="text-xs text-muted-foreground">No tracked-fund 13F or insider records for {ticker}.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Fund holders */}
          {data.holders.length > 0 && (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Fund</TableHead>
                    <TableHead className="text-right">Position</TableHead>
                    <TableHead className="text-right">Est. entry</TableHead>
                    <TableHead className="text-right">Last qtr</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.holders.map((f) => {
                    const cm = CHANGE_META[f.change] ?? CHANGE_META.hold;
                    return (
                      <TableRow key={f.cik} className="hover:bg-transparent">
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {f.tier && <TierBadge tier={f.tier} />}
                            <span className="font-medium text-foreground">{f.name}</span>
                          </div>
                          <div className="text-[11px] text-muted-foreground capitalize">{f.category.replace(/_/g, " ")}</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtUsd(f.value)}
                          <div className="text-[11px] text-muted-foreground">{fmtShares(f.shares)} sh</div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {f.estCost != null ? `~${fmtUsdExact(f.estCost, true)}` : "—"}
                          {f.firstSeen && <div className="text-[11px] text-muted-foreground/70">since {f.firstSeen.slice(0, 7)}</div>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant={cm.variant} className="font-normal">{cm.label}</Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Funds that dropped it */}
          {data.exited.length > 0 && (
            <p className="text-xs">
              <span className="font-medium text-negative">Exited last quarter:</span>{" "}
              <span className="text-muted-foreground">
                {data.exited.map((e) => e.name).join(", ")}
              </span>
            </p>
          )}

          {/* Insider activity */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Insider buys (open market)
              </div>
              {data.insiderBuys.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">None recorded.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-xs">
                  {data.insiderBuys.map((t, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2">
                      <span className="truncate">
                        <span className="text-positive">▲</span> <InsiderName name={t.name} cik={t.cik} />
                        {t.title && <span className="text-muted-foreground"> · {t.title}</span>}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {shortDate(t.date)} · {fmtShares(t.shares)}{t.price != null ? ` @ ${fmtUsdExact(t.price, true)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Insider sells</div>
              {data.insiderSells.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">None recorded.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-xs">
                  {data.insiderSells.map((t, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2">
                      <span className="truncate">
                        <span className="text-negative">▼</span> <InsiderName name={t.name} cik={t.cik} />
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {shortDate(t.date)} · {fmtShares(t.shares)}{t.price != null ? ` @ ${fmtUsdExact(t.price, true)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Activist / passive stakes */}
          {data.stakes.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">13D / 13G stakes</div>
              <ul className="flex flex-col gap-1 text-xs">
                {data.stakes.map((s, i) => (
                  <li key={i} className="flex items-baseline justify-between gap-2">
                    <span>
                      <Badge variant={s.subtype.includes("13D") ? "warning" : "muted"} className="mr-1.5 font-normal">
                        {s.subtype}
                      </Badge>
                      {s.filer}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {s.pct != null ? `${s.pct.toFixed(1)}% · ` : ""}
                      {shortDate(s.date)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <p className="mt-3 text-[11px] text-muted-foreground/70">
        13F is a quarterly snapshot filed up to 45 days late — &ldquo;Est. entry&rdquo; is a VWAP-based estimate of a
        fund&rsquo;s average cost (±15–25%, never disclosed exactly), and an &ldquo;exit&rdquo; means the fund stopped
        reporting it. Only insider (Form 4) rows are real dated trades.
      </p>
    </div>
  );
}

export type Holding = {
  person: string;
  ticker: string;
  stock_name: string | null;
  qty: number;
  avg_cost: number;
  realized_pnl: number;
  current_price: number | null;
  target_price: number | null;
  comment: string | null;
  next_earnings: string | null;
  in_smart_money: boolean;
  return_1m: number | null;
};

export type SellLog = {
  id: number;
  person: string;
  ticker: string;
  stock_name: string | null;
  qty: number;
  price: number;
  trade_date: string;
  realized: number;
  cost_basis: number;
};

export type PocketCash = { deposited: number; withdrawn: number; net: number };

export type StockSignals = {
  insiderBuys: { count: number; latest: string | null };
  insiderSells: { count: number; latest: string | null };
  fundAdded: number;
  fundTrimmed: number;
  fundPeriod: string | null;
  activist: { subtype: string; filer: string; date: string } | null;
  buyScore: number | null;
};

const PEOPLE = ["Riya", "Vijay"] as const;
type Person = (typeof PEOPLE)[number];

function fmtDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtAsOf(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
/** Full-precision qty for form defaults (display uses fmtQty). */
function qtyFull(n: number): string {
  return Number(n.toFixed(6)).toString();
}
function toneText(n: number): string {
  return n > 0 ? "text-positive" : n < 0 ? "text-negative" : "text-muted-foreground";
}

function SmBadge() {
  return (
    <Badge variant="info" className="h-4 rounded-sm px-1 text-[10px]" title="Held by a tracked filer (smart money)">
      SM
    </Badge>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const router = useRouter();
  const cur = h.current_price;
  const uPnl = cur != null ? h.qty * (cur - h.avg_cost) : null;
  const uPct = cur != null && h.avg_cost ? (cur / h.avg_cost - 1) * 100 : null;

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(h.target_price != null ? String(h.target_price) : "");
  const [comment, setComment] = useState(h.comment ?? "");
  const [action, setAction] = useState<null | "buy" | "sell">(null);
  const [txQty, setTxQty] = useState("");
  const [txPrice, setTxPrice] = useState(cur != null ? String(cur) : "");
  const [, startSave] = useTransition();
  const [flash, setFlash] = useState(false);

  function flashSaved() {
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  }
  function saveTarget() {
    const v = target.trim() === "" ? null : Number(target);
    if (v != null && Number.isNaN(v)) return;
    startSave(async () => {
      await savePositionNote(h.person, h.ticker, { target_price: v });
      flashSaved();
    });
  }
  function saveComment() {
    startSave(async () => {
      await savePositionNote(h.person, h.ticker, { comment: comment.trim() || null });
      flashSaved();
    });
  }
  function openAction(a: "buy" | "sell") {
    setAction(a);
    setTxQty(a === "sell" ? qtyFull(h.qty) : "");
    setTxPrice(cur != null ? String(cur) : "");
  }
  function submitTxn() {
    const q = Number(txQty);
    const p = Number(txPrice);
    if (Number.isNaN(q) || q <= 0 || Number.isNaN(p) || p < 0) return;
    if (action === "sell" && q > h.qty + 1e-9) return;
    startSave(async () => {
      await addTransaction(h.person, h.ticker, action!, q, p);
      setAction(null);
      router.refresh();
    });
  }

  const targetNum = target.trim() !== "" && !Number.isNaN(Number(target)) ? Number(target) : null;
  const toTarget = cur != null && targetNum != null && targetNum > 0 ? (targetNum / cur - 1) * 100 : null;

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <TableCell className="w-8 pr-0">
          <ChevronRightIcon
            className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
          />
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">{h.stock_name ?? h.ticker}</span>
            {h.in_smart_money && <SmBadge />}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {h.ticker} · {fmtQty(h.qty)} sh
            {Math.abs(h.realized_pnl) > 0.005 && (
              <span className={cn("ml-1", h.realized_pnl >= 0 ? "text-positive/80" : "text-negative/80")}>
                · realized {h.realized_pnl >= 0 ? "+" : ""}
                {fmtUsdExact(h.realized_pnl, true)}
              </span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">{fmtUsdExact(h.avg_cost, true)}</TableCell>
        <TableCell className="text-right tabular-nums">{cur != null ? fmtUsdExact(cur, true) : "—"}</TableCell>
        <TableCell className="text-right tabular-nums">
          {uPnl == null ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            <span className={toneText(uPnl)}>
              {uPnl >= 0 ? "+" : ""}
              {fmtUsdExact(uPnl, true)} <Pct value={uPct} className="text-xs" />
            </span>
          )}
        </TableCell>
        <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
          <Input
            type="number"
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            onBlur={saveTarget}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="—"
            className="ml-auto h-7 w-24 text-right tabular-nums"
          />
          {toTarget != null && (
            <div className={cn("mt-0.5 text-[10px]", toTarget >= 0 ? "text-positive/80" : "text-negative/80")}>
              {toTarget >= 0 ? "+" : ""}
              {toTarget.toFixed(0)}% to target
            </div>
          )}
        </TableCell>
      </TableRow>

      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell />
          <TableCell colSpan={5} className="whitespace-normal pb-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="md:col-span-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    Notes (shared)
                  </span>
                  {flash && <span className="text-xs text-positive">saved ✓</span>}
                </div>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onBlur={saveComment}
                  placeholder="Why we hold this, thesis, exit plan…"
                  rows={3}
                  className="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                />
                <div className="mt-3">
                  {action === null ? (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="text-positive" onClick={() => openAction("buy")}>
                        Buy more
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => openAction("sell")}>
                        Sell
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">{action === "sell" ? "Sell" : "Buy"}</span>
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={txQty}
                        onChange={(e) => setTxQty(e.target.value)}
                        placeholder="qty"
                        className="h-7 w-24 text-right tabular-nums"
                      />
                      {action === "sell" && (
                        <Button variant="ghost" size="xs" onClick={() => setTxQty(qtyFull(h.qty / 2))}>
                          50%
                        </Button>
                      )}
                      <span className="text-xs text-muted-foreground">@</span>
                      <Input
                        type="number"
                        inputMode="decimal"
                        value={txPrice}
                        onChange={(e) => setTxPrice(e.target.value)}
                        className="h-7 w-24 text-right tabular-nums"
                      />
                      <Button
                        variant={action === "sell" ? "destructive" : "outline"}
                        size="sm"
                        className={action === "buy" ? "text-positive" : undefined}
                        onClick={submitTxn}
                      >
                        Confirm {action}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setAction(null)}>
                        cancel
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-lg border p-3">
                <div className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Scanner</div>
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Next earnings</dt>
                    <dd className="tabular-nums">{h.next_earnings ? fmtDate(h.next_earnings) : "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Smart money holds it</dt>
                    <dd className={h.in_smart_money ? "text-info" : "text-muted-foreground"}>
                      {h.in_smart_money ? "Yes" : "No"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">1-month move</dt>
                    <dd>
                      <Pct value={h.return_1m} fraction />
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground/70">Full smart-money &amp; insider read below ↓</p>
              </div>
            </div>

            <StockAnalysisPanel ticker={h.ticker} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function SoldRow({ s }: { s: SellLog }) {
  const router = useRouter();
  const [, startSave] = useTransition();
  const win = s.realized >= 0;
  const pct = s.cost_basis ? (s.price / s.cost_basis - 1) * 100 : 0;
  function del() {
    startSave(async () => {
      await deleteTransaction(s.id);
      router.refresh();
    });
  }
  return (
    <TableRow className="group">
      <TableCell>
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-foreground">{s.ticker}</span>
          {s.stock_name && s.stock_name !== s.ticker && (
            <span className="max-w-44 truncate text-xs text-muted-foreground">{s.stock_name}</span>
          )}
        </div>
        <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
          {fmtQty(s.qty)} sh · {fmtDate(s.trade_date)}
        </div>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className="text-muted-foreground">{fmtUsdExact(s.cost_basis, true)}</span>
        <span className="mx-1.5 text-muted-foreground/50">→</span>
        <span>{fmtUsdExact(s.price, true)}</span>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        <span className={cn("font-medium", win ? "text-positive" : "text-negative")}>
          {win ? "+" : ""}
          {fmtUsdExact(s.realized, true)}
        </span>{" "}
        <Pct value={pct} className="text-xs" />
      </TableCell>
      <TableCell className="w-8 text-right">
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-negative"
          title="Undo this sell"
          onClick={del}
        >
          <XIcon />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function PocketBand({ cash, value, usdInr }: { cash: PocketCash; value: number; usdInr: number | null }) {
  const currentInr = usdInr != null ? value * usdInr : null;
  const gain = currentInr != null ? currentInr - cash.net : null;
  const pct = gain != null && cash.net > 0 ? (gain / cash.net) * 100 : null;
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Overall — money from pocket (₹)
        </CardTitle>
        {usdInr != null && (
          <CardAction className="text-xs tabular-nums text-muted-foreground">
            {fmtUsdExact(value, true)} × ₹{usdInr.toFixed(2)}
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {currentInr == null || gain == null ? (
          <p className="text-sm text-muted-foreground">No USD/INR rate yet — can&rsquo;t compute rupee return.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">Net from pocket</span>{" "}
                <span className="tabular-nums">{fmtInr(cash.net)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Value today</span>{" "}
                <span className="tabular-nums">{fmtInr(currentInr)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Total gain</span>{" "}
                <span className={cn("font-semibold tabular-nums", gain >= 0 ? "text-positive" : "text-negative")}>
                  {gain >= 0 ? "+" : ""}
                  {fmtInr(gain)}
                  {pct != null && ` (${gain >= 0 ? "+" : ""}${pct.toFixed(1)}%)`}
                </span>
              </div>
            </div>
            {/* Vijay: owner asked to drop the deposited/withdrawn/provisional footnote (2026-10-03).
                The band still reads: net from pocket → value today → total gain. Deposit figures
                live in portfolio_cashflows and are still provisional until reconciled with INDmoney. */}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function sigHasActivity(s: StockSignals): boolean {
  return (
    s.insiderBuys.count > 0 ||
    s.insiderSells.count > 0 ||
    s.fundAdded > 0 ||
    s.fundTrimmed > 0 ||
    !!s.activist ||
    (s.buyScore != null && s.buyScore > 0)
  );
}
function sigLatest(s: StockSignals): string {
  return [s.insiderBuys.latest, s.insiderSells.latest, s.activist?.date ?? null]
    .filter(Boolean)
    .sort()
    .reverse()[0] as string ?? "";
}

function SignalsCard({ rows }: { rows: { ticker: string; name: string; s: StockSignals }[] }) {
  if (rows.length === 0) return null;
  return (
    <Card size="sm">
      <CardHeader className="border-b">
        <CardTitle className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Signals on your stocks
        </CardTitle>
        <CardAction className="text-[11px] text-muted-foreground">
          insider + activist = last 90 days (dated) · 13F = latest quarter, 45-day delayed
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        {rows.map(({ ticker, name, s }) => (
          <div key={ticker} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-xs first:pt-0 last:pb-0">
            <span className="w-32 shrink-0 truncate">
              <span className="font-mono font-medium text-foreground">{ticker}</span>
              <span className="ml-1.5 text-muted-foreground">{name}</span>
            </span>
            {s.insiderSells.count > 0 && (
              <Badge variant="negative" className="font-normal">
                ▼ {s.insiderSells.count} insider sell{s.insiderSells.count > 1 ? "s" : ""}
                {s.insiderSells.latest ? ` · ${daysAgo(s.insiderSells.latest)}` : ""}
              </Badge>
            )}
            {s.insiderBuys.count > 0 && (
              <Badge variant="positive" className="font-normal">
                ▲ {s.insiderBuys.count} insider buy{s.insiderBuys.count > 1 ? "s" : ""}
                {s.insiderBuys.latest ? ` · ${daysAgo(s.insiderBuys.latest)}` : ""}
              </Badge>
            )}
            {(s.fundAdded > 0 || s.fundTrimmed > 0) && (
              <span className="text-muted-foreground">
                funds <span className="text-positive">+{s.fundAdded}</span>
                <span className="mx-0.5">/</span>
                <span className="text-negative">−{s.fundTrimmed}</span>
                {s.fundPeriod ? ` (${s.fundPeriod.slice(0, 7)})` : ""}
              </span>
            )}
            {s.activist && (
              <Badge variant="warning" className="font-normal">
                {s.activist.subtype} · {s.activist.filer} · {daysAgo(s.activist.date)}
              </Badge>
            )}
            {s.buyScore != null && s.buyScore > 0 && (
              <Badge variant="info" className="font-normal" title="Confluence buy-signal score (open a row for its components)">
                Buy signal {s.buyScore.toFixed(0)}
              </Badge>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PersonView({
  person,
  holdings,
  sells,
  cash,
  usdInr,
  pricesAsOf,
  signals,
}: {
  person: Person;
  holdings: Holding[];
  sells: SellLog[];
  cash?: PocketCash;
  usdInr: number | null;
  pricesAsOf: string | null;
  signals: Record<string, StockSignals>;
}) {
  // Sorted by current market value (qty × current price), largest first.
  const curVal = (h: Holding) => h.qty * (h.current_price ?? h.avg_cost);
  const myHoldings = [...holdings].sort((a, b) => curVal(b) - curVal(a));
  const mySells = [...sells].sort((a, b) => b.trade_date.localeCompare(a.trade_date) || b.id - a.id);

  let invested = 0;
  let value = 0;
  for (const h of myHoldings) {
    invested += h.qty * h.avg_cost;
    value += h.qty * (h.current_price ?? h.avg_cost);
  }
  const uPnl = value - invested;
  const uPct = invested ? (uPnl / invested) * 100 : 0;

  let realizedTotal = 0;
  let wins = 0;
  for (const s of mySells) {
    realizedTotal += s.realized;
    if (s.realized >= 0) wins++;
  }
  const winRate = mySells.length ? Math.round((wins / mySells.length) * 100) : 0;

  // Active-signal rows for this person's holdings, freshest activity first.
  const sigRows = myHoldings
    .map((h) => ({ ticker: h.ticker, name: h.stock_name ?? h.ticker, s: signals[h.ticker] }))
    .filter((r): r is { ticker: string; name: string; s: StockSignals } => !!r.s && sigHasActivity(r.s))
    .sort((a, b) => sigLatest(b.s).localeCompare(sigLatest(a.s)));

  if (myHoldings.length === 0 && mySells.length === 0 && !cash) {
    return (
      <Empty className="border py-16">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BriefcaseIcon />
          </EmptyMedia>
          <EmptyTitle>No holdings yet</EmptyTitle>
          <EmptyDescription>{person}&rsquo;s holdings will go here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {cash && <PocketBand cash={cash} value={value} usdInr={usdInr} />}

      <SignalsCard rows={sigRows} />

      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div>
          <span className="text-muted-foreground">Invested</span>{" "}
          <span className="tabular-nums">{fmtUsdExact(invested, true)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Current value</span>{" "}
          <span className="tabular-nums">{fmtUsdExact(value, true)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Unrealized P&amp;L</span>{" "}
          <span className={cn("font-medium tabular-nums", uPnl >= 0 ? "text-positive" : "text-negative")}>
            {uPnl >= 0 ? "+" : ""}
            {fmtUsdExact(uPnl, true)} ({uPnl >= 0 ? "+" : ""}
            {uPct.toFixed(1)}%)
          </span>
        </div>
      </div>

      {myHoldings.length > 0 && (
        <TableCard title="Open positions" description="Yahoo prices (end-of-day) · average-cost basis.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Stock</TableHead>
                <TableHead className="text-right">Avg cost</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead className="text-right">Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {myHoldings.map((h) => (
                <HoldingRow key={h.ticker} h={h} />
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}

      <div className="flex items-center gap-3">
        <Separator className="flex-1 bg-negative/40" />
        <span className="text-xs font-medium tracking-wider text-negative/80 uppercase">Sold</span>
        <Separator className="flex-1 bg-negative/40" />
      </div>

      {mySells.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground">
          No closed trades yet — sell from a holding&rsquo;s ▸ menu.
        </p>
      ) : (
        <TableCard
          title="Closed trades"
          description={
            <span className="flex flex-wrap gap-x-6 gap-y-1">
              <span>
                Realized P&amp;L{" "}
                <span className={cn("font-semibold tabular-nums", realizedTotal >= 0 ? "text-positive" : "text-negative")}>
                  {realizedTotal >= 0 ? "+" : ""}
                  {fmtUsdExact(realizedTotal, true)}
                </span>
              </span>
              <span>
                Win rate <span className="tabular-nums text-foreground">{winRate}%</span> ({wins}/{mySells.length})
              </span>
            </span>
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Stock</TableHead>
                <TableHead className="text-right">Cost → Sell</TableHead>
                <TableHead className="text-right">Realized P&amp;L</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {mySells.map((s) => (
                <SoldRow key={s.id} s={s} />
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}

      <p className="text-xs text-muted-foreground/70">
        Prices from Yahoo{pricesAsOf ? `, as of ${fmtAsOf(pricesAsOf)}` : ""} — end-of-day, refreshed daily, not
        intraday. Average-cost basis. Open positions reconcile to the broker; realized P&amp;L / win rate on trades
        closed before our earliest record (Dec 2025) is approximate.
      </p>
    </div>
  );
}

export function MyStocksTabs({
  holdings,
  sells,
  cash = {},
  usdInr = null,
  pricesAsOf = null,
  signals = {},
}: {
  holdings: Holding[];
  sells: SellLog[];
  cash?: Record<string, PocketCash>;
  usdInr?: number | null;
  pricesAsOf?: string | null;
  signals?: Record<string, StockSignals>;
}) {
  return (
    <Tabs defaultValue={PEOPLE[0]} className="gap-4">
      <TabsList variant="line">
        {PEOPLE.map((p) => (
          <TabsTrigger key={p} value={p}>
            {p}
          </TabsTrigger>
        ))}
      </TabsList>
      {PEOPLE.map((p) => (
        <TabsContent key={p} value={p}>
          <PersonView
            person={p}
            holdings={holdings.filter((h) => h.person === p)}
            sells={sells.filter((s) => s.person === p)}
            cash={cash[p]}
            usdInr={usdInr}
            pricesAsOf={pricesAsOf}
            signals={signals}
          />
        </TabsContent>
      ))}
    </Tabs>
  );
}
