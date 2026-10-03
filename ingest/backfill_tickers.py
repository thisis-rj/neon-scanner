"""One-shot backfill: resolve holdings_13f.ticker via normalized-name match
against the tickers universe. Same logic cost_basis.py uses internally.

After this runs once, holdings_13f.ticker is populated for historical data.
The proper fix is to update parse_13f to ALSO resolve at parse time — see
the patch in that module.

Idempotent: re-running only updates rows where ticker is still NULL.

Usage:
  python -m ingest.backfill_tickers
  python -m ingest.backfill_tickers --dry-run
"""
from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


SUFFIX_RE = re.compile(
    r"\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HLDGS|GROUP|GRP|LLC|LP|TRUST|N V|NV|SA|AG|TR|CL A|CL B|CLASS A|CLASS B|COM|ORD|ORDINARY|SHARES)\b\.?",
    re.I,
)
PUNCT_RE = re.compile(r"[.,&/\-\(\)\']")


def normalize_name(s: str | None) -> str:
    if not s:
        return ""
    s = s.upper()
    s = PUNCT_RE.sub(" ", s)
    s = SUFFIX_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def paginated(sb: Client, table: str, sel: str, **filters: Any) -> list[dict[str, Any]]:
    out, off = [], 0
    while True:
        q = sb.table(table).select(sel)
        for k, v in filters.items():
            q = q.eq(k, v)
        b = q.range(off, off + 999).execute()
        if not b.data:
            break
        out.extend(b.data)
        if len(b.data) < 1000:
            break
        off += 1000
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    sb = _supabase()

    print("Loading tickers universe…", flush=True)
    universe = paginated(sb, "tickers", "ticker,name")
    name_to_ticker: dict[str, str] = {}
    for r in universe:
        norm = normalize_name(r.get("name"))
        if norm and norm not in name_to_ticker:
            name_to_ticker[norm] = r["ticker"]
    print(f"  {len(name_to_ticker):,} unique normalized names", flush=True)

    print("\nFetching holdings_13f rows where ticker is NULL…", flush=True)
    # Pull rows by paging through the table; supabase-py can't filter for NULL nicely
    # via the chain, so use the raw `is_("ticker", "null")` filter.
    rows: list[dict[str, Any]] = []
    off = 0
    while True:
        b = sb.table("holdings_13f").select("id,issuer_name,ticker").is_("ticker", "null").range(off, off + 999).execute()
        if not b.data:
            break
        rows.extend(b.data)
        if len(b.data) < 1000:
            break
        off += 1000
    print(f"  {len(rows):,} rows with null ticker", flush=True)

    # Resolve
    matched: dict[str, str] = {}  # row_id → ticker
    unresolved = 0
    for r in rows:
        t = name_to_ticker.get(normalize_name(r.get("issuer_name")))
        if t:
            matched[r["id"]] = t
        else:
            unresolved += 1
    print(f"\n  resolved: {len(matched):,}", flush=True)
    print(f"  unresolved: {unresolved:,}  ({100*unresolved/len(rows):.1f}%)", flush=True)

    if args.dry_run:
        # Sample some unresolved
        unresolved_sample = [r for r in rows if r["id"] not in matched][:10]
        if unresolved_sample:
            print(f"\nSample unresolved issuer_names:")
            for r in unresolved_sample:
                print(f"  '{r.get('issuer_name')}'")
        print("\n(dry-run) not updating.")
        return

    if not matched:
        print("\nNothing to update.")
        return

    print(f"\nUpdating {len(matched):,} rows in batches of 500…", flush=True)
    # Group by ticker to use IN(ids) updates
    by_ticker: dict[str, list[str]] = {}
    for rid, t in matched.items():
        by_ticker.setdefault(t, []).append(rid)

    updated = 0
    for ticker, ids in by_ticker.items():
        # Update in batches of 500 ids
        for i in range(0, len(ids), 500):
            chunk = ids[i:i + 500]
            sb.table("holdings_13f").update({"ticker": ticker}).in_("id", chunk).execute()
            updated += len(chunk)
        if updated % 5000 < 500:
            print(f"  {updated:,} / {len(matched):,}", flush=True)

    print(f"\nDone. Updated {updated:,} rows.", flush=True)
    # Readers use the stored copy (migration 025); carry the new tickers into it.
    sb.rpc("refresh_holdings_effective").execute()
    print("Refreshed holdings_13f_effective.", flush=True)


if __name__ == "__main__":
    main()
