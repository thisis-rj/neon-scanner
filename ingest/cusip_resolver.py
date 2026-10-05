"""Resolve every distinct CUSIP in holdings_13f → ticker via OpenFIGI.

WHY (caught May 22): name-based resolution can't disambiguate ETFs (many
iShares funds share the same "ISHARES TR" prefix) or SEC-truncated names
("ACACIA RESH" instead of "ACACIA RESEARCH"). CUSIP is globally unique per
security and OpenFIGI maps CUSIPs → tickers for free at 25 req/min.

Idempotent — resolves CUSIPs we haven't seen yet, re-asks up to --retry-limit
no-match CUSIPs last tried --retry-days ago or more, and refreshes
last_seen_in_holdings for any that appeared in today's ingest. Letter-first
CUSIPs (non-US issuers) are sent as CINS (figi_id_type).

Usage:
  python -m ingest.cusip_resolver              # resolve all unmapped
  python -m ingest.cusip_resolver --limit 200  # cap (smoke test)
  python -m ingest.cusip_resolver --refresh CUSIP1,CUSIP2  # force re-resolve specific
"""
from __future__ import annotations

import argparse
import os
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

OPENFIGI_URL = "https://api.openfigi.com/v3/mapping"
# OpenFIGI anonymous: 25 req/min, MAX 10 jobs per request (not 100 — 413
# caught in smoke test). With a free API key the limits go up to 250 req/min
# and 100 jobs per request — worth wiring later if we hit volume.
RATE_LIMIT_S = 60.0 / 25  # 2.4s between batches anonymous
BATCH_SIZE = 10


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


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


def figi_id_type(cusip: str) -> str:
    """OpenFIGI identifier type for a 13F CUSIP column value.

    Issuers outside the US get a CINS: same 9-character shape, but the first
    character is a letter (Chubb H1467J104, Accenture G1151C101, ASML
    N07059210). OpenFIGI answers "No identifier found" when a CINS is sent as
    ID_CUSIP, which left all 806 letter-first CUSIPs unmapped until 2026-10-05.
    """
    return "ID_CINS" if cusip[:1].isalpha() else "ID_CUSIP"


