"""Universe-wide Form 4 ingester for insider-cluster detection.

Different from ingest/parse_form4.py (which only covers Form 4s filed by our
38 tracked-filer CIKs). This module pulls Form 4s from ANY US public company's
insiders, filters to open-market purchases (code 'P'), and stores them in
insider_transactions for cluster detection.

Strategy:
  - Enumerate Form 4s via EDGAR daily index (one HTTP per day, ~5K filings each)
  - For each filing, fetch the ownership.xml, parse for non-derivative txns
  - Keep only transaction_code = 'P' (open-market purchases)
  - Idempotent: unique constraint on (accession, reporter, date, code, shares)

Usage:
  python -m ingest.form4_universe              # default: last 60 days
  python -m ingest.form4_universe --days 30    # last 30 days only
  python -m ingest.form4_universe --date 2026-05-12  # one specific day

Cost: at 8 req/s rate limit, full 60-day backfill takes ~3-4 hours.
Subsequent daily runs take ~5-10 minutes.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

from ingest.form4_fields import direct_indirect, parse_bool_flag, parse_number

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

EDGAR_USER_AGENT = os.environ["EDGAR_USER_AGENT"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

HEADERS_TEXT = {"User-Agent": EDGAR_USER_AGENT, "Accept": "text/plain,*/*"}
HEADERS_XML = {"User-Agent": EDGAR_USER_AGENT, "Accept": "application/xml,text/xml,*/*"}

MIN_INTERVAL_S = 1.0 / 8
_last_request_at = 0.0


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def _polite_get(url: str, headers: dict[str, str] = HEADERS_TEXT) -> requests.Response | None:
    global _last_request_at
    for attempt in range(3):
        delta = time.monotonic() - _last_request_at
        if delta < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - delta)
        try:
            r = requests.get(url, headers=headers, timeout=30)
            _last_request_at = time.monotonic()
            if 500 <= r.status_code < 600:
                time.sleep(1.5 * (attempt + 1))
                continue
            return r
        except (requests.ConnectionError, requests.Timeout):
            time.sleep(1.5 * (attempt + 1))
    return None


def daily_index_url(d: date) -> str:
    """EDGAR daily-index URL for a given date."""
    qtr = (d.month - 1) // 3 + 1
    return f"https://www.sec.gov/Archives/edgar/daily-index/{d.year}/QTR{qtr}/form.{d:%Y%m%d}.idx"


def parse_daily_index_for_form4(text: str) -> list[dict[str, str]]:
    """Parse the pipe/fixed-width daily index file for Form 4 entries.

    Format (after the header):
        Form Type   Company Name   CIK   Date Filed   File Name
    Fixed-width-ish; we split by 2+ whitespace.
    Note: this CIK is the *reporter* (insider), not the issuer.
    """
    out: list[dict[str, str]] = []
    in_data = False
    for line in text.split("\n"):
        if line.startswith("-----"):
            in_data = True
            continue
        if not in_data:
            continue
        if not line.strip():
            continue
        # Form 4 / 4/A entries — split by multiple-space and take fields
        if line.startswith("4 ") or line.startswith("4/A "):
            parts = re.split(r"\s{2,}", line.strip(), maxsplit=4)
            if len(parts) < 5:
                continue
            form, company, cik, filed_date, file_name = parts
            out.append({
                "form": form,
                "reporter_name": company.strip(),
                "reporter_cik": cik.strip().zfill(10),
                "filed_date": filed_date.strip(),
                "file_name": file_name.strip(),
            })
    return out


def _localname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _text_of(elem: ET.Element | None, *path: str) -> str | None:
    cur = elem
    for name in path:
        if cur is None:
            return None
        nxt = None
        for c in cur:
            if _localname(c.tag) == name:
                nxt = c
                break
        cur = nxt
    if cur is None:
        return None
    return (cur.text or "").strip() or None


def fetch_form4_xml(file_name: str) -> tuple[bytes | None, str]:
    """Given the daily-index file_name (e.g. 'edgar/data/1659494/0001104659-26-057920.txt'),
    derive the filing directory and fetch the ownership.xml.

    The daily-index file_name points to the submission TEXT file, not the
    filing directory. The filing dir is at /edgar/data/<cik>/<accession_no_dashes>/.
    """
    # Extract accession (with dashes) and CIK from the filename
    acc_match = re.search(r"(\d{10}-\d{2}-\d{6})", file_name)
    if not acc_match:
        return None, ""
    acc_with_dashes = acc_match.group(1)
    acc_no_dashes = acc_with_dashes.replace("-", "")

    cik_match = re.search(r"data/(\d+)/", file_name)
    if not cik_match:
        return None, ""
    cik = cik_match.group(1)

    base_dir = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_no_dashes}"

    # Try the well-known filenames first
    for candidate in ("ownership.xml", "primary_doc.xml"):
        url = f"{base_dir}/{candidate}"
        r = _polite_get(url, HEADERS_XML)
        if r and r.status_code == 200 and b"<ownershipDocument" in r.content[:500]:
            return r.content, url

    # Fallback: hit index.json to discover the right XML filename
    # Form 4 XML filenames vary widely (some filers use custom names like
    # 'tm2614064-1_4seq1.xml'). Try each .xml file in order until one looks
    # like an ownership document.
    idx_url = f"{base_dir}/index.json"
    r = _polite_get(idx_url, HEADERS_XML)
    if r and r.status_code == 200:
        try:
            files = r.json().get("directory", {}).get("item", [])
            xmls = [f["name"] for f in files if f["name"].endswith(".xml") and "/" not in f["name"]]
            # Heuristic ordering: anything mentioning ownership/form4 first
            xmls.sort(key=lambda n: 0 if ("ownership" in n.lower() or "form4" in n.lower() or "_4" in n.lower()) else 1)
            for fn in xmls:
                url = f"{base_dir}/{fn}"
                r2 = _polite_get(url, HEADERS_XML)
                if r2 and r2.status_code == 200 and b"<ownershipDocument" in r2.content[:1500]:
                    return r2.content, url
        except Exception:
            pass
    return None, ""


def parse_form4(xml_bytes: bytes) -> list[dict[str, Any]] | None:
    """Parse Form 4 XML → list of non-derivative purchase ('P') transactions only.
    Returns None on parse failure, [] on no P transactions found."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None

    issuer_elem = next((c for c in root if _localname(c.tag) == "issuer"), None)
    issuer_cik = _text_of(issuer_elem, "issuerCik")
    issuer_name = _text_of(issuer_elem, "issuerName")
    ticker = _text_of(issuer_elem, "issuerTradingSymbol")

    # Reporting owners (usually one)
    owner = next((c for c in root if _localname(c.tag) == "reportingOwner"), None)
    reporter_cik = _text_of(owner, "reportingOwnerId", "rptOwnerCik")
    reporter_name = _text_of(owner, "reportingOwnerId", "rptOwnerName")
    # SEC writes these as "1"/"0" or "true"/"false"; unknown counts as False here.
    is_officer = parse_bool_flag(_text_of(owner, "reportingOwnerRelationship", "isOfficer")) is True
    is_director = parse_bool_flag(_text_of(owner, "reportingOwnerRelationship", "isDirector")) is True
    is_ten_pct = parse_bool_flag(_text_of(owner, "reportingOwnerRelationship", "isTenPercentOwner")) is True
    is_10b5_1 = parse_bool_flag(_text_of(root, "aff10b5One"))  # None on pre-2023 filings
    officer_title = _text_of(owner, "reportingOwnerRelationship", "officerTitle")

    if not issuer_cik:
        return []

    rows: list[dict[str, Any]] = []
    for table in root:
        if _localname(table.tag) != "nonDerivativeTable":
            continue
        for tx in table:
            if _localname(tx.tag) != "nonDerivativeTransaction":
                continue
            code = _text_of(tx, "transactionCoding", "transactionCode")
            if code != "P":
                continue
            tx_date = _text_of(tx, "transactionDate", "value")
            shares = _text_of(tx, "transactionAmounts", "transactionShares", "value")
            price = _text_of(tx, "transactionAmounts", "transactionPricePerShare", "value")
            if not tx_date:
                continue
            try:
                shares_num = float(shares) if shares else None
            except ValueError:
                shares_num = None
            try:
                price_num = float(price) if price else None
            except ValueError:
                price_num = None
            value_usd = (shares_num or 0) * (price_num or 0) if shares_num and price_num else None
            rows.append({
                "issuer_cik": issuer_cik.zfill(10),
                "issuer_name": issuer_name,
                "issuer_ticker": ticker,
                "reporter_cik": (reporter_cik or "").zfill(10) if reporter_cik else None,
                "reporter_name": reporter_name,
                "reporter_is_officer": is_officer,
                "reporter_is_director": is_director,
                "reporter_is_ten_pct": is_ten_pct,
                "officer_title": officer_title,
                "transaction_date": tx_date,
                "transaction_code": code,
                "shares": shares_num,
                "price": price_num,
                "value_usd": value_usd,
                "is_10b5_1": is_10b5_1,
                "shares_owned_after": parse_number(
                    _text_of(tx, "postTransactionAmounts", "sharesOwnedFollowingTransaction", "value")),
                "direct_indirect": direct_indirect(
                    _text_of(tx, "ownershipNature", "directOrIndirectOwnership", "value")),
            })
    return rows


