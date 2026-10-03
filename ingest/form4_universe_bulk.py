"""Bulk-download universe-wide Form 4 data from SEC's structured insider
transactions dataset. ~10 min for 5 quarters of history vs ~4 hours for the
daily-index per-filing scrape.

Source: https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets
Each quarterly zip contains 4 relevant TSVs:
  SUBMISSION.tsv      → filing-level metadata (accession, issuer, filing date)
  REPORTINGOWNER.tsv  → who filed (CIK, name, officer/director flags)
  NONDERIV_TRANS.tsv  → the actual transactions including code P open-market buys
  DERIV_TRANS.tsv     → options/derivatives — we ignore these for cluster signal

Output: same schema as insider_transactions table — drop-in replacement for
the slower form4_universe.py (which is kept around for incremental daily runs).

Usage:
  python -m ingest.form4_universe_bulk                       # last 2 quarters
  python -m ingest.form4_universe_bulk --quarters 2025q4 2026q1
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
import zipfile
from datetime import date, datetime, timedelta
from io import TextIOWrapper
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from ingest.form4_fields import direct_indirect, parse_bool_flag, parse_number, relationship_flags

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]
EDGAR_USER_AGENT = os.environ["EDGAR_USER_AGENT"]

CACHE_DIR = Path("/tmp/form4_bulk")
CACHE_DIR.mkdir(exist_ok=True)

URL_TMPL = "https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{q}_form345.zip"


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def quarters_back(years: float) -> list[str]:
    today = date.today()
    cutoff = today - timedelta(days=int(years * 365))
    out: list[str] = []
    y, q = cutoff.year, (cutoff.month - 1) // 3 + 1
    cur_y, cur_q = today.year, (today.month - 1) // 3 + 1
    prev_q, prev_y = cur_q - 1, cur_y
    if prev_q == 0:
        prev_q, prev_y = 4, cur_y - 1
    while (y, q) <= (prev_y, prev_q):
        out.append(f"{y}q{q}")
        q += 1
        if q > 4:
            q, y = 1, y + 1
    return out


def download(q: str) -> Path | None:
    out = CACHE_DIR / f"{q}_form345.zip"
    if out.exists() and out.stat().st_size > 1_000_000:
        return out
    url = URL_TMPL.format(q=q)
    print(f"  fetching {url}", flush=True)
    with requests.get(url, headers={"User-Agent": EDGAR_USER_AGENT}, stream=True, timeout=120) as r:
        if not r.ok:
            print(f"  HTTP {r.status_code}", flush=True)
            return None
        with out.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
    return out


def parse_quarter(zip_path: Path) -> list[dict[str, Any]]:
    """Return rows ready for insider_transactions upsert (only code P purchases)."""
    with zipfile.ZipFile(zip_path) as z:
        # 1) SUBMISSION — keep only DOCUMENT_TYPE='4' filings
        sub_by_acc: dict[str, dict[str, Any]] = {}
        with z.open("SUBMISSION.tsv") as raw:
            reader = csv.DictReader(TextIOWrapper(raw, "utf-8"), delimiter="\t")
            for row in reader:
                if row.get("DOCUMENT_TYPE") != "4":
                    continue
                sub_by_acc[row["ACCESSION_NUMBER"]] = {
                    "issuer_cik": row.get("ISSUERCIK"),
                    "issuer_name": row.get("ISSUERNAME"),
                    "issuer_ticker": (row.get("ISSUERTRADINGSYMBOL") or "").strip().upper() or None,
                    "filing_date": row.get("FILING_DATE"),
                    # Rule 10b5-1 checkbox (required since 2023-04-01): "1"/"true"/"0"/"false"/blank.
                    "is_10b5_1": parse_bool_flag(row.get("AFF10B5ONE")),
                }

        # 2) REPORTINGOWNER — could be multiple per accession; keep first
        owner_by_acc: dict[str, dict[str, Any]] = {}
        with z.open("REPORTINGOWNER.tsv") as raw:
            reader = csv.DictReader(TextIOWrapper(raw, "utf-8"), delimiter="\t")
            for row in reader:
                acc = row["ACCESSION_NUMBER"]
                if acc in owner_by_acc:
                    continue
                owner_by_acc[acc] = {
                    "reporter_cik": row.get("RPTOWNERCIK"),
                    "reporter_name": row.get("RPTOWNERNAME"),
                    **relationship_flags(row.get("RPTOWNER_RELATIONSHIP")),
                    "officer_title": row.get("RPTOWNER_TITLE"),
                }

        # 3) NONDERIV_TRANS — filter to code P (open-market purchase)
        rows: list[dict[str, Any]] = []
        with z.open("NONDERIV_TRANS.tsv") as raw:
            reader = csv.DictReader(TextIOWrapper(raw, "utf-8"), delimiter="\t")
            for row in reader:
                if row.get("TRANS_CODE") != "P":
                    continue
                acc = row["ACCESSION_NUMBER"]
                sub = sub_by_acc.get(acc)
                owner = owner_by_acc.get(acc)
                if not sub or not owner:
                    continue
                try:
                    shares = float(row.get("TRANS_SHARES") or 0)
                    price = float(row.get("TRANS_PRICEPERSHARE") or 0)
                    td = datetime.strptime(row["TRANS_DATE"], "%d-%b-%Y").date()
                    filed_at = datetime.strptime(sub["filing_date"], "%d-%b-%Y").date()
                except (ValueError, KeyError, TypeError):
                    continue
                if shares <= 0 or price <= 0:
                    continue
                value_usd = shares * price
                cik_int = int(sub["issuer_cik"]) if sub["issuer_cik"] else None
                rows.append({
                    "accession_number": acc,
                    "issuer_cik": str(cik_int).zfill(10) if cik_int else None,
                    "issuer_name": sub["issuer_name"],
                    "issuer_ticker": sub["issuer_ticker"],
                    "reporter_cik": str(int(owner["reporter_cik"])).zfill(10) if owner["reporter_cik"] else None,
                    "reporter_name": owner["reporter_name"],
                    "reporter_is_officer": owner["reporter_is_officer"],
                    "reporter_is_director": owner["reporter_is_director"],
                    "reporter_is_ten_pct": owner["reporter_is_ten_pct"],
                    "officer_title": owner["officer_title"],
                    "transaction_date": td.isoformat(),
                    "transaction_code": "P",
                    "shares": shares,
                    "price": price,
                    "value_usd": value_usd,
                    "filed_at": filed_at.isoformat(),
                    "is_10b5_1": sub["is_10b5_1"],
                    "shares_owned_after": parse_number(row.get("SHRS_OWND_FOLWNG_TRANS")),
                    "direct_indirect": direct_indirect(row.get("DIRECT_INDIRECT_OWNERSHIP")),
                    "primary_doc_url": f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc.replace('-', '')}/{acc}-index.htm" if cik_int else None,
                })
        return rows


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--years", type=float, default=1.0, help="Years back to backfill")
    p.add_argument("--quarters", nargs="+", help="Specific quarters override")
    args = p.parse_args()

    qs = args.quarters or quarters_back(args.years)
    print(f"Quarters: {qs}", flush=True)

    sb = _supabase()
    t0 = time.monotonic()
    all_rows: list[dict[str, Any]] = []
    for q in qs:
        path = download(q)
        if not path:
            print(f"  skip {q}", flush=True)
            continue
        print(f"  parsing {q}…", flush=True)
        rows = parse_quarter(path)
        print(f"  {q}: {len(rows)} P-transactions extracted ({time.monotonic()-t0:.0f}s)", flush=True)
        all_rows.extend(rows)

    if not all_rows:
        print("Nothing to upsert.", flush=True)
        return

    # Dedup by primary key BEFORE upsert (Postgres rejects same-key twice in one stmt)
    by_key: dict[tuple, dict[str, Any]] = {}
    for r in all_rows:
        k = (r["accession_number"], r["reporter_cik"], r["transaction_date"], r["transaction_code"], r["shares"])
        by_key[k] = r
    deduped = list(by_key.values())
    print(f"\nUpserting {len(deduped)} unique rows ({len(all_rows) - len(deduped)} intra-batch duplicates dropped)…", flush=True)
    for i in range(0, len(deduped), 500):
        batch = deduped[i:i+500]
        sb.table("insider_transactions").upsert(batch, on_conflict="accession_number,reporter_cik,transaction_date,transaction_code,shares").execute()
    print(f"Done in {time.monotonic()-t0:.0f}s.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)
