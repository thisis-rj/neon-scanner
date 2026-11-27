"""Daily closes for the /sectors overlay chart.

  python -m ingest.sector_prices            # backfill 5y for new symbols, else last 15 days
  python -m ingest.sector_prices --full     # re-pull 5y for every symbol

The symbol list lives in web/lib/sectors.ts (labels, colors, order) — keep the
SYMBOLS here in sync with it.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SYMBOLS = ["BTC-USD", "GC=F", "SI=F", "SMH", "ITA", "XLU", "URA", "XLE", "XLF", "XLV", "IGV", "WGMI"]


def main() -> None:
    import yfinance as yf

    p = argparse.ArgumentParser()
    p.add_argument("--full", action="store_true")
    a = p.parse_args()
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    have = {r["symbol"] for r in sb.table("sector_prices").select("symbol").limit(5000).execute().data or []}
    for sym in SYMBOLS:
        period = "5y" if (a.full or sym not in have) else "1mo"
        df = yf.download(sym, period=period, progress=False, auto_adjust=True)
        if df is None or df.empty:
            print(f"  {sym}: no data", flush=True)
            continue
        close = df["Close"]
        if isinstance(close, pd.DataFrame):
            close = close.iloc[:, 0]
        rows = [dict(symbol=sym, date=str(d.date()), close=round(float(v), 6)) for d, v in close.dropna().items()]
        for i in range(0, len(rows), 1000):
            sb.table("sector_prices").upsert(rows[i:i + 1000], on_conflict="symbol,date").execute()
        print(f"  {sym}: {len(rows)} rows ({period})", flush=True)


if __name__ == "__main__":
    main()