def insert_transactions(sb: Client, rows: list[dict[str, Any]]) -> int:
    """Upsert rows, returning newly-inserted count (existing rows skipped)."""
    if not rows:
        return 0
    try:
        result = sb.table("insider_transactions").upsert(
            rows,
            on_conflict="accession_number,reporter_cik,transaction_date,transaction_code,shares",
            ignore_duplicates=True,
        ).execute()
        return len(result.data) if result.data else 0
    except Exception as e:
        print(f"  upsert error: {e}", file=sys.stderr)
        return 0


def process_day(sb: Client, d: date) -> tuple[int, int]:
    """Fetch + parse + insert all Form 4 purchases for one day.

    Returns (purchases_found, filings_processed)."""
    r = _polite_get(daily_index_url(d), HEADERS_TEXT)
    if not r or r.status_code != 200:
        return 0, 0
    entries = parse_daily_index_for_form4(r.text)
    purchases = 0
    filings = 0
    batch: list[dict[str, Any]] = []

    for e in entries:
        xml, doc_url = fetch_form4_xml(e["file_name"])
        filings += 1
        if not xml:
            continue
        parsed = parse_form4(xml)
        if not parsed:
            continue
        # Compose accession from filename
        # filename pattern: .../<acc-with-or-without-dashes>/...
        acc_match = re.search(r"(\d{10}-\d{2}-\d{6})", e["file_name"])
        accession = acc_match.group(1) if acc_match else e["file_name"].split("/")[-1].replace(".txt", "")
        for p in parsed:
            p.update({
                "accession_number": accession,
                "primary_doc_url": doc_url,
                "filed_at": e["filed_date"] + "T00:00:00Z",
            })
            batch.append(p)
            purchases += 1
        if len(batch) >= 100:
            insert_transactions(sb, batch)
            batch = []
    if batch:
        insert_transactions(sb, batch)
    return purchases, filings


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=60, help="Backfill last N days (default 60)")
    p.add_argument("--date", type=str, help="Specific YYYY-MM-DD (overrides --days)")
    args = p.parse_args()

    sb = _supabase()
    today = date.today()
    if args.date:
        dates = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        dates = [today - timedelta(days=i) for i in range(args.days)]
        dates = [d for d in dates if d.weekday() < 5]  # skip weekends — no filings

    print(f"Processing {len(dates)} days from {dates[-1]} to {dates[0]}\n", flush=True)
    total_purchases = 0
    total_filings = 0
    t0 = time.monotonic()
    for i, d in enumerate(dates, 1):
        p, f = process_day(sb, d)
        total_purchases += p
        total_filings += f
        elapsed = time.monotonic() - t0
        print(f"[{i}/{len(dates)}] {d}: {p} P-transactions from {f} Form 4s  ({elapsed:.0f}s)", flush=True)

    print(f"\n=== Summary ===", flush=True)
    print(f"Days processed       : {len(dates)}", flush=True)
    print(f"Form 4 filings scanned: {total_filings}", flush=True)
    print(f"P-transactions stored : {total_purchases}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted; partial progress committed.", file=sys.stderr)
        sys.exit(130)
