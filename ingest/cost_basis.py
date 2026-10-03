"""Estimate per-(filer, ticker) cost basis using per-quarter VWAP proxy.

13Fs report quarter-end FAIR VALUE only — not entry price (SEC design,
not a data gap). To approximate cost basis we walk each filer's
quarter-by-quarter share trajectory, identify quarters where shares
INCREASED (accumulation events), and multiply Δshares × that quarter's
VWAP. Σ / total_shares_bought = weighted-average cost per share.

Accuracy: typically ±15-25% off true cost. Useful for orientation only
(is the filer up or down on this name?), NOT for precise P&L.

Caching: per-(ticker, quarter) VWAPs are cached permanently in
ticker_quarter_vwap. Past quarters never change → safe forever.

Usage:
  python -m ingest.cost_basis                 # all tracked filers
  python -m ingest.cost_basis --cik 0001536411 # one filer only
  python -m ingest.cost_basis --refresh-vwap   # ignore cache, re-fetch

Cadence: daily, after parse_13f. Idempotent.
"""
from __future__ import annotations

import argparse
import os
import re
import time
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from supabase import Client, create_client

# Issuer-name normalization (same pattern as compute_buy_signals.py).
# parse_13f leaves holdings_13f.ticker NULL — it only stores CUSIP + issuer_name.
# We resolve to ticker by normalized-name match against the tickers table.
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


def resolve_ticker(issuer: str | None, name_to_ticker: dict[str, str]) -> str | None:
    """Resolve issuer_name → ticker with SEC-truncation fallback.

    SEC 13F XML truncates issuer names at fixed widths, leaving partial
    trailing tokens like 'PRAXIS PRECISION MEDICINES I' (rather than
    '...INC'). Try exact normalized match first, then strip trailing 1-2
    letter tokens and retry. Caught May 22 when Perceptive's biotech
    positions all failed to resolve."""
    n = normalize_name(issuer)
    if not n:
        return None
    if n in name_to_ticker:
        return name_to_ticker[n]
    trimmed = re.sub(r"\s[A-Z]{1,2}$", "", n).strip()
    if trimmed and trimmed != n and trimmed in name_to_ticker:
        return name_to_ticker[trimmed]
    return None

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]


def _supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def paginated(sb, table, sel, **filters):
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


def quarter_bounds(period_iso: str) -> tuple[date, date] | None:
    """Given YYYY-MM-DD quarter-end, return (start, end) date pair.
    Returns None for non-standard period dates."""
    p = date.fromisoformat(period_iso)
    if p.month == 3 and p.day == 31:
        return date(p.year, 1, 1), p
    if p.month == 6 and p.day == 30:
        return date(p.year, 4, 1), p
    if p.month == 9 and p.day == 30:
        return date(p.year, 7, 1), p
    if p.month == 12 and p.day == 31:
        return date(p.year, 10, 1), p
    return None


