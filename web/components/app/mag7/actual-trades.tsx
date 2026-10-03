"use client";

import { useState, useTransition } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addActualTrade, deleteActualTrade } from "@/lib/mag7-actions";
import { LAG7_TICKERS, type ActualTrade } from "@/lib/mag7-math";
import { fmtSharesExact, fmtUsdExact } from "@/lib/format";

type Field = "price" | "amount" | "shares";
const FIELDS: Field[] = ["price", "amount", "shares"];

// Fill any two of price / amount / shares; the third is calculated from them.
function derive(vals: Record<Field, string>, out: Field): string {
  const p = parseFloat(vals.price);
  const a = parseFloat(vals.amount);
  const s = parseFloat(vals.shares);
  const v = out === "price" ? a / s : out === "amount" ? p * s : a / p;
  if (!Number.isFinite(v) || v <= 0) return "";
  return out === "shares" ? String(+v.toFixed(6)) : v.toFixed(2);
}

export function ActualTrades({ trades, editable }: { trades: ActualTrade[]; editable: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [ticker, setTicker] = useState<string>("");
  const [vals, setVals] = useState<Record<Field, string>>({ price: "", amount: "", shares: "" });
  const [edited, setEdited] = useState<Field[]>([]); // most recent first
  const [note, setNote] = useState("");
  const [passcode, setPasscode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const derived: Field | null = edited.length >= 2 ? FIELDS.find((f) => !edited.slice(0, 2).includes(f))! : null;

  function onNumber(f: Field, v: string) {
    const nextEdited = [f, ...edited.filter((x) => x !== f)];
    const next = { ...vals, [f]: v };
    const out = nextEdited.length >= 2 ? FIELDS.find((x) => !nextEdited.slice(0, 2).includes(x))! : null;
    if (out) next[out] = derive(next, out);
    setEdited(nextEdited);
    setVals(next);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    startTransition(async () => {
      const r = await addActualTrade({
        passcode,
        trade_date: date,
        side,
        ticker,
        price: parseFloat(vals.price),
        amount: parseFloat(vals.amount),
        shares: parseFloat(vals.shares),
        note,
      });
      if (r.ok) {
        setVals({ price: "", amount: "", shares: "" });
        setEdited([]);
        setNote("");
        setMsg({ ok: true, text: "Saved." });
      } else setMsg({ ok: false, text: r.error });
    });
  }

  function remove(id: number) {
    if (!passcode) return setMsg({ ok: false, text: "Enter the passcode first." });
    if (!confirm("Delete this trade from your ledger?")) return;
    startTransition(async () => {
      const r = await deleteActualTrade(id, passcode);
      setMsg(r.ok ? { ok: true, text: "Deleted." } : { ok: false, text: r.error });
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="flex flex-col gap-4 px-6">
        <fieldset disabled={!editable || pending} className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m7-date">Transaction date</Label>
            <Input
              id="m7-date"
              type="date"
              max={today}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Side</Label>
            <Select value={side} onValueChange={(v) => setSide(v as "buy" | "sell")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">Buy</SelectItem>
                <SelectItem value="sell">Sell</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Ticker</Label>
            <Select value={ticker} onValueChange={setTicker}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick" />
              </SelectTrigger>
              <SelectContent>
                {LAG7_TICKERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {FIELDS.map((f) => (
            <div key={f} className="flex flex-col gap-1.5">
              <Label htmlFor={`m7-${f}`}>
                {f === "price" ? "Price / share" : f === "amount" ? "Amount ($)" : "# of shares"}
                {derived === f && <span className="font-normal text-muted-foreground">· calculated</span>}
              </Label>
              <Input
                id={`m7-${f}`}
                inputMode="decimal"
                value={vals[f]}
                onChange={(e) => onNumber(f, e.target.value)}
                className={derived === f ? "bg-muted/50" : undefined}
                required
              />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m7-note">Note</Label>
            <Input id="m7-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m7-pass">Passcode</Label>
            <Input id="m7-pass" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="sm" disabled={!editable || pending || !ticker}>
            <PlusIcon data-icon="inline-start" />
            Add trade
          </Button>
          {!editable && (
            <span className="text-xs text-muted-foreground">
              Editing is off on this server (MAG7_EDIT_PASSCODE not set).
            </span>
          )}
          {msg && <span className={msg.ok ? "text-xs text-positive" : "text-xs text-negative"}>{msg.text}</span>}
        </div>
      </form>

      {trades.length === 0 ? (
        <p className="px-6 pb-2 text-sm text-muted-foreground">
          No trades yet. Add your fills here after you place them in Robinhood.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-6">Date</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Ticker</TableHead>
              <TableHead className="text-right">Shares</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...trades].reverse().map((t) => (
              <TableRow key={t.id}>
                <TableCell className="pl-6 font-mono text-xs">{t.trade_date}</TableCell>
                <TableCell>
                  <Badge variant={t.side === "buy" ? "positive" : "negative"}>{t.side}</Badge>
                </TableCell>
                <TableCell className="font-mono">{t.ticker}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtSharesExact(t.shares)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsdExact(t.price, true)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtUsdExact(t.amount, true)}</TableCell>
                <TableCell className="text-muted-foreground">{t.note}</TableCell>
                <TableCell className="pr-6 text-right">
                  {editable && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Delete ${t.side} ${t.ticker} on ${t.trade_date}`}
                      disabled={pending}
                      onClick={() => remove(t.id)}
                    >
                      <Trash2Icon />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
