"""Analyst rating & price-target changes + each firm's target track record.

Source: Yahoo upgrades/downgrades via yfinance (free; firm names only — Yahoo
does not carry individual analyst names).

Modes
  python -m ingest.analyst_ratings                # daily: held stocks (portfolio_positions qty>0)
  python -m ingest.analyst_ratings --full         # + every ticker with market cap >= --min-cap-b ($B)
  python -m ingest.analyst_ratings --score        # recompute analyst_firm_records from analyst_calls

Track record rule (fixed before testing, Nov 2026): a price target counts as
hit if the stock trades at/through it (close) within 252 trading days of the
call. Scoped per (firm, Yahoo industry) and per (firm, 'ALL'); a scope needs
>= MIN_TARGETS judged targets. Context only — past hit rate did not predict
future hit rate in our test, so nothing here is a "trust" score.
"""
from __future__ import annotations

import argparse
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from dotenv import load_dotenv
from supabase import Client, create_client

from ingest.compute_buy_signals import paginated

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

MIN_TARGETS = 20
HORIZON = 252
START = "2018-01-01"


def _supabase() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])


def _num(v):
    try:
        f = float(v)
        return None if np.isnan(f) or f <= 0 else f
    except (TypeError, ValueError):
        return None


def held_tickers(sb: Client) -> list[str]:
    rows = sb.table("portfolio_positions").select("ticker").gt("qty", 0).execute().data or []
    return sorted({r["ticker"] for r in rows})


def big_tickers(sb: Client, min_cap_b: float) -> list[str]:
    rows = paginated(sb, "tickers", "ticker,market_cap_usd", order="ticker")
    return sorted(r["ticker"] for r in rows if (r.get("market_cap_usd") or 0) >= min_cap_b * 1e9)


def fetch_calls(tickers: list[str]) -> list[dict]:
    import yfinance as yf

    out: list[dict] = []
    for i, t in enumerate(tickers, 1):
        try:
            u = yf.Ticker(t).upgrades_downgrades
        except Exception as e:  # Yahoo 404s on funds/ETFs — skip quietly
            u = None
        if u is not None and not u.empty:
            u = u.reset_index()
            u = u[pd.to_datetime(u["GradeDate"]) >= START]
            for r in u.itertuples(index=False):
                ts = pd.Timestamp(r.GradeDate)
                ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
                out.append(dict(
                    ticker=t, firm=str(r.Firm).strip(), graded_at=ts.isoformat(),
                    action=r.Action, to_grade=r.ToGrade or None, from_grade=r.FromGrade or None,
                    pt_action=getattr(r, "priceTargetAction", None) or None,
                    price_target=_num(getattr(r, "currentPriceTarget", None)),
                    prior_target=_num(getattr(r, "priorPriceTarget", None)),
                ))
        if i % 100 == 0:
            print(f"  {i}/{len(tickers)} tickers, {len(out)} calls", flush=True)
        time.sleep(0.35)
    return out


def upsert_calls(sb: Client, rows: list[dict]) -> None:
    # Yahoo occasionally repeats a (ticker, firm, timestamp) — keep the last.
    dedup = {(r["ticker"], r["firm"], r["graded_at"]): r for r in rows}
    rows = list(dedup.values())
    for i in range(0, len(rows), 500):
        sb.table("analyst_calls").upsert(rows[i:i + 500], on_conflict="ticker,firm,graded_at").execute()
    print(f"  upserted {len(rows)} calls", flush=True)


def score(sb: Client) -> None:
    import yfinance as yf

    calls = pd.DataFrame(paginated(sb, "analyst_calls", "ticker,firm,graded_at,price_target", order="ticker,firm,graded_at"))
    calls = calls[calls.price_target.notna()].copy()
    calls["date"] = pd.to_datetime(calls.graded_at, utc=True).dt.tz_localize(None).dt.normalize()
    cutoff = pd.Timestamp.today().normalize() - pd.Timedelta(days=380)
    calls = calls[calls.date <= cutoff]  # only targets whose 12 months have run
    if calls.empty:
        print("  nothing to score yet", flush=True)
        return
    industry = {r["ticker"]: r.get("industry") for r in paginated(sb, "tickers", "ticker,industry", order="ticker")}
    tick = sorted(calls.ticker.unique())
    print(f"  scoring {len(calls)} targets on {len(tick)} tickers", flush=True)
    px = {}
    for i in range(0, len(tick), 200):
        d = yf.download(tick[i:i + 200], start=START, progress=False, auto_adjust=False, threads=True)["Close"]
        if isinstance(d, pd.Series):
            d = d.to_frame(tick[i])
        for t in d.columns:
            px[t] = d[t].dropna()
    res = []
    for r in calls.itertuples(index=False):
        s = px.get(r.ticker)
        if s is None or s.empty:
            continue
        i = s.index.searchsorted(r.date)
        if i == 0 or i + HORIZON >= len(s):
            continue
        p0, tgt = s.iloc[i - 1], r.price_target
        if not (0.25 < tgt / p0 < 4):  # implausible target vs price = data error
            continue
        w = s.iloc[i:i + HORIZON + 1]
        hit = (w.max() >= tgt) if tgt > p0 else (w.min() <= tgt)
        res.append((r.firm, industry.get(r.ticker) or "Unclassified", r.date, bool(hit), s.iloc[i + HORIZON] < p0))
    R = pd.DataFrame(res, columns=["firm", "scope", "date", "hit", "fell"])
    R_all = R.assign(scope="ALL")
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for frame in (R, R_all):
        avg = frame.groupby("scope").hit.mean()
        for (firm, scope), g in frame.groupby(["firm", "scope"]):
            if len(g) < MIN_TARGETS:
                continue
            f = g[g.fell]
            out.append(dict(firm=firm, scope=scope, targets=int(len(g)), hit_rate=round(float(g.hit.mean()), 4),
                            hit_when_fell=round(float(f.hit.mean()), 4) if len(f) >= 5 else None,
                            scope_avg=round(float(avg[scope]), 4), first_call=str(g.date.min().date()), computed_at=now))
    for i in range(0, len(out), 500):
        sb.table("analyst_firm_records").upsert(out[i:i + 500], on_conflict="firm,scope").execute()
    sb.table("analyst_firm_records").delete().lt("computed_at", now).execute()
    print(f"  wrote {len(out)} firm records", flush=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--full", action="store_true")
    p.add_argument("--min-cap-b", type=float, default=2.0)
    p.add_argument("--score", action="store_true")
    p.add_argument("--tickers", type=str, default=None)
    a = p.parse_args()
    sb = _supabase()
    if a.tickers:
        tickers = [t.strip().upper() for t in a.tickers.split(",") if t.strip()]
    else:
        tickers = held_tickers(sb)
        if a.full:
            tickers = sorted(set(tickers) | set(big_tickers(sb, a.min_cap_b)))
    print(f"Fetching analyst calls for {len(tickers)} tickers", flush=True)
    upsert_calls(sb, fetch_calls(tickers))
    if a.score:
        score(sb)


if __name__ == "__main__":
    main()
