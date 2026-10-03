"""Compute trailing 13F-clone returns (1Y, 3Y) per tracked filer.

For each filer:
  - find the 13F period closest to (latest_period - N quarters)
  - value-weight every position by its disclosed value
  - entry price = quarter-end mark (value_usd / shares), scale-corrected
    for the SEC thousands-vs-dollars inconsistency
  - exit price = current tickers.price
  - return = Σ weight × (exit/entry − 1)

Writes filer_performance (cik, horizon, return_pct, priced_coverage, ...).

CAVEAT (surfaced in UI): this is the disclosed-long-book return, NOT the
filer's actual fund return. 13F omits shorts, cash, options, international.

Usage:  python -m ingest.filer_returns
"""
from __future__ import annotations

import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SECRET_KEY = os.environ["SUPABASE_SECRET_KEY"]

SUFFIX_RE = re.compile(
    r"\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HLDGS|GROUP|GRP|LLC|LP|TRUST|N V|NV|SA|AG|TR|CL A|CL B|CLASS A|CLASS B|COM|ORD|ORDINARY|SHARES)\b\.?",
    re.I,
)
PUNCT_RE = re.compile(r"[.,&/\-()']")


def _sb() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)


def norm(s: str | None) -> str:
    if not s:
        return ""
    s = s.upper()
    s = PUNCT_RE.sub(" ", s)
    s = SUFFIX_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def resolve(issuer: str | None, n2t: dict[str, str]) -> str | None:
    n = norm(issuer)
    if n in n2t:
        return n2t[n]
    t = re.sub(r"\s[A-Z]{1,2}$", "", n).strip()
    return n2t.get(t)


def paginate(sb: Client, table: str, sel: str, **filt) -> list[dict[str, Any]]:
    out, off = [], 0
    while True:
        q = sb.table(table).select(sel)
        for k, v in filt.items():
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
    sb = _sb()

    # Resolver maps
    uni = paginate(sb, "tickers", "ticker,name,price")
    n2t: dict[str, str] = {}
    price: dict[str, float] = {}
    for x in uni:
        nm = norm(x.get("name"))
        if nm and nm not in n2t:
            n2t[nm] = x["ticker"]
        if x.get("price") is not None:
            price[x["ticker"]] = x["price"]
    cmap = {x["cusip"]: x["ticker"] for x in paginate(sb, "cusip_ticker_map", "cusip,ticker") if x.get("ticker")}
    # VWAP per (ticker, period) — real yfinance prices, used as the clone ENTRY
    # so we never touch the scale-ambiguous 13F value field for pricing.
    vwap: dict[tuple[str, str], float] = {}
    for v in paginate(sb, "ticker_quarter_vwap", "ticker,period_of_report,vwap"):
        if v.get("vwap"):
            vwap[(v["ticker"], v["period_of_report"])] = float(v["vwap"])
    print(f"resolver: {len(n2t)} names, {len(cmap)} cusips, {len(price)} prices, {len(vwap)} vwaps", flush=True)

    # All holdings grouped by (cik, period)
    # Effective long-equity rows (migration 019): restated quarters count once,
    # options and bond principal excluded.
    print("loading holdings_13f_effective…", flush=True)
    holds = paginate(sb, "holdings_13f_effective", "cik,period_of_report,cusip,issuer_name,shares,value_usd")
    by_cp: dict[tuple[str, str], list[dict]] = defaultdict(list)
    periods_by_cik: dict[str, set[str]] = defaultdict(set)
    for h in holds:
        by_cp[(h["cik"], h["period_of_report"])].append(h)
        periods_by_cik[h["cik"]].add(h["period_of_report"])
    print(f"  {len(holds):,} rows, {len(periods_by_cik)} filers", flush=True)

    cfg = yaml.safe_load((PROJECT_ROOT / "config" / "tracked_filers.yml").open())
    ciks = [str(int(f["cik"])).zfill(10) for f in cfg["filers"] if f.get("cik")]

    def entry_price(h: dict, tk: str, period: str) -> float | None:
        """Prefer the clean quarter VWAP; fall back to the 13F quarter-end mark
        (value/shares) with per-position scale normalization for the SEC
        thousands-vs-dollars inconsistency."""
        e = vwap.get((tk, period))
        if e and e > 0.5:
            return e
        v = h.get("value_usd") or 0
        sh = h.get("shares") or 0
        if v <= 0 or sh <= 0:
            return None
        e = v / sh
        # normalize thousands-scale: bump until in a plausible equity range
        guard = 0
        while e < 1.0 and guard < 3:
            e *= 1000
            guard += 1
        return e if 0.5 < e < 100000 else None

    def clone_return(cik: str, period: str) -> tuple[float, float, int] | None:
        """Value-weighted clone-and-hold return. Per-position return is CLAMPED
        to [-90%, +400%] so a single mis-resolved ticker (e.g. a name collision)
        can't distort the aggregate. value_usd weights only (scale cancels)."""
        rows = by_cp.get((cik, period))
        if not rows:
            return None
        seen, pos = set(), []
        for h in rows:
            if h["cusip"] in seen:
                continue
            seen.add(h["cusip"])
            v = h.get("value_usd") or 0
            if v > 0:
                pos.append((h, float(v)))
        if not pos:
            return None
        total = pv = wret = 0.0
        for h, v in pos:
            total += v
            tk = cmap.get(h["cusip"]) or resolve(h.get("issuer_name"), n2t)
            now = price.get(tk) if tk else None
            entry = entry_price(h, tk, period) if tk else None
            if entry and now and now > 0.5:
                r = now / entry - 1
                r = max(-0.90, min(4.0, r))  # clamp per-position
                pv += v
                wret += v * r
        if pv <= 0:
            return None
        return (100 * wret / pv, pv / total if total else 0.0, len(pos))

    def closest_period(cik: str, quarters_back: int) -> str | None:
        ps = sorted(periods_by_cik[cik])
        if len(ps) <= quarters_back:
            # not enough history; use earliest if it's at least ~quarters_back*0.6 old
            return ps[0] if len(ps) >= max(4, int(quarters_back * 0.6)) else None
        return ps[-1 - quarters_back]

    rows_out = []
    for cik in ciks:
        if cik not in periods_by_cik:
            continue
        for horizon, qb in (("1Y", 4), ("3Y", 12)):
            per = closest_period(cik, qb)
            if not per:
                continue
            res = clone_return(cik, per)
            if not res:
                continue
            ret, cov, npos = res
            if cov < 0.60:  # too little of the book priceable → unreliable, skip
                continue
            rows_out.append({
                "cik": cik,
                "horizon": horizon,
                "from_period": per,
                "return_pct": round(ret, 1),
                "priced_coverage": round(cov, 3),
                "positions": npos,
            })

    # Clear stale rows first so a filer that drops below the coverage gate this
    # run doesn't keep a previous (possibly wrong) value. Then insert fresh.
    sb.table("filer_performance").delete().neq("cik", "__none__").execute()
    if rows_out:
        sb.table("filer_performance").insert(rows_out).execute()
    print(f"wrote {len(rows_out)} filer_performance rows.", flush=True)
    # quick sanity print
    for r in rows_out[:8]:
        print(f"  {r['cik']} {r['horizon']}: {r['return_pct']:+.0f}% (cov {r['priced_coverage']*100:.0f}%, from {r['from_period']})", flush=True)


if __name__ == "__main__":
    main()
