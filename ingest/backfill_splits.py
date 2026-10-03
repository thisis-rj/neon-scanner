"""One-time backfill: full split history for every stock a tracked fund holds.

The nightly prices job only sees splits from the last 13 months (the history it
downloads). /funds compares filings up to ~14 quarters apart (streak, 2-quarter
view), so older splits must be loaded once — otherwise a 2023 split reads as
every holder doubling their position.

Idempotent (upsert on ticker + split_date). Tickers whose lookup fails after
retries are listed at the end; re-run to retry them.

Usage:
  python -m ingest.backfill_splits            # ~2–3K tickers @ 0.3s ≈ 15 min
  python -m ingest.backfill_splits --limit 20
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from supabase import Client, create_client

from ingest.compute_buy_signals import paginated

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

PACE_S = 0.3
RETRIES = 3


def _supabase() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])


def fund_held_tickers(sb: Client) -> list[str]:
    """Every ticker a 13F row resolves to: CUSIP map first, then the stored ticker."""
    tickers = {r["ticker"] for r in paginated(sb, "cusip_ticker_map", "ticker", order="cusip") if r.get("ticker")}
    tickers |= {r["ticker"] for r in paginated(sb, "holdings_13f_effective", "ticker", order="id") if r.get("ticker")}
    return sorted(tickers)


def split_history(yf, ticker: str) -> list[tuple[str, float]]:
    """[(YYYY-MM-DD, ratio)], retrying transient Yahoo errors with backoff."""
    for attempt in range(RETRIES):
        try:
            s = yf.Ticker(ticker).splits
            return [(idx.strftime("%Y-%m-%d"), float(r)) for idx, r in s.items() if r and r > 0]
        except Exception:
            if attempt == RETRIES - 1:
                raise
            time.sleep(2 ** attempt * 2)
    return []


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    args = p.parse_args()

    import yfinance as yf

    sb = _supabase()
    tickers = fund_held_tickers(sb)
    if args.limit:
        tickers = tickers[: args.limit]
    print(f"Backfilling splits for {len(tickers):,} fund-held tickers", flush=True)

    found = written = 0
    failed: list[str] = []
    for i, t in enumerate(tickers, 1):
        if i > 1:
            time.sleep(PACE_S)
        try:
            splits = split_history(yf, t)
        except Exception as e:
            failed.append(t)
            print(f"  {t}: lookup failed ({e})", flush=True)
            continue
        if splits:
            found += 1
            sb.table("stock_splits").upsert(
                [{"ticker": t, "split_date": d, "ratio": r} for d, r in splits],
                on_conflict="ticker,split_date",
            ).execute()
            written += len(splits)
        if i % 200 == 0:
            print(f"  [{i}/{len(tickers)}] tickers with splits: {found}, records: {written}", flush=True)

    print(f"\nDone. {found} tickers had splits; {written} records upserted.", flush=True)
    if failed:
        print(f"Lookup failed for {len(failed)} tickers (re-run to retry): {', '.join(failed)}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