def compute_quarter_vwap(yf_mod, ticker: str, period_iso: str) -> tuple[float, int] | None:
    """Returns (vwap, bars_used) or None on failure."""
    bounds = quarter_bounds(period_iso)
    if not bounds:
        return None
    p_start, p_end = bounds
    try:
        t = yf_mod.Ticker(ticker)
        # auto_adjust=False so we get unadjusted prices (closer to what was paid)
        hist = t.history(
            start=p_start.isoformat(),
            end=(p_end + timedelta(days=2)).isoformat(),
            auto_adjust=False,
        )
        if hist.empty:
            return None
        # Filter strictly to within quarter
        in_q = hist[(hist.index.date >= p_start) & (hist.index.date <= p_end)]
        if in_q.empty:
            return None
        tp = (in_q["High"] + in_q["Low"] + in_q["Close"]) / 3.0
        vol = in_q["Volume"]
        total_v = float(vol.sum())
        if total_v <= 0:
            return None
        vwap = float((tp * vol).sum() / total_v)
        return vwap, len(in_q)
    except Exception:
        return None


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--cik", type=str, default=None, help="Single CIK to process")
    p.add_argument("--refresh-vwap", action="store_true", help="Re-fetch cached VWAPs")
    args = p.parse_args()

    import yfinance as yf

    sb = _supabase()

    # ─── Load tracked filers ───────────────────────────────────────────
    with (PROJECT_ROOT / "config" / "tracked_filers.yml").open() as f:
        cfg = yaml.safe_load(f)
    filer_ciks: set[str] = set()
    for fl in cfg["filers"]:
        if fl.get("cik"):
            filer_ciks.add(str(int(fl["cik"])).zfill(10))
    if args.cik:
        filer_ciks = {args.cik.zfill(10)}
    print(f"Computing cost basis for {len(filer_ciks)} filers", flush=True)

    # ─── Build issuer-name → ticker map from the tickers universe table ─
    # parse_13f leaves holdings_13f.ticker NULL — we resolve via name match.
    print("Loading tickers universe for name resolution…", flush=True)
    universe = paginated(sb, "tickers", "ticker,name")
    name_to_ticker: dict[str, str] = {}
    for r in universe:
        norm = normalize_name(r.get("name"))
        if norm and norm not in name_to_ticker:
            name_to_ticker[norm] = r["ticker"]
    print(f"  {len(name_to_ticker):,} unique normalized names mapped", flush=True)

    # ─── Pull holdings ─────────────────────────────────────────────────
    # Effective long-equity rows (migration 023): restated quarters count once,
    # options and bond principal excluded.
    print("Loading holdings_13f_effective…", flush=True)
    all_h: list[dict[str, Any]] = []
    for c in filer_ciks:
        all_h.extend(paginated(
            sb, "holdings_13f_effective",
            "cik,ticker,issuer_name,period_of_report,shares,value_usd",
            cik=c,
        ))
    print(f"  {len(all_h):,} rows across {len(filer_ciks)} filers", flush=True)

    # ─── Build (cik, ticker) trajectories ──────────────────────────────
    traj: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    unresolved = 0
    for h in all_h:
        if h.get("shares") is None:
            continue
        ticker = h.get("ticker") or resolve_ticker(h.get("issuer_name"), name_to_ticker)
        if not ticker:
            unresolved += 1
            continue
        traj[(h["cik"], ticker)].append({
            "period": h["period_of_report"],
            "shares": h["shares"],
            "value_usd": h.get("value_usd"),
        })
    for k in traj:
        traj[k].sort(key=lambda x: x["period"])
    print(f"  {len(traj):,} (filer, ticker) trajectories  (unresolved issuer names: {unresolved:,})", flush=True)

    # ─── Load VWAP cache ───────────────────────────────────────────────
    vwap_cache: dict[tuple[str, str], float] = {}
    if not args.refresh_vwap:
        cached = paginated(sb, "ticker_quarter_vwap", "ticker,period_of_report,vwap")
        for r in cached:
            vwap_cache[(r["ticker"], r["period_of_report"])] = float(r["vwap"])
        print(f"VWAP cache hits: {len(vwap_cache):,}", flush=True)

    # ─── Identify needed VWAPs ─────────────────────────────────────────
    needed: set[tuple[str, str]] = set()
    for (c, ticker), entries in traj.items():
        prev = 0
        for e in entries:
            if e["shares"] > prev and (ticker, e["period"]) not in vwap_cache:
                needed.add((ticker, e["period"]))
            prev = e["shares"]
    print(f"VWAPs to fetch: {len(needed):,}", flush=True)

    # ─── Fetch missing VWAPs (group by ticker for cache locality) ──────
    by_ticker: dict[str, list[str]] = defaultdict(list)
    for ticker, period in needed:
        by_ticker[ticker].append(period)

    new_rows: list[dict[str, Any]] = []
    for i, (ticker, periods) in enumerate(sorted(by_ticker.items()), 1):
        if i == 1 or i % 25 == 0 or i == len(by_ticker):
            print(f"  [{i}/{len(by_ticker)}] {ticker} ({len(periods)} quarter(s))", flush=True)
        for period in periods:
            time.sleep(0.15)  # be nice to Yahoo
            result = compute_quarter_vwap(yf, ticker, period)
            if result is None:
                continue
            vwap, bars = result
            vwap_cache[(ticker, period)] = vwap
            new_rows.append({
                "ticker": ticker,
                "period_of_report": period,
                "vwap": round(vwap, 4),
                "bars_used": bars,
            })

    # Upsert new VWAPs (chunked)
    if new_rows:
        print(f"Upserting {len(new_rows)} new VWAP rows…", flush=True)
        for off in range(0, len(new_rows), 500):
            sb.table("ticker_quarter_vwap").upsert(
                new_rows[off:off + 500], on_conflict="ticker,period_of_report",
            ).execute()

    # ─── Compute cost basis ────────────────────────────────────────────
    print("Computing weighted-avg cost basis per (filer, ticker)…", flush=True)
    cost_rows: list[dict[str, Any]] = []
    skipped_no_vwap = 0
    for (c, ticker), entries in traj.items():
        if not entries:
            continue
        latest = entries[-1]
        # Only currently-held positions
        if not latest["shares"] or latest["shares"] <= 0:
            continue

        prev_shares = 0
        accumulations: list[dict[str, Any]] = []
        total_cost = 0.0
        total_shares_bought = 0
        for e in entries:
            added = max(0, (e["shares"] or 0) - prev_shares)
            if added > 0:
                vwap = vwap_cache.get((ticker, e["period"]))
                if vwap is not None:
                    contribution = added * vwap
                    total_cost += contribution
                    total_shares_bought += added
                    accumulations.append({
                        "period": e["period"],
                        "delta_shares": added,
                        "quarter_vwap": round(vwap, 4),
                        "contribution_usd": round(contribution, 2),
                    })
            prev_shares = e["shares"] or 0

        if total_shares_bought == 0:
            skipped_no_vwap += 1
            continue

        cost_rows.append({
            "cik": c,
            "ticker": ticker,
            "as_of_period": latest["period"],
            "current_shares": latest["shares"],
            "current_value_usd": latest.get("value_usd"),
            "estimated_cost_basis": round(total_cost / total_shares_bought, 4),
            "total_cost_invested": round(total_cost, 2),
            "total_shares_bought": total_shares_bought,
            "accumulation_quarters": accumulations,
            "first_seen_period": entries[0]["period"],
        })
    print(f"  cost-basis rows: {len(cost_rows):,} (skipped {skipped_no_vwap:,} with no usable VWAP)", flush=True)

    # ─── Upsert ────────────────────────────────────────────────────────
    if cost_rows:
        print("Upserting filer_position_cost…", flush=True)
        for off in range(0, len(cost_rows), 500):
            sb.table("filer_position_cost").upsert(
                cost_rows[off:off + 500], on_conflict="cik,ticker,as_of_period",
            ).execute()

    print("Done.", flush=True)


if __name__ == "__main__":
    main()
