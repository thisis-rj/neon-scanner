"""13F INFORMATION TABLE parser.

For each 13F-HR / 13F-HR/A filing in filings_raw, fetches the information
table XML from EDGAR and writes one row per position into holdings_13f.

Per CLAUDE.md §2.4 — we persist what EDGAR's XML reports, we don't
transform or invent. The <value> field is stored as reported. (SEC's
current instructions say value is in dollars; older filings used
thousands; some filers still report inconsistently. Downstream code
should compute its own checks against share count × price if precision
matters.)

Amendments (13F-HR/A): the cover page (primary_doc.xml) says whether the
amendment is a RESTATEMENT (replaces the original) or NEW HOLDINGS (adds
positions to it). We store that on filings_raw.amendment_type; the
holdings_13f_effective view uses it to decide replace vs union. If the
cover page can't be read the column stays NULL and the view treats the
filing as a restatement (the pre-2026-10 behavior).

Idempotent: re-running re-parses any filing by deleting the existing
holdings_13f rows for that filing_id before re-inserting. So resuming
after a crash is safe, and re-parsing after a parser bug-fix is too.

Usage:
  python -m ingest.parse_13f              # parse all unparsed
  python -m ingest.parse_13f --limit 10   # parse first 10 unparsed (smoke)
  python -m ingest.parse_13f --reparse    # ignore parsed status; do everything
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

EDGAR_USER_AGENT = os.environ["EDGAR_USER_AGENT"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

HEADERS_JSON = {"User-Agent": EDGAR_USER_AGENT, "Accept": "application/json"}
HEADERS_XML = {"User-Agent": EDGAR_USER_AGENT, "Accept": "application/xml,text/xml,*/*"}

MIN_INTERVAL_S = 1.0 / 8
_last_request_at = 0.0


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def _polite_get(url: str, headers: dict[str, str]) -> requests.Response:
    """GET with EDGAR rate limit + 5xx retry."""
    global _last_request_at
    last_exc: Exception | None = None
    for attempt in range(3):
        delta = time.monotonic() - _last_request_at
        if delta < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - delta)
        try:
            r = requests.get(url, headers=headers, timeout=30)
            _last_request_at = time.monotonic()
            if 500 <= r.status_code < 600:
                raise requests.HTTPError(f"{r.status_code} server error", response=r)
            return r  # caller checks status — 404s are legitimate "no info table"
        except (requests.HTTPError, requests.ConnectionError, requests.Timeout) as e:
            last_exc = e
            time.sleep(1.5 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def _localname(tag: str) -> str:
    """Strip XML namespace prefix from a tag."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _filing_base_url(cik: str, accession: str) -> str:
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}"


def list_filing_xmls(cik: str, accession: str) -> list[str] | None:
    """XML file names in the filing, from its index.json (None if the index is unavailable).

    13F filings have several files: a primary doc cover page (XML), an
    information table (XML, contains positions), and sometimes index files.
    """
    r = _polite_get(f"{_filing_base_url(cik, accession)}/index.json", HEADERS_JSON)
    if r.status_code != 200:
        return None
    files = r.json().get("directory", {}).get("item", [])
    return [f["name"] for f in files if f["name"].endswith(".xml")]


def pick_info_table(xmls: list[str]) -> str | None:
    """Heuristic: the XML that isn't the cover page/header, preferring 'info'/'tab' names."""
    if not xmls:
        return None
    candidates = [n for n in xmls if "primary" not in n.lower() and "header" not in n.lower()]
    if not candidates:
        candidates = xmls
    preferred = [n for n in candidates if "info" in n.lower() or "tab" in n.lower()]
    return preferred[0] if preferred else candidates[0]


def pick_primary_doc(xmls: list[str]) -> str | None:
    """The cover page XML (SEC names it primary_doc.xml)."""
    return next((n for n in xmls if "primary" in n.lower()), None)


AMENDMENT_TYPES = {"RESTATEMENT", "NEW HOLDINGS"}


def parse_amendment_type(xml_bytes: bytes) -> str | None:
    """Read coverPage/amendmentInfo/amendmentType: 'RESTATEMENT', 'NEW HOLDINGS' or None."""
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None
    for el in root.iter():
        if _localname(el.tag) == "amendmentType":
            v = " ".join((el.text or "").split()).upper()
            return v if v in AMENDMENT_TYPES else None
    return None


