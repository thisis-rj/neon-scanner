"use server";

import { supabaseServer } from "@/lib/supabase";
import { filerInfo } from "@/lib/filers";

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

// ── Per-stock analysis for the My Stocks ▸ dropdown ─────────────────────────
// Vijay: this reuses YOUR data model — holdings_13f_effective (23/25),
// filer_position_cost (14), cusip_ticker_map (16), insider_transactions (24),
// events_form4 / events_13d, and lib/filers.ts for tiers. No new data logic.
//
// Honest limits baked in: 13F is a quarterly snapshot filed 45 days late, so
// for FUNDS there is no trade date or fill price — `estCost` is filer_position_cost's
// *estimate* (shares added that quarter × that quarter's VWAP), and a fund "exit"
// just means they stopped reporting it. Only insiders (Form 4) carry real dated fills.

type Holder = {
  cik: string;
  name: string;
  tier: "S" | "A" | "B" | "C" | null;
  category: string;
  shares: number;
  value: number;
  period: string;
  change: "new" | "add" | "trim" | "hold";
  estCost: number | null;
  firstSeen: string | null;
};
type Insider = { name: string; title: string | null; cik: string | null; date: string; shares: number; price: number | null };
type Stake = { filer: string; subtype: string; pct: number | null; date: string };

export async function getStockAnalysis(ticker: string): Promise<{
  ticker: string;
  cusip: string | null;
  issuer: string | null;
  latestPeriod: string | null;
  nFunds: number;
  totalValue: number;
  holders: Holder[];
  exited: { name: string; period: string }[];
  insiderBuys: Insider[];
  insiderSells: Insider[];
  stakes: Stake[];
}> {
  const sb = supabaseServer();

  // ticker → cusip (13F holdings are keyed by cusip; the ticker column is often null)
  const { data: mapRows } = await sb.from("cusip_ticker_map").select("cusip,name").eq("ticker", ticker).limit(1);
  const cusip = mapRows?.[0]?.cusip ?? null;
  let issuer: string | null = mapRows?.[0]?.name ?? null;

  const holders: Holder[] = [];
  const exited: { name: string; period: string }[] = [];
  let latestPeriod: string | null = null;
  let totalValue = 0;

  if (cusip) {
    const { data: hRows } = await sb
      .from("holdings_13f_effective")
      .select("cik,period_of_report,shares,value_usd,issuer_name")
      .eq("cusip", cusip)
      .order("period_of_report", { ascending: false })
      .limit(3000);
    const rows = hRows ?? [];
    if (rows.length && !issuer) issuer = rows[0].issuer_name as string;

    const periods = [...new Set(rows.map((r) => String(r.period_of_report)))].sort().reverse();
    latestPeriod = periods[0] ?? null;
    const priorPeriod = periods[1] ?? null;

    const byFund = new Map<string, { period: string; shares: number; value: number }[]>();
    for (const r of rows) {
      const cik = String(r.cik);
      if (!byFund.has(cik)) byFund.set(cik, []);
      byFund.get(cik)!.push({
        period: String(r.period_of_report),
        shares: Number(r.shares ?? 0),
        value: Number(r.value_usd ?? 0),
      });
    }

    // estimated cost basis per filer (latest as_of wins)
    const { data: costRows } = await sb
      .from("filer_position_cost")
      .select("cik,estimated_cost_basis,first_seen_period,as_of_period")
      .eq("ticker", ticker);
    const costByCik = new Map<string, { est: number | null; first: string | null; asof: string }>();
    for (const c of costRows ?? []) {
      const cik = String(c.cik);
      const prev = costByCik.get(cik);
      const asof = String(c.as_of_period ?? "");
      if (!prev || asof > prev.asof) {
        costByCik.set(cik, {
          est: c.estimated_cost_basis == null ? null : Number(c.estimated_cost_basis),
          first: c.first_seen_period == null ? null : String(c.first_seen_period),
          asof,
        });
      }
    }

    for (const [cik, list] of byFund) {
      list.sort((a, b) => b.period.localeCompare(a.period));
      const info = filerInfo(cik);
      // 13F readers skip corporate_strategic (they signal via 8-K/13D, not 13F)
      if (info?.category === "corporate_strategic") continue;
      const mine = list[0];
      if (latestPeriod && mine.period === latestPeriod && mine.shares > 0) {
        const prior = list[1];
        let change: Holder["change"] = "hold";
        if (!prior) change = "new";
        else if (mine.shares > prior.shares * 1.1) change = "add";
        else if (mine.shares < prior.shares * 0.9) change = "trim";
        const cost = costByCik.get(cik);
        holders.push({
          cik,
          name: info?.manager ?? info?.entity ?? cik,
          tier: info?.signalTier ?? null,
          category: info?.category ?? "?",
          shares: mine.shares,
          value: mine.value,
          period: mine.period,
          change,
          estCost: cost?.est ?? null,
          firstSeen: cost?.first ?? null,
        });
        totalValue += mine.value;
      } else if (priorPeriod && mine.period === priorPeriod) {
        exited.push({ name: info?.manager ?? info?.entity ?? cik, period: mine.period });
      }
    }

    // Largest holder first (by position value). Tier is shown per row, not sorted on.
    holders.sort((a, b) => b.value - a.value);
  }

  // Insider open-market buys (universe-wide, code P) — real dated fills
  const { data: buys } = await sb
    .from("insider_transactions")
    .select("reporter_name,officer_title,reporter_cik,transaction_date,shares,price")
    .eq("issuer_ticker", ticker)
    .eq("transaction_code", "P")
    .order("transaction_date", { ascending: false })
    .limit(6);
  const insiderBuys: Insider[] = (buys ?? []).map((b) => ({
    name: String(b.reporter_name),
    title: b.officer_title == null ? null : String(b.officer_title),
    cik: b.reporter_cik == null ? null : String(b.reporter_cik),
    date: String(b.transaction_date),
    shares: Number(b.shares ?? 0),
    price: b.price == null ? null : Number(b.price),
  }));

  // Insider sells (events_form4, code S). No title column here — the name links
  // to the filer's SEC page (every Form 4 states their relationship/title).
  const { data: sells } = await sb
    .from("events_form4")
    .select("reporter_name,reporter_cik,transaction_date,shares,price")
    .eq("ticker", ticker)
    .eq("transaction_code", "S")
    .order("transaction_date", { ascending: false })
    .limit(6);
  const insiderSells: Insider[] = (sells ?? []).map((s) => ({
    name: String(s.reporter_name),
    title: null,
    cik: s.reporter_cik == null ? null : String(s.reporter_cik),
    date: String(s.transaction_date),
    shares: Number(s.shares ?? 0),
    price: s.price == null ? null : Number(s.price),
  }));

  // 13D / 13G stakes by tracked filers (best-effort; ticker is often null on these)
  const { data: st } = await sb
    .from("events_13d")
    .select("cik,form_subtype,percent_owned,event_date")
    .eq("ticker", ticker)
    .order("event_date", { ascending: false })
    .limit(6);
  const stakes: Stake[] = (st ?? []).map((s) => {
    const info = filerInfo(String(s.cik));
    return {
      filer: info?.manager ?? info?.entity ?? String(s.cik),
      subtype: String(s.form_subtype),
      pct: s.percent_owned == null ? null : Number(s.percent_owned),
      date: String(s.event_date),
    };
  });

  return { ticker, cusip, issuer, latestPeriod, nFunds: holders.length, totalValue, holders, exited, insiderBuys, insiderSells, stakes };
}
