"""One-time backfill: full split history for every stock a tracked fund holds.

The nightly prices job only sees splits from the last 13 months (the history it
downloads). /funds compares filings up to ~14 quarters apart (streak, 2-quarter
view), so older splits must be loaded once — otherwise a 2023 split reads as
every holder doubling their position.

Idempotent (upsert on ticker + split_date). Two passes: every ticker is tried
once, then only the failures are retried with backoff (most failures are codes
Yahoo has never heard of, so retrying all of them up front wastes ~7 s each).
Tickers skipped or still failing are written, with the reason, to
logs/backfill_splits_excluded_<date>.log so they can be re-run with --only.

Usage:
  python -m ingest.backfill_splits                      # ~5K tickers, ~1.5 h
  python -m ingest.backfill_splits --limit 20
  python -m ingest.backfill_splits --skip-file F        # tickers known missing on Yahoo
  python -m ingest.backfill_splits --start-after AAPL   # resume a cut-off run
  python -m ingest.backfill_splits --only F             # just these tickers
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
from ingest.scoring_rules import market_symbol

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
    return sorted({market_symbol(t) for t in tickers})


def split_history(yf, ticker: str, retries: int = RETRIES) -> list[tuple[str, float]]:
    """[(YYYY-MM-DD, ratio)], retrying transient Yahoo errors with backoff."""
    for attempt in range(retries):
        try:
            s = yf.Ticker(ticker).splits
            return [(idx.strftime("%Y-%m-%d"), float(r)) for idx, r in s.items() if r and r > 0]
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt * 2)
    return []


def read_list(path: str) -> list[str]:
    return [ln.strip() for ln in Path(path).read_text().splitlines() if ln.strip()]


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--skip-file", help="tickers to skip, one per line (known missing on Yahoo)")
    p.add_argument("--start-after", help="resume: skip tickers up to and including this one")
    p.add_argument("--only", help="look up only the tickers in this file")
    args = p.parse_args()

    import yfinance as yf

    sb = _supabase()
    tickers = read_list(args.only) if args.only else fund_held_tickers(sb)
    excluded: list[tuple[str, str]] = []
    # Bond / note descriptions ("JOYY 1.375 06/15/26") aren't symbols Yahoo knows.
    excluded += [(t, "not a stock symbol (contains a space)") for t in tickers if " " in t]
    tickers = [t for t in tickers if " " not in t]
    if args.skip_file:
        skip = set(read_list(args.skip_file))
        excluded += [(t, f"in --skip-file {args.skip_file}") for t in tickers if t in skip]
        tickers = [t for t in tickers if t not in skip]
    if args.start_after:
        tickers = [t for t in tickers if t > args.start_after]
    if args.limit:
        tickers = tickers[: args.limit]
    print(f"Backfilling splits for {len(tickers):,} fund-held tickers ({len(excluded)} excluded)", flush=True)

    found = written = 0

    def run(batch: list[str], retries: int, label: str) -> list[str]:
        nonlocal found, written
        failed: list[str] = []
        for i, t in enumerate(batch, 1):
            if i > 1:
                time.sleep(PACE_S)
            try:
                splits = split_history(yf, t, retries)
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
                print(f"  {label} [{i}/{len(batch)}] tickers with splits: {found}, records: {written}", flush=True)
        return failed

    failed = run(tickers, 1, "pass 1")
    if failed:
        print(f"\nPass 2: retrying {len(failed)} failed lookups with backoff", flush=True)
        failed = run(failed, RETRIES, "pass 2")
    excluded += [(t, "Yahoo lookup failed in both passes") for t in failed]

    print(f"\nDone. {found} tickers had splits; {written} records upserted.", flush=True)
    if excluded:
        log = PROJECT_ROOT / "logs" / f"backfill_splits_excluded_{time.strftime('%Y%m%d-%H%M')}.log"
        log.parent.mkdir(exist_ok=True)
        log.write_text("".join(f"{t}\t{why}\n" for t, why in excluded))
        print(f"Excluded {len(excluded)} tickers (no split data loaded), listed in {log}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