def parse_info_table(xml_bytes: bytes) -> list[dict[str, Any]]:
    """Parse a 13F information table XML into a list of row dicts.

    Skips entries missing critical fields rather than crashing — some
    filers include malformed rows that EDGAR accepts.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return []

    rows: list[dict[str, Any]] = []
    for it in root.iter():
        if _localname(it.tag) != "infoTable":
            continue
        name = cusip = value = shares = put_call = None
        sh_type = None
        for child in it:
            t = _localname(child.tag)
            if t == "nameOfIssuer":
                name = (child.text or "").strip() or None
            elif t == "cusip":
                cusip = (child.text or "").strip() or None
            elif t == "value":
                value = (child.text or "").strip() or None
            elif t == "shrsOrPrnAmt":
                for gc in child:
                    gct = _localname(gc.tag)
                    if gct == "sshPrnamt":
                        shares = (gc.text or "").strip() or None
                    elif gct == "sshPrnamtType":
                        sh_type = (gc.text or "").strip() or None
            elif t == "putCall":
                put_call = (child.text or "").strip() or None

        if not (name and cusip):
            continue  # malformed row

        # value is sometimes int, sometimes decimal. Store as numeric.
        try:
            value_num = float(value) if value else None
        except ValueError:
            value_num = None
        try:
            shares_int = int(shares) if shares else None
        except ValueError:
            shares_int = None

        rows.append({
            "cusip": cusip,
            "issuer_name": name,
            "value_usd": value_num,
            "shares": shares_int,
            "put_call": put_call,
            # 'SH' = shares, 'PRN' = principal amount of debt (dollars, not shares).
            # Readers must exclude PRN rows; holdings_13f_effective does.
            "sh_type": sh_type.upper() if sh_type else None,
        })
    return rows


def parse_one_filing(filing: dict[str, Any]) -> tuple[int, str | None]:
    """Parse one 13F filing into holdings_13f rows. Returns (n_rows, error)."""
    xmls = list_filing_xmls(filing["cik"], filing["accession_number"])
    info_name = pick_info_table(xmls or [])
    if not info_name:
        return 0, "no info table file found"
    base = _filing_base_url(filing["cik"], filing["accession_number"])
    r = _polite_get(f"{base}/{info_name}", HEADERS_XML)
    if r.status_code != 200:
        return 0, f"info table HTTP {r.status_code}"
    parsed = parse_info_table(r.content)
    if not parsed:
        return 0, "info table empty or unparseable"

    sb = _supabase()
    if filing.get("form_type") == "13F-HR/A":
        record_amendment_type(sb, filing, base, xmls or [])

    # Idempotent: delete existing rows for this filing, then insert fresh.
    sb.table("holdings_13f").delete().eq("filing_id", filing["id"]).execute()

    rows_to_insert = []
    for p in parsed:
        rows_to_insert.append({
            "filing_id": filing["id"],
            "cik": filing["cik"],
            "period_of_report": filing["period_of_report"],
            "cusip": p["cusip"],
            "ticker": None,  # ticker resolution is a separate step (CUSIP→ticker mapping)
            "issuer_name": p["issuer_name"],
            "shares": p["shares"],
            "value_usd": p["value_usd"],
            "put_call": p["put_call"],
            "sh_type": p["sh_type"],
        })

    # Batch insert. Supabase accepts large batches but ~500/request is safer.
    for i in range(0, len(rows_to_insert), 500):
        sb.table("holdings_13f").insert(rows_to_insert[i:i + 500]).execute()

    return len(rows_to_insert), None


def record_amendment_type(sb: Client, filing: dict[str, Any], base: str, xmls: list[str]) -> None:
    """Store RESTATEMENT / NEW HOLDINGS on filings_raw. Failures only warn: holdings still parse."""
    primary = pick_primary_doc(xmls)
    amendment_type = None
    if primary:
        try:
            r = _polite_get(f"{base}/{primary}", HEADERS_XML)
            if r.status_code == 200:
                amendment_type = parse_amendment_type(r.content)
        except requests.RequestException as e:
            print(f"  WARN {filing['accession_number']}: cover page fetch failed ({e})", file=sys.stderr)
    if amendment_type is None:
        print(f"  WARN {filing['accession_number']}: amendment type unknown; treated as RESTATEMENT",
              file=sys.stderr)
        return
    sb.table("filings_raw").update({"amendment_type": amendment_type}).eq("id", filing["id"]).execute()


def get_unparsed_filings(sb: Client, reparse: bool = False) -> list[dict[str, Any]]:
    """Return 13F filings that have no holdings_13f rows yet (or all if reparse)."""
    # Pull all 13F-HR filings, oldest first (so a partial run leaves the recent
    # ones for the next pass — but newest unparsed are most likely interesting).
    all_filings: list[dict[str, Any]] = []
    offset = 0
    while True:
        b = (
            sb.table("filings_raw")
            .select("id,accession_number,cik,filer_name,period_of_report,form_type")
            .in_("form_type", ["13F-HR", "13F-HR/A"])
            .order("period_of_report", desc=True)
            .range(offset, offset + 999)
            .execute()
        )
        if not b.data:
            break
        all_filings.extend(b.data)
        if len(b.data) < 1000:
            break
        offset += 1000

    if reparse:
        return all_filings

    # Find filing_ids that already have holdings rows.
    parsed_ids: set[str] = set()
    offset = 0
    while True:
        b = sb.table("holdings_13f").select("filing_id").range(offset, offset + 999).execute()
        if not b.data:
            break
        parsed_ids.update(r["filing_id"] for r in b.data)
        if len(b.data) < 1000:
            break
        offset += 1000

    return [f for f in all_filings if f["id"] not in parsed_ids]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="parse first N filings only")
    parser.add_argument("--reparse", action="store_true", help="re-parse everything, not just unparsed")
    args = parser.parse_args()

    sb = _supabase()
    pending = get_unparsed_filings(sb, reparse=args.reparse)
    if args.limit:
        pending = pending[: args.limit]

    print(f"To parse: {len(pending)} 13F filings.\n")

    total_rows = 0
    errors: list[tuple[str, str]] = []
    t0 = time.monotonic()

    for i, f in enumerate(pending, 1):
        try:
            n, err = parse_one_filing(f)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            n = 0
        if err:
            errors.append((f["accession_number"], err))
            tag = f"  ERROR: {err}"
        else:
            total_rows += n
            tag = f"  +{n} rows"
        if i <= 10 or i % 50 == 0 or i == len(pending):
            elapsed = time.monotonic() - t0
            print(f"[{i}/{len(pending)}] {f['filer_name'] or f['cik']}  {f['period_of_report']}{tag}  ({elapsed:.0f}s)")

    print(f"\n=== Summary ===")
    print(f"Filings parsed : {len(pending) - len(errors)}/{len(pending)}")
    print(f"Holdings rows  : {total_rows:,}")
    print(f"Errors         : {len(errors)}")
    if errors:
        print(f"\nFirst few errors:")
        for acc, err in errors[:10]:
            print(f"  {acc}: {err}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted. Partial progress is committed to DB; rerun to resume.", file=sys.stderr)
        sys.exit(130)
