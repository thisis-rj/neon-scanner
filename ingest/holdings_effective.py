"""Refresh the stored copy of holdings_13f_effective (migration 025).

Readers use the stored copy, so anything that writes holdings_13f must call
refresh() afterwards (parse_13f and backfill_tickers do).

Runs through the Supabase Management API (SUPABASE_PAT, like ingest.migrate),
not PostgREST: the REST path cancels statements after a few seconds, and a
concurrent refresh of ~150k rows takes longer (it failed that way on
2026-10-03). CONCURRENTLY keeps the old copy readable while the new one is
built.

Usage:
  python -m ingest.holdings_effective
"""
from __future__ import annotations

import time

import requests

REFRESH_SQL = "refresh materialized view concurrently holdings_13f_effective;"


def refresh() -> float:
    """Refresh the stored copy; returns seconds taken. Raises on failure."""
    # Imported here: ingest.migrate exits at import when SUPABASE_PAT is missing.
    from ingest.migrate import HEADERS, QUERY_URL

    t0 = time.monotonic()
    r = requests.post(QUERY_URL, headers=HEADERS, json={"query": REFRESH_SQL}, timeout=600)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"refresh of holdings_13f_effective failed ({r.status_code}): {r.text[:500]}")
    return time.monotonic() - t0


def main() -> None:
    print(f"Refreshed holdings_13f_effective in {refresh():.1f}s.", flush=True)


if __name__ == "__main__":
    main()
