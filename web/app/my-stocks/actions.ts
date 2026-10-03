"use server";

import { supabaseServer } from "@/lib/supabase";

// Per-stock metadata (target price / shared comment) — lives on portfolio_positions.
// NOTE: public server actions. Once /my-stocks is deployed publicly with no gate,
// anyone with the link can call these. Acceptable per the owner's decision.
export async function savePositionNote(
  person: string,
  ticker: string,
  fields: { target_price?: number | null; comment?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseServer();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("target_price" in fields) patch.target_price = fields.target_price;
  if ("comment" in fields) patch.comment = fields.comment;
  const { error } = await sb
    .from("portfolio_positions")
    .update(patch)
    .eq("person", person)
    .eq("ticker", ticker);
  return error ? { ok: false, error: error.message } : { ok: true };
}

// Append a buy or sell to the ledger. Net qty / avg cost / realized P&L are derived.
export async function addTransaction(
  person: string,
  ticker: string,
  txnType: "buy" | "sell",
  qty: number,
  price: number,
  tradeDate?: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!(qty > 0) || !(price >= 0)) return { ok: false, error: "Invalid quantity or price." };
  const sb = supabaseServer();
  const { error } = await sb.from("portfolio_transactions").insert({
    person,
    ticker,
    txn_type: txnType,
    qty,
    price,
    trade_date: tradeDate || new Date().toISOString().slice(0, 10),
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

// Undo a single transaction (e.g. a mistaken sell).
export async function deleteTransaction(id: number): Promise<{ ok: boolean; error?: string }> {
  const sb = supabaseServer();
  const { error } = await sb.from("portfolio_transactions").delete().eq("id", id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
