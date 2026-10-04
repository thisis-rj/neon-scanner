import { supabaseServer } from "@/lib/supabase";
import { PageHeader } from "@/components/app/page-header";
import { MyStocksTabs, type Holding, type SellLog, type PocketCash } from "@/components/MyStocksTabs";

export const dynamic = "force-dynamic";

type Txn = {
  id: number;
  person: string;
  ticker: string;
  txn_type: string;
  qty: number;
  price: number;
  trade_date: string;
};

async function loadData(): Promise<{
  holdings: Holding[];
  sells: SellLog[];
  cash: Record<string, PocketCash>;
  usdInr: number | null;
  pricesAsOf: string | null;
}> {
  const sb = supabaseServer();

  const { data: txRaw, error: txErr } = await sb
    .from("portfolio_transactions")
    .select("id,person,ticker,txn_type,qty,price,trade_date");
  if (txErr) throw txErr;
  const txns: Txn[] = (txRaw ?? []).map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    person: String(r.person),
    ticker: String(r.ticker),
    txn_type: String(r.txn_type),
    qty: Number(r.qty),
    price: Number(r.price),
    trade_date: String(r.trade_date),
  }));

  const { data: posRaw } = await sb
    .from("portfolio_positions")
    .select("person,ticker,stock_name,qty,current_price,target_price,comment,updated_at");
  // Freshness of the price snapshot (newest portfolio_positions.updated_at).
  let pricesAsOf: string | null = null;
  for (const p of posRaw ?? []) {
    const u = p.updated_at == null ? null : String(p.updated_at);
    if (u && (!pricesAsOf || u > pricesAsOf)) pricesAsOf = u;
  }
  const meta = new Map<
    string,
    {
      stock_name: string | null;
      broker_qty: number;
      current_price: number | null;
      target_price: number | null;
      comment: string | null;
    }
  >();
  for (const p of posRaw ?? []) {
    meta.set(`${p.person}|${p.ticker}`, {
      stock_name: p.stock_name == null ? null : String(p.stock_name),
      broker_qty: p.qty == null ? 0 : Number(p.qty),
      current_price: p.current_price == null ? null : Number(p.current_price),
      target_price: p.target_price == null ? null : Number(p.target_price),
      comment: p.comment == null ? null : String(p.comment),
    });
  }

  const tickers = [...new Set(txns.map((t) => t.ticker))];
  const em = new Map<string, { next_earnings: string | null; in_smart_money: boolean; return_1m: number | null }>();
  if (tickers.length) {
    const { data: earn } = await sb
      .from("earnings_calendar")
      .select("ticker,next_earnings,in_smart_money,return_1m")
      .in("ticker", tickers);
    for (const e of earn ?? []) {
      em.set(String(e.ticker), {
        next_earnings: e.next_earnings ?? null,
        in_smart_money: Boolean(e.in_smart_money),
        return_1m: e.return_1m == null ? null : Number(e.return_1m),
      });
    }
  }

  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    const k = `${t.person}|${t.ticker}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }

  const holdings: Holding[] = [];
  const sells: SellLog[] = [];

  for (const [k, list] of groups) {
    list.sort((a, b) => a.trade_date.localeCompare(b.trade_date) || a.id - b.id);
    const [person, ticker] = k.split("|");
    const m = meta.get(k);
    const e = em.get(ticker);
    let qty = 0;
    let avgCost = 0;
    let realized = 0;
    for (const t of list) {
      if (t.txn_type === "buy") {
        const nq = qty + t.qty;
        avgCost = nq > 0 ? (qty * avgCost + t.qty * t.price) / nq : 0;
        qty = nq;
      } else {
        const sq = Math.min(t.qty, qty); // guard against overselling
        // Skip basis-less sells (opening lot predates our earliest record).
        if (sq <= 1e-6) continue;
        const r = sq * (t.price - avgCost);
        realized += r;
        qty -= sq;
        sells.push({
          id: t.id,
          person,
          ticker,
          stock_name: m?.stock_name ?? ticker,
          qty: t.qty,
          price: t.price,
          trade_date: t.trade_date,
          realized: r,
          cost_basis: avgCost,
        });
      }
    }
    // Open iff the broker currently reports it (also suppresses rounding dust).
    if ((m?.broker_qty ?? 0) > 1e-6) {
      holdings.push({
        person,
        ticker,
        stock_name: m?.stock_name ?? null,
        qty,
        avg_cost: avgCost,
        realized_pnl: realized,
        current_price: m?.current_price ?? null,
        target_price: m?.target_price ?? null,
        comment: m?.comment ?? null,
        next_earnings: e?.next_earnings ?? null,
        in_smart_money: e?.in_smart_money ?? false,
        return_1m: e?.return_1m ?? null,
      });
    }
  }

  // Pocket cash flows (INR): deposits/withdrawals from the investor's pocket.
  const { data: cfRaw } = await sb.from("portfolio_cashflows").select("person,amount_inr");
  const cash: Record<string, PocketCash> = {};
  for (const c of cfRaw ?? []) {
    const p = String(c.person);
    const a = Number(c.amount_inr);
    if (!cash[p]) cash[p] = { deposited: 0, withdrawn: 0, net: 0 };
    if (a >= 0) cash[p].deposited += a;
    else cash[p].withdrawn += -a;
    cash[p].net += a;
  }

  // Live-ish USD/INR (refreshed by the daily price job).
  const { data: fxRaw } = await sb.from("fx_rates").select("rate").eq("pair", "USDINR").maybeSingle();
  const usdInr = fxRaw?.rate != null ? Number(fxRaw.rate) : null;

  return { holdings, sells, cash, usdInr, pricesAsOf };
}

export default async function MyStocksPage() {
  const { holdings, sells, cash, usdInr, pricesAsOf } = await loadData();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="My Stocks"
        description="Personal portfolios with P&L — buy more, sell (full or partial), set targets, jot notes, and open a row for the scanner. Overall return is measured in ₹ against money actually put in from pocket."
      />
      <MyStocksTabs holdings={holdings} sells={sells} cash={cash} usdInr={usdInr} pricesAsOf={pricesAsOf} />
    </div>
  );
}
