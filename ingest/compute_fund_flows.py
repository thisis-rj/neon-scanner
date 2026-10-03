"""Compute fund_position_changes + stock_signal_extras — the data behind /funds.

What each tracked fund did to each stock between its own consecutive 13F
filings (opened / added / trimmed / exited, ≥10% split-adjusted), plus the
insider-cluster and activist-13D columns. All the rules live in
ingest/scoring_rules.py (fund_position_changes, stock_signal_extras); all the
counting lives in the fund_flows() SQL function (migration 027).

Writes are safe to repeat: every row is upserted with this run's run_id, then
rows from older runs are deleted. A crash mid-run leaves older, still-valid rows.

Usage:
  python -m ingest.compute_fund_flows
  python -m ingest.compute_fund_flows --dry-run --out /tmp/flows.json   # read-only
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import yaml
from dotenv import load_dotenv
from supabase import Client, create_client

from ingest.compute_buy_signals import paginated
from ingest.scoring_rules import fund_position_changes, reporting_quarter, stock_signal_extras

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

BATCH = 500


def _supabase() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])


def load_inputs(sb: Client):
    with (PROJECT_ROOT / "config" / "tracked_filers.yml").open() as f:
        filers_cfg = yaml.safe_load(f)["filers"]
    with (PROJECT_ROOT / "config" / "signal_weights.yml").open() as f:
        insider_filters = (yaml.safe_load(f) or {}).get("insider_filters") or {}
    universe_rows = paginated(sb, "tickers", "ticker,name", order="ticker")
    filings = paginated(sb, "filings_raw", "id,cik,form_type,filed_at,period_of_report", order="id")
    # Effective long-equity rows only (migration 023): amendments resolved,
    # options and bond principal excluded.
    holding_rows = paginated(sb, "holdings_13f_effective",
                             "cik,period_of_report,cusip,ticker,issuer_name,shares,value_usd", order="id")
    cusip_map = {r["cusip"]: r["ticker"]
                 for r in paginated(sb, "cusip_ticker_map", "cusip,ticker", order="cusip") if r.get("ticker")}
    splits = defaultdict(list)
    try:
        split_rows = paginated(sb, "stock_splits", "ticker,split_date,ratio", order="ticker,split_date")
    except Exception as e:  # migration 027 not applied yet (only reachable with --dry-run)
        print(f"  stock_splits unreadable ({e}); continuing without splits", flush=True)
        split_rows = []
    for r in split_rows:
        splits[r["ticker"]].append((r["split_date"], float(r["ratio"])))
    insider_rows = paginated(sb, "insider_transactions",
                             "issuer_ticker,reporter_cik,transaction_date,filed_at,reporter_name,value_usd,"
                             "reporter_is_officer,reporter_is_director,is_10b5_1,shares,shares_owned_after,direct_indirect",
                             order="id")
    e13d_rows = paginated(sb, "events_13d", "ticker,cik,form_subtype,filing_id,issuer_name", order="id")
    return dict(filers_cfg=filers_cfg, insider_filters=insider_filters, universe_rows=universe_rows,
                filings=filings, holding_rows=holding_rows, cusip_map=cusip_map, splits=splits,
                insider_rows=insider_rows, e13d_rows=e13d_rows)


def compute(as_of: date, inp: dict):
    rows, stats = fund_position_changes(as_of, inp["filers_cfg"], inp["holding_rows"], inp["cusip_map"],
                                        inp["universe_rows"], inp["splits"])
    extras = stock_signal_extras(as_of, inp["filers_cfg"], inp["filings"], inp["insider_rows"],
                                 inp["e13d_rows"], inp["universe_rows"], inp["insider_filters"])
    return rows, stats, extras


def report(as_of: date, inp: dict, rows, stats, extras) -> None:
    print(f"  reporting quarter: {reporting_quarter(as_of)}", flush=True)
    print(f"  holdings rows: {len(inp['holding_rows']):,} · CUSIP map: {len(inp['cusip_map']):,} · "
          f"split records: {sum(len(v) for v in inp['splits'].values()):,}", flush=True)
    if not inp["splits"]:
        print("  WARNING: stock_splits is empty — run `python -m ingest.backfill_splits` once, "
              "or splits will read as adds/trims", flush=True)
    newest = Counter(p for _, p in stats["counted"])
    print(f"  funds counted: {len(stats['counted'])} (newest filing: {dict(sorted(newest.items()))})", flush=True)
    for label in ("stopped_filing", "no_baseline"):
        if stats[label]:
            print(f"  left out ({label}): " + ", ".join(f"{n} [{p}]" for n, p in stats[label]), flush=True)
    latest = [r for r in rows if r["lag_quarters"] == 1 and r["pair_rank"] == 0]
    print(f"  rows: {len(rows):,} total · latest pairs: {len(latest):,} "
          f"{dict(Counter(r['event'] for r in latest))} · stocks: {len({r['ticker'] for r in latest}):,}", flush=True)
    print(f"  stocks with insider/activist columns: {len(extras):,}", flush=True)


def write(sb: Client, table: str, rows: list[dict], run_id: str, run_at: str, on_conflict: str) -> None:
    for r in rows:
        r["run_id"], r["computed_at"] = run_id, run_at
    for i in range(0, len(rows), BATCH):
        sb.table(table).upsert(rows[i:i + BATCH], on_conflict=on_conflict).execute()
    sb.table(table).delete().neq("run_id", run_id).execute()
    print(f"  {table}: {len(rows):,} rows written, older runs removed", flush=True)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true", help="compute and report; write nothing to Supabase")
    p.add_argument("--out", help="with --dry-run: save rows + extras as JSON here")
    args = p.parse_args(argv)

    as_of = date.today()
    sb = _supabase()
    print(f"Computing fund flows as of {as_of}", flush=True)
    inp = load_inputs(sb)
    rows, stats, extras = compute(as_of, inp)
    report(as_of, inp, rows, stats, extras)

    if args.dry_run:
        if args.out:
            Path(args.out).write_text(json.dumps({"rows": rows, "extras": extras, "stats": stats}, default=str))
            print(f"  dry run: wrote {args.out}", flush=True)
        return
    if not rows:
        # Never replace the table with nothing: an empty result means an input
        # failed to load, not that every fund stopped trading.
        sys.exit("No fund_position_changes computed — leaving the existing rows in place.")

    run_at = datetime.now(timezone.utc).isoformat()
    run_id = run_at
    write(sb, "fund_position_changes", rows, run_id, run_at, "cik,ticker,lag_quarters,pair_rank")
    write(sb, "stock_signal_extras", extras, run_id, run_at, "ticker")
    print("Done.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
