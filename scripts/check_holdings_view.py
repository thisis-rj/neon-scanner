"""Check holdings_13f_effective against an independent re-implementation of its rule.

Read-only. Run after `python -m ingest.migrate` (019) and
`python -m ingest.parse_13f --reparse`, before deploying:

  python scripts/check_holdings_view.py                      # against Supabase
  python scripts/check_holdings_view.py --snapshot s.json.gz # against a diff_signals snapshot
  python scripts/check_holdings_view.py --timing             # time holdings_recent(2) only

Rule (schema/migrations/019_holdings_effective.sql), per (cik, period):
  base  = latest-filed 13F-HR or 13F-HR/A RESTATEMENT (NULL type counts as
          RESTATEMENT) that has at least one holdings row
  extra = 13F-HR/A NEW HOLDINGS filed after the base, or with no base
  rows  = base ∪ extra, minus put/call rows and PRN rows

Exit 1 on any mismatch. Also reports amendments still missing a type and
spot-checks quarters named in the eng review (Berkshire Q1-2025, Oaktree Q1-2026).
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BERKSHIRE, OAKTREE = "0001067983", "0000949509"


def _supabase():
    from dotenv import load_dotenv
    from supabase import create_client

    load_dotenv(REPO / ".env")
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])


def _fetch_all(sb, table, cols, **eq):
    out, off = [], 0
    while True:
        q = sb.table(table).select(cols)
        for k, v in eq.items():
            q = q.eq(k, v)
        b = q.order("id").range(off, off + 999).execute()
        out.extend(b.data or [])
        if not b.data or len(b.data) < 1000:
            return out
        off += 1000


def load(args):
    if args.snapshot:
        with gzip.open(args.snapshot, "rt") as f:
            t = json.load(f)["tables"]
        filings = [f for f in t["filings_raw"] if f["form_type"] in ("13F-HR", "13F-HR/A")]
        return filings, t["holdings_13f"], t["holdings_13f_effective"]
    sb = _supabase()
    filings = [f for ft in ("13F-HR", "13F-HR/A")
               for f in _fetch_all(sb, "filings_raw", "id,cik,form_type,filed_at,period_of_report,amendment_type", form_type=ft)]
    raw = _fetch_all(sb, "holdings_13f", "id,filing_id,put_call,sh_type")
    eff = _fetch_all(sb, "holdings_13f_effective", "id,filing_id,put_call,sh_type")
    return filings, raw, eff


def expected_filings(filings, raw_rows):
    """(cik, period) → set of filing ids the view should draw rows from."""
    has_rows = {r["filing_id"] for r in raw_rows}
    by_q = defaultdict(list)
    for f in filings:
        if f["id"] in has_rows:
            by_q[(f["cik"], f["period_of_report"])].append(f)
    out = {}
    for q, fs in by_q.items():
        def kind(f):
            if f["form_type"] == "13F-HR":
                return "ORIGINAL"
            return "NEW HOLDINGS" if f.get("amendment_type") == "NEW HOLDINGS" else "RESTATEMENT"
        bases = sorted((f for f in fs if kind(f) != "NEW HOLDINGS"), key=lambda f: (f["filed_at"], f["id"]))
        base = bases[-1] if bases else None
        ids = {base["id"]} if base else set()
        ids |= {f["id"] for f in fs if kind(f) == "NEW HOLDINGS" and (base is None or f["filed_at"] > base["filed_at"])}
        out[q] = ids
    return out


def check(filings, raw, eff) -> int:
    problems = 0
    by_id = {f["id"]: f for f in filings}
    expect = expected_filings(filings, raw)

    # Expected row count per filing = its long-equity rows.
    long_rows = Counter(r["filing_id"] for r in raw
                        if not r.get("put_call") and (r.get("sh_type") or "SH") != "PRN")
    got_rows = Counter(r["filing_id"] for r in eff)

    bad_rows = [r for r in eff if r.get("put_call") or r.get("sh_type") == "PRN"]
    if bad_rows:
        problems += 1
        print(f"FAIL view contains {len(bad_rows)} option/PRN rows")

    for (cik, period), ids in sorted(expect.items()):
        want = sum(long_rows[i] for i in ids)
        have = sum(got_rows[i] for i in ids)
        stray = {i for i in got_rows if by_id.get(i, {}).get("cik") == cik
                 and by_id.get(i, {}).get("period_of_report") == period} - ids
        if want != have or stray:
            problems += 1
            print(f"FAIL {cik} {period}: expected {want} rows from {sorted(ids)}, view has {have}"
                  + (f", plus rows from superseded filings {sorted(stray)}" if stray else ""))

    untyped = [f for f in filings if f["form_type"] == "13F-HR/A" and not f.get("amendment_type")]
    amend = [f for f in filings if f["form_type"] == "13F-HR/A"]
    print(f"13F-HR/A filings: {len(amend)} ({Counter(f.get('amendment_type') for f in amend)})")
    if untyped:
        print(f"WARN {len(untyped)} amendments have no amendment_type (treated as RESTATEMENT) — rerun parse_13f --reparse")

    raw_total = sum(1 for _ in raw)
    print(f"rows: raw={raw_total:,} effective={len(eff):,} "
          f"options={sum(1 for r in raw if r.get('put_call')):,} "
          f"prn={sum(1 for r in raw if r.get('sh_type') == 'PRN'):,} "
          f"sh_type_null={sum(1 for r in raw if not r.get('sh_type')):,}")

    for label, cik, period in (("Berkshire", BERKSHIRE, "2025-03-31"), ("Oaktree", OAKTREE, "2026-03-31")):
        ids = expect.get((cik, period), set())
        kinds = sorted(f"{by_id[i]['form_type']}:{by_id[i].get('amendment_type') or '-'}" for i in ids)
        print(f"{label} {period}: {sum(got_rows[i] for i in ids)} effective rows from {kinds}")

    print("OK" if problems == 0 else f"{problems} problem(s)")
    return 1 if problems else 0


def timing() -> int:
    sb = _supabase()
    t0 = time.monotonic()
    n = len(sb.rpc("holdings_recent", {"max_periods": 2}).execute().data or [])
    print(f"holdings_recent(2): {n:,} rows in {time.monotonic() - t0:.2f}s (wall clock, includes network)")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--snapshot")
    p.add_argument("--timing", action="store_true")
    args = p.parse_args()
    if args.timing:
        return timing()
    return check(*load(args))


if __name__ == "__main__":
    sys.exit(main())
