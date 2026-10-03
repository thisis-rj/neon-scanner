"use server";

import { timingSafeEqual } from "node:crypto";
import { revalidatePath } from "next/cache";
import { supabaseServer } from "@/lib/supabase";
import { LAG7_TICKERS, START_CAPITAL, actualSleeve, type ActualTrade } from "@/lib/mag7-math";

export type ActionResult = { ok: true } | { ok: false; error: string };

// The site has no login, so edits to YOUR trade ledger need the passcode in
// MAG7_EDIT_PASSCODE. Unset → editing is off everywhere (safe default).
function passcodeOk(given: string): boolean {
  const want = process.env.MAG7_EDIT_PASSCODE;
  if (!want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadLedger(): Promise<ActualTrade[]> {
  const { data } = await supabaseServer()
    .from("mag7_actual_trades")
    .select("id,trade_date,side,ticker,shares,price,amount,note");
  return (data ?? []).map((t) => ({ ...t, shares: +t.shares, price: +t.price, amount: +t.amount }));
}

export async function addActualTrade(input: {
  passcode: string;
  trade_date: string;
  side: string;
  ticker: string;
  shares: number;
  price: number;
  amount: number;
  note?: string;
}): Promise<ActionResult> {
  if (!process.env.MAG7_EDIT_PASSCODE)
    return { ok: false, error: "Editing is off: MAG7_EDIT_PASSCODE is not set on the server." };
  if (!passcodeOk(input.passcode)) return { ok: false, error: "Wrong passcode." };

  const { trade_date, side, ticker, shares, price, amount } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trade_date)) return { ok: false, error: "Pick a transaction date." };
  if (trade_date > new Date().toISOString().slice(0, 10)) return { ok: false, error: "Date is in the future." };
  if (side !== "buy" && side !== "sell") return { ok: false, error: "Side must be buy or sell." };
  if (!(LAG7_TICKERS as readonly string[]).includes(ticker))
    return { ok: false, error: "Ticker must be one of the Lag7 universe." };
  if (![shares, price, amount].every((n) => Number.isFinite(n) && n > 0))
    return { ok: false, error: "Shares, price and amount must all be positive." };
  if (Math.abs(shares * price - amount) > Math.max(1, amount * 0.01))
    return { ok: false, error: `Shares × price = ${(shares * price).toFixed(2)}, but amount is ${amount.toFixed(2)}.` };

  const sleeve = actualSleeve(await loadLedger());
  if (side === "sell" && shares > (sleeve.shares[ticker] ?? 0) + 1e-6)
    return {
      ok: false,
      error: `The sleeve owns ${sleeve.shares[ticker] ?? 0} ${ticker}. Only shares this strategy bought can be sold here.`,
    };
  if (side === "buy" && amount > sleeve.cash + 1)
    return {
      ok: false,
      error: `Sleeve cash is $${sleeve.cash.toFixed(2)}. The strategy never adds money beyond the first $${START_CAPITAL.toLocaleString()}.`,
    };

  const { error } = await supabaseServer()
    .from("mag7_actual_trades")
    .insert({ trade_date, side, ticker, shares, price, amount, note: input.note?.trim() || null });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/lag7");
  return { ok: true };
}

export async function deleteActualTrade(id: number, passcode: string): Promise<ActionResult> {
  if (!passcodeOk(passcode)) return { ok: false, error: "Wrong or missing passcode." };
  const { error } = await supabaseServer().from("mag7_actual_trades").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/lag7");
  return { ok: true };
}
