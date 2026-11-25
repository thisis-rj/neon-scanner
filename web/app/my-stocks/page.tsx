import { supabaseServer } from "@/lib/supabase";
import { filerInfo } from "@/lib/filers";
import { PageHeader } from "@/components/app/page-header";
import { MyStocksTabs, type Holding, type SellLog, type PocketCash, type StockSignals, type InsiderTrade } from "@/components/MyStocksTabs";

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
  signals: Record<string, StockSignals>;
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

  // ── Active signals on held stocks ─────────────────────────────────────────
  // ACTIVE (dated, filed within days): insider Form 4 buys/sells + activist 13D,
  // last 90 days. LAGGING context: latest-quarter 13F fund adds/trims (quarterly,
  // 45-day delayed). Each insider trade is kept (name, role, date, amount); the
  // card shows a count pill per ticker and lists the trades on click.
  const heldTickers = [...new Set(holdings.map((h) => h.ticker))];
  const signals: Record<string, StockSignals> = {};
  const sig = (t: string): StockSignals =>
    (signals[t] ??= {
      insiderBuys: [],
      insiderSells: [],
      fundAdded: 0,
      fundTrimmed: 0,
      fundPeriod: null,
      fundMoves: [],
      activist: null,
    });
  if (heldTickers.length) {
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    // Role label from the Form 4 reporter flags.
    const roleOf = (r: Record<string, unknown>): string | null => {
      if (r.officer_title) return String(r.officer_title);
      if (r.reporter_is_director) return "Director";
      if (r.reporter_is_ten_pct) return "10% owner";
      if (r.reporter_is_officer) return "Officer";
      return null;
    };

    // Insider BUYS (open-market, code P) — insider_transactions carries role + $ value.
    const { data: ib } = await sb
      .from("insider_transactions")
      .select("issuer_ticker,reporter_cik,reporter_name,officer_title,reporter_is_director,reporter_is_officer,reporter_is_ten_pct,transaction_date,shares,price,value_usd,is_10b5_1")
      .in("issuer_ticker", heldTickers)
      .eq("transaction_code", "P")
      .gte("transaction_date", since)
      .order("transaction_date", { ascending: false });
    for (const r of ib ?? []) {
      const shares = r.shares == null ? null : Number(r.shares);
      const price = r.price == null ? null : Number(r.price);
      sig(String(r.issuer_ticker)).insiderBuys.push({
        name: String(r.reporter_name),
        role: roleOf(r),
        date: String(r.transaction_date),
        amount: r.value_usd != null ? Number(r.value_usd) : shares != null && price != null ? shares * price : null,
        planned: r.is_10b5_1 == null ? null : Boolean(r.is_10b5_1),
        usualX: null,
        record: false,
      });
    }

    // Insider SELLS (code S) live in events_form4 (role columns from migration 037).
    const { data: isl } = await sb
      .from("events_form4")
      .select("ticker,reporter_cik,reporter_name,officer_title,is_director,is_officer,is_ten_pct,is_10b5_1,transaction_date,shares,price")
      .in("ticker", heldTickers)
      .eq("transaction_code", "S")
      .gte("transaction_date", since)
      .order("transaction_date", { ascending: false });
    const sellerCik = new Map<string, string>(); // "name|ticker" -> reporter_cik (for size history)
    for (const r of isl ?? []) {
      sellerCik.set(`${r.reporter_name}|${r.ticker}`, String(r.reporter_cik));
      const shares = r.shares == null ? null : Number(r.shares);
      const price = r.price == null ? null : Number(r.price);
      sig(String(r.ticker)).insiderSells.push({
        name: String(r.reporter_name),
        role: roleOf({
          officer_title: r.officer_title,
          reporter_is_director: r.is_director,
          reporter_is_ten_pct: r.is_ten_pct,
          reporter_is_officer: r.is_officer,
        }),
        date: String(r.transaction_date),
        amount: shares != null && price != null ? shares * price : null,
        planned: r.is_10b5_1 == null ? null : Boolean(r.is_10b5_1),
        usualX: null,
        record: false,
      });
    }

    // One sale/buy is often filed as several same-day chunks — merge same person + same day.
    const merge = (list: InsiderTrade[]): InsiderTrade[] => {
      const m = new Map<string, InsiderTrade>();
      for (const t of list) {
        const k = `${t.name}|${t.date}`;
        const cur = m.get(k);
        if (!cur) m.set(k, { ...t });
        else {
          cur.amount = cur.amount == null || t.amount == null ? (cur.amount ?? t.amount) : cur.amount + t.amount;
          cur.role ??= t.role;
          // any unplanned chunk makes the day unplanned
          cur.planned = cur.planned === false || t.planned === false ? false : (cur.planned ?? t.planned);
        }
      }
      return [...m.values()].sort((a, b) => b.date.localeCompare(a.date) || (b.amount ?? 0) - (a.amount ?? 0));
    };
    for (const s of Object.values(signals)) {
      s.insiderBuys = merge(s.insiderBuys);
      s.insiderSells = merge(s.insiderSells);
    }

    // Size vs the seller's own history: each sale day's $ against the median and
    // max of that person's earlier sale days in the same stock (events_form4, 2023+).
    const ciks = [...new Set(sellerCik.values())];
    if (ciks.length) {
      const hist: { ticker: string; reporter_cik: string; transaction_date: string; shares: number | null; price: number | null }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await sb
          .from("events_form4")
          .select("ticker,reporter_cik,transaction_date,shares,price")
          .in("reporter_cik", ciks)
          .in("ticker", heldTickers)
          .eq("transaction_code", "S")
          .gte("transaction_date", "2023-01-01")
          .order("id")
          .range(from, from + 999);
        hist.push(...((data ?? []) as typeof hist));
        if (!data || data.length < 1000) break;
      }
      const days = new Map<string, Map<string, number>>(); // "cik|ticker" -> date -> $
      for (const h of hist) {
        if (h.shares == null || h.price == null) continue;
        const k = `${h.reporter_cik}|${h.ticker}`;
        if (!days.has(k)) days.set(k, new Map());
        const d = days.get(k)!;
        d.set(h.transaction_date, (d.get(h.transaction_date) ?? 0) + Number(h.shares) * Number(h.price));
      }
      for (const [ticker, s] of Object.entries(signals)) {
        for (const t of s.insiderSells) {
          const cik = sellerCik.get(`${t.name}|${ticker}`);
          const d = cik ? days.get(`${cik}|${ticker}`) : undefined;
          if (!d || t.amount == null) continue;
          const prior = [...d.entries()].filter(([dt]) => dt < t.date).map(([, v]) => v).sort((a, b) => a - b);
          if (prior.length < 3) continue; // too little history to call anything "usual"
          const median = prior[Math.floor(prior.length / 2)];
          t.usualX = median > 0 ? t.amount / median : null;
          t.record = t.amount > prior[prior.length - 1];
        }
      }
    }

    const { data: a13 } = await sb
      .from("events_13d")
      .select("ticker,cik,form_subtype,event_date")
      .in("ticker", heldTickers)
      .gte("event_date", since)
      .order("event_date", { ascending: false });
    for (const r of a13 ?? []) {
      const s = sig(String(r.ticker));
      if (!s.activist) {
        const info = filerInfo(String(r.cik));
        s.activist = {
          subtype: String(r.form_subtype),
          filer: info?.manager ?? info?.entity ?? String(r.cik),
          date: String(r.event_date),
        };
      }
    }

    // Latest-quarter 13F fund moves (vs the fund's previous filing = lag 1).
    const { data: fc } = await sb
      .from("fund_position_changes")
      .select("ticker,event,period,lag_quarters,filer_name,tier,shares_prev,shares_cur")
      .in("ticker", heldTickers)
      .eq("lag_quarters", 1);
    const priceOf = new Map<string, number>();
    for (const h of holdings) if (h.current_price != null) priceOf.set(h.ticker, h.current_price);
    let maxPeriod: string | null = null;
    for (const r of fc ?? []) if (!maxPeriod || String(r.period) > maxPeriod) maxPeriod = String(r.period);
    for (const r of fc ?? []) {
      if (String(r.period) !== maxPeriod) continue;
      const s = sig(String(r.ticker));
      s.fundPeriod = maxPeriod;
      const e = String(r.event);
      if (e === "opened" || e === "added") s.fundAdded++;
      else if (e === "trimmed" || e === "exited") s.fundTrimmed++;
      else continue;
      s.fundMoves.push({
        fund: String(r.filer_name),
        tier: r.tier == null ? null : String(r.tier),
        event: e,
        sharesPrev: r.shares_prev == null ? null : Number(r.shares_prev),
        sharesNow: r.shares_cur == null ? null : Number(r.shares_cur),
        // Size of the move at today's price — 13F value_usd is sometimes filed in $K
        // and is the remaining position, not the trade, so it isn't used here.
        // (exited rows have shares_cur null = 0 shares now)
        moveUsd:
          priceOf.get(String(r.ticker)) == null
            ? null
            : Math.abs(Number(r.shares_cur ?? 0) - Number(r.shares_prev ?? 0)) * priceOf.get(String(r.ticker))!,
      });
    }
  }

  return { holdings, sells, cash, usdInr, pricesAsOf, signals };
}

export default async function MyStocksPage() {
  const { holdings, sells, cash, usdInr, pricesAsOf, signals } = await loadData();
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="My Stocks"
        description="Personal portfolios with P&L — buy more, sell (full or partial), set targets, jot notes, and open a row for the scanner. Overall return is measured in ₹ against money actually put in from pocket."
      />
      <MyStocksTabs
        holdings={holdings}
        sells={sells}
        cash={cash}
        usdInr={usdInr}
        pricesAsOf={pricesAsOf}
        signals={signals}
      />
    </div>
  );
}
