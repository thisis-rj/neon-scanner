"""Personal portfolio holdings for the /my-stocks tab.

Seeds Riya's and Vijay's positions (entered from their broker) and refreshes the
current price for each from Yahoo. Static fields (qty, avg_cost) live here;
target_price + comment are set in the UI and are NOT clobbered on re-run.

NOT part of the signal engine — a personal P&L view only.

Usage:
  python -m ingest.portfolio            # upsert holdings + refresh prices
  python -m ingest.portfolio --prices   # only refresh current_price for existing rows
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone
from pathlib import Path

import yfinance as yf
from dotenv import load_dotenv
from supabase import create_client

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")
sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])

# Real holdings live in ingest/portfolio_holdings.py, which is GITIGNORED and
# never committed (public repo). The daily price + FX refresh (`--prices`) is
# DB-driven and needs no holdings, so CI/other clones run fine without the file.
try:
    from ingest.portfolio_holdings import HOLDINGS  # type: ignore
except ImportError:
    HOLDINGS: list[tuple[str, str, str, float, float]] = []


def current_price(ticker: str) -> float | None:
    try:
        h = yf.Ticker(ticker).history(period="5d", auto_adjust=True)
        if h is not None and len(h) and "Close" in h:
            c = h["Close"].dropna()
            if len(c):
                return round(float(c.iloc[-1]), 2)
    except Exception:
        pass
    return None


def refresh_fx() -> None:
    """Refresh USD/INR in fx_rates (powers the /my-stocks pocket-return band)."""
    rate = current_price("INR=X")  # yfinance USD/INR
    if rate is not None:
        sb.table("fx_rates").upsert(
            {"pair": "USDINR", "rate": rate, "updated_at": datetime.now(timezone.utc).isoformat()},
            on_conflict="pair",
        ).execute()
        print(f"  fx USDINR -> {rate}", flush=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--prices", action="store_true", help="only refresh prices for existing rows")
    args = p.parse_args()
    now = datetime.now(timezone.utc).isoformat()

    if args.prices:
        rows = sb.table("portfolio_positions").select("person,ticker").execute().data or []
        for r in rows:
            px = current_price(r["ticker"])
            if px is not None:
                sb.table("portfolio_positions").update(
                    {"current_price": px, "updated_at": now}
                ).eq("person", r["person"]).eq("ticker", r["ticker"]).execute()
            print(f"  {r['person']:5} {r['ticker']:6} -> {px}", flush=True)
        refresh_fx()
        return

    for person, name, ticker, qty, avg in HOLDINGS:
        px = current_price(ticker)
        # Upsert holding. target_price/comment are intentionally omitted so an
        # existing row's notes survive a re-run (upsert only sets given columns).
        sb.table("portfolio_positions").upsert({
            "person": person, "ticker": ticker, "stock_name": name,
            "qty": qty, "avg_cost": avg, "current_price": px, "updated_at": now,
        }, on_conflict="person,ticker").execute()
        print(f"  {person:5} {ticker:6} qty={qty} avg={avg} px={px}", flush=True)
    refresh_fx()
    print(f"done. {len(HOLDINGS)} holdings.", flush=True)


if __name__ == "__main__":
    main()