def openfigi_lookup(cusips: list[str], max_retries: int = 4) -> dict[str, dict[str, str] | None]:
    """POST a batch of CUSIPs to OpenFIGI; return {cusip → {ticker, name, ...} or None}.

    Retries with exponential backoff on transient network errors (the May 22
    backfill died at 580/8097 due to a server-disconnect mid-request)."""
    if not cusips:
        return {}
    body = [{"idType": figi_id_type(c), "idValue": c} for c in cusips]
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            r = requests.post(OPENFIGI_URL, json=body, headers={"Content-Type": "application/json"}, timeout=30)
            if r.status_code == 429:
                time.sleep(60)
                continue
            r.raise_for_status()
            rows = r.json()
            break
        except (requests.exceptions.RequestException, ConnectionError) as e:
            last_exc = e
            wait = 2 ** attempt  # 1s, 2s, 4s, 8s
            time.sleep(wait)
    else:
        # all retries exhausted
        raise RuntimeError(f"OpenFIGI failed after {max_retries} retries: {last_exc}") from last_exc
    out: dict[str, dict[str, str] | None] = {}
    for cusip, row in zip(cusips, rows, strict=False):
        # row format: {"data": [{"ticker":"...","name":"...","exchCode":"...","securityType2":"..."}]} OR {"warning":"..."}
        data = row.get("data") if isinstance(row, dict) else None
        if not data:
            out[cusip] = None
            continue
        # Prefer US-exchange common-stock / ADR / ETP matches; OpenFIGI returns
        # cross-listed copies (e.g. London, Frankfurt). Pick the first US one.
        us = [d for d in data if d.get("exchCode") == "US"]
        chosen = (us or data)[0]
        out[cusip] = {
            "ticker": chosen.get("ticker"),
            "name": chosen.get("name"),
            "exchange": chosen.get("exchCode"),
            "security_type": chosen.get("securityType2") or chosen.get("securityType"),
        }
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--limit", type=int, default=None, help="max unmapped CUSIPs to resolve this run")
    p.add_argument("--refresh", type=str, default=None, help="comma-sep CUSIPs to force re-resolve")
    p.add_argument("--retry-days", type=int, default=30,
                   help="re-ask OpenFIGI about no-match CUSIPs last tried this many days ago or more")
    p.add_argument("--retry-limit", type=int, default=300,
                   help="max no-match CUSIPs to re-ask per run, oldest attempt first (300 ≈ 75 s)")
    args = p.parse_args()

    sb = _supabase()

    # 1. Unique CUSIPs in holdings_13f, with latest period each appeared in
    print("Loading distinct CUSIPs from holdings_13f…", flush=True)
    holdings = paginated(sb, "holdings_13f", "cusip,period_of_report")
    last_seen: dict[str, str] = {}
    for h in holdings:
        # Upper-case: some 13Fs write 48251w104; OpenFIGI only matches 48251W104.
        c, p_ = (h["cusip"] or "").strip().upper(), h["period_of_report"]
        if c and (c not in last_seen or p_ > last_seen[c]):
            last_seen[c] = p_
    print(f"  {len(last_seen):,} distinct CUSIPs", flush=True)

    # 2. Already-resolved CUSIPs
    print("Loading already-resolved CUSIPs from cusip_ticker_map…", flush=True)
    existing = {row["cusip"]: row for row in paginated(sb, "cusip_ticker_map",
                                                         "cusip,ticker,resolved_via,resolved_at,last_seen_in_holdings")}
    print(f"  {len(existing):,} already mapped", flush=True)

    refresh_set = set((args.refresh or "").split(",")) if args.refresh else set()
    refresh_set.discard("")

    todo = [c for c in last_seen if c not in existing or c in refresh_set]
    # A no-match used to be final, so a wrong one (all CINS, see figi_id_type)
    # never got a second look. Re-ask the stalest ones a few hundred per run.
    cutoff = (datetime.now(timezone.utc) - timedelta(days=args.retry_days)).isoformat()
    retry = sorted(
        (row["resolved_at"], c) for c, row in existing.items()
        if c in last_seen and c not in refresh_set and not row.get("ticker")
        and (row.get("resolved_at") or "") <= cutoff
    )
    todo += [c for _, c in retry[: args.retry_limit]]
    if args.limit:
        todo = todo[: args.limit]
    print(f"  {len(todo):,} to resolve via OpenFIGI ({min(len(retry), args.retry_limit):,} no-match retries)",
          flush=True)

    # 3. Batch through OpenFIGI
    resolved = 0
    nomatch = 0
    for i in range(0, len(todo), BATCH_SIZE):
        batch = todo[i : i + BATCH_SIZE]
        try:
            results = openfigi_lookup(batch)
        except Exception as e:
            print(f"  batch {i // BATCH_SIZE} FAILED: {e}", flush=True)
            time.sleep(RATE_LIMIT_S * 2)
            continue
        rows = []
        now = datetime.now(timezone.utc).isoformat()
        for cusip in batch:
            r = results.get(cusip)
            rows.append({
                "cusip": cusip,
                "ticker": r["ticker"] if r else None,
                "name": r["name"] if r else None,
                "exchange": r["exchange"] if r else None,
                "security_type": r["security_type"] if r else None,
                "resolved_via": "openfigi" if r else "openfigi_nomatch",
                "resolved_at": now,  # the retry clock above reads this
                "last_seen_in_holdings": last_seen[cusip],
            })
            if r and r["ticker"]:
                resolved += 1
            else:
                nomatch += 1
        sb.table("cusip_ticker_map").upsert(rows, on_conflict="cusip").execute()
        if (i // BATCH_SIZE) % 5 == 0:
            print(f"  [{i + len(batch):>5}/{len(todo):>5}]  resolved={resolved} nomatch={nomatch}", flush=True)
        time.sleep(RATE_LIMIT_S)

    # 4. Update last_seen for already-resolved CUSIPs that appeared this run.
    # The upsert carries resolved_via: Postgres checks NOT NULL on the proposed
    # insert row before it sees the conflict, so {cusip, last_seen} alone failed
    # every run (last_seen froze at 2026-03-31). Rows step 3 just wrote are
    # skipped: their last_seen is current and `existing` has their old label.
    if existing:
        written = set(todo)
        bulk = [
            {"cusip": c, "resolved_via": row["resolved_via"], "last_seen_in_holdings": last_seen[c]}
            for c, row in existing.items()
            if c in last_seen and c not in written and row.get("last_seen_in_holdings") != last_seen[c]
        ]
        print(f"  updating last_seen on {len(bulk):,} rows", flush=True)
        for chunk in (bulk[i : i + 500] for i in range(0, len(bulk), 500)):
            sb.table("cusip_ticker_map").upsert(chunk, on_conflict="cusip").execute()

    print(f"\nDone. Newly resolved: {resolved}.  No match: {nomatch}.  Total mapped: {len(existing) + resolved}.", flush=True)


if __name__ == "__main__":
    main()
