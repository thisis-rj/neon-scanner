"""Compute today's BUY signals using the v6 confluence formula and write
to signals_latest table — read source for the /signals page.

Formula (same as backtest v6; implemented in ingest/scoring_rules.py):
  1. Insider cluster (Lakonishok-Lee)  0/1/2/3+ buyers in 30d → 0 / 1.5 / 3.5 / 7.0+
     counting only buyers who pass config/signal_weights.yml `insider_filters`
  2. 13F new (latest quarter)          Σ filer.multiplier × 2.0
  3. 13F add (latest quarter, ≥20%)    Σ filer.multiplier × 0.5
  4. Activist 13D (last 90d, initial)  Σ filer.multiplier × 5.0
  5. Raw share velocity (≥2x in Q)     Σ filer.multiplier × 2.0
  6. Cross-Q confluence (3+ filers)    Σ filer.multiplier × 1.5
  7. Multi-source pattern (≥3 types)   +5.0

Universe: market_cap ≥ $300M. No FOMO filter (per user direction).
Stores all signals with score ≥ 4 (~990 tickers); /signals page filters at read time.
"""
from __future__ import annotations

import os, sys, time, warnings
from datetime import date, datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore")

from supabase import Client, create_client
from dotenv import load_dotenv
import yaml

from ingest.scoring_rules import compute_signals, filer_weights

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def paginated(sb, table, sel, order=None, **filters):
    out, off = [], 0
    while True:
        q = sb.table(table).select(sel)
        for k, v in filters.items():
            q = q.eq(k, v)
        if order:  # offset paging over a view needs a stable order
            q = q.order(order)
        b = q.range(off, off + 999).execute()
        if not b.data:
            break
        out.extend(b.data)
        if len(b.data) < 1000:
            break
        off += 1000
    return out


def main() -> None:
    import yfinance as yf

    AS_OF = date.today()
    sb = _supabase()
    print(f"Computing BUY signals as of {AS_OF}", flush=True)

    # ─── Load inputs (all scoring math lives in ingest/scoring_rules.py) ──
    with (PROJECT_ROOT / "config" / "tracked_filers.yml").open() as f:
        filers_cfg = yaml.safe_load(f)["filers"]
    _, _, filer_tier, _ = filer_weights(filers_cfg)
    print(f"  tracked filers: {len(filer_tier)} "
          f"(S={sum(1 for t in filer_tier.values() if t=='S')}, "
          f"A={sum(1 for t in filer_tier.values() if t=='A')}, "
          f"B={sum(1 for t in filer_tier.values() if t=='B')}, "
          f"C={sum(1 for t in filer_tier.values() if t=='C')})", flush=True)

    universe_rows = paginated(sb, "tickers", "ticker,name,market_cap_usd")
    print(f"  universe: {len(universe_rows)} tickers", flush=True)
    filings = paginated(sb, "filings_raw", "id,cik,form_type,filed_at,period_of_report")
    # Effective long-equity rows only: amendments resolved, options and bond
    # principal (PRN) excluded — see schema/migrations/023_holdings_effective.sql.
    holding_rows = paginated(sb, "holdings_13f_effective", "filing_id,ticker,shares,issuer_name", order="id")
    insider_rows = paginated(sb, "insider_transactions",
                             "issuer_ticker,reporter_cik,transaction_date,filed_at,reporter_name,value_usd,"
                             "reporter_is_officer,reporter_is_director,is_10b5_1,shares,shares_owned_after,direct_indirect")
    e13d_rows = paginated(sb, "events_13d", "ticker,cik,form_subtype,filing_id,issuer_name")

    with (PROJECT_ROOT / "config" / "signal_weights.yml").open() as f:
        insider_filters = (yaml.safe_load(f) or {}).get("insider_filters") or {}
    print(f"  insider filters: {insider_filters}", flush=True)

    scored = compute_signals(AS_OF, filers_cfg, universe_rows, filings, holding_rows, insider_rows, e13d_rows,
                             insider_filters)
    print(f"  Scored picks (≥4): {len(scored)}", flush=True)

    # ─── Fetch returns for each (top 200 to keep runtime reasonable) ─────
    print("Fetching returns…", flush=True)
    Y_START_OF_YEAR = date(AS_OF.year, 1, 1)
    for i, s in enumerate(scored[:200], 1):
        try:
            t_obj = yf.Ticker(s["ticker"])
            hist = t_obj.history(period="1y", auto_adjust=True)
            if hist.empty or len(hist) < 2:
                continue
            idx = hist.index.tz_localize(None) if hist.index.tz else hist.index
            today_close = float(hist["Close"].iloc[-1])
            s["price"] = round(today_close, 2)
            def ret_at_days(n):
                if len(hist) < n + 1: return None
                p = float(hist["Close"].iloc[-(n + 1)])
                return round((today_close - p) / p * 100, 2) if p > 0 else None
            s["return_1m"] = ret_at_days(21)
            s["return_6m"] = ret_at_days(126)
            # YTD: find close at start of year
            ytd_match = idx[idx >= datetime.combine(Y_START_OF_YEAR, datetime.min.time())]
            if len(ytd_match) > 0:
                ytd_close = float(hist.loc[idx == ytd_match[0], "Close"].iloc[0])
                if ytd_close > 0:
                    s["return_ytd"] = round((today_close - ytd_close) / ytd_close * 100, 2)
        except Exception:
            pass
        time.sleep(0.3)
        if i % 25 == 0:
            print(f"    {i}/{min(200, len(scored))}", flush=True)

    # ─── Wipe + upsert ──────────────────────────────────────────────────
    print(f"\nUpserting {len(scored)} signals…", flush=True)
    # Clear stale rows first (tickers no longer signaling)
    current_tickers = {s["ticker"] for s in scored}
    existing = sb.table("signals_latest").select("ticker").execute()
    to_delete = [r["ticker"] for r in (existing.data or []) if r["ticker"] not in current_tickers]
    if to_delete:
        print(f"  Removing {len(to_delete)} stale tickers", flush=True)
        sb.table("signals_latest").delete().in_("ticker", to_delete).execute()
    # Upsert current. computed_at's column default (now()) only fires on
    # INSERT, so stamp it explicitly — otherwise a ticker that keeps
    # signaling shows the date it FIRST appeared as "last computed".
    run_at = datetime.now(timezone.utc).isoformat()
    for s in scored:
        s["computed_at"] = run_at
    for i in range(0, len(scored), 100):
        batch = scored[i:i + 100]
        sb.table("signals_latest").upsert(batch, on_conflict="ticker").execute()
    print("Done.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
