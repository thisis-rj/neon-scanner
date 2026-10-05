"""Earnings test — does a stock's move BEFORE an earnings report predict its move AFTER?

Vijay's hypothesis, tested two ways (CLAUDE.md §2.2 note on the earnings test):
  - backtest: every report since BACKTEST_START for the BACKTEST_TICKERS largest stocks
    on the Earnings tab, rebuilt from Yahoo history;
  - live log: each upcoming report is written down BEFORE it happens
    (registered from earnings_calendar), then measured once prices exist.
    A live row registered after its reaction session opened is marked 'late'
    and left out of the live score, so the live log can't be bent by hindsight.

Fixed windows — chosen before looking at any result; changing them means a new
test, not a tweak (testing many windows finds one that "works" by chance):
  - reaction day R = the first session that can react to the report: the
    report day for before-open / intraday reports, the next trading day for
    after-close reports. Reports with no time of day are excluded.
  - pre-move  = close[R-1] / close[R-1-PRE_DAYS] - 1   (10 trading days, all before the report)
  - reaction  = close[R]   / close[R-1] - 1            (the report's session)
  - drift     = close[R+DRIFT_DAYS] / close[R] - 1     (the 20 trading days after)
  Each is also measured for SPY over the same dates; "excess" = stock − SPY.
  path = the stock's daily returns from day R-30 to R+30 (61 values, units of
  0.001%; day k's return = close[R+k] / close[R+k-1] - 1), and SPY's daily
  returns go to earnings_test_spy. The /earnings-test explorer recomputes any
  window from these; the fixed windows above stay the pre-registered test.

Score (per cohort): each calendar quarter of reaction days is one earnings
season = one experiment. Within a season, split events into 5 equal groups by
pre-move excess; spread = top-group average minus bottom-group average. If the
pre-move predicts continuation, the spread is positive season after season;
reversal ("buy the rumor, sell the news") makes it negative.

Frozen rows: a measured row is never re-measured, so the page never changes
what it already showed.

Usage:
  python -m ingest.earnings_test                         # daily: register, measure, re-score
  python -m ingest.earnings_test --backfill              # one-off: history since BACKTEST_START
  python -m ingest.earnings_test --backfill --dry-run --limit 50   # compute + print, write nothing
"""
from __future__ import annotations

import argparse
import math
import os
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")

ET = ZoneInfo("America/New_York")
BENCH = "SPY"
PRE_DAYS = 10
DRIFT_DAYS = 20
BACKTEST_START = date(2021, 10, 1)  # 5 years before the live log starts
LIVE_FROM = date(2026, 10, 7)       # reports on/after this date come only from the live log
REGISTER_AHEAD_DAYS = 7             # register reports scheduled within the next week
MATCH_WINDOW_DAYS = 20              # Yahoo's scheduled date vs the actual report date
NO_REPORT_AFTER_DAYS = 30           # scheduled date this far past with no report → 'no_report'
BACKTEST_TICKERS = 300              # backtest = the 300 largest stocks on the Earnings tab
PATH_DAYS = 30                      # daily returns stored from day R-30 to R+30 for the explorer
MIN_SEASON_EVENTS = 25              # fewer events than this → the season isn't scored (5 per group)
PACE_S = 0.3                        # between per-ticker Yahoo calls

PENDING = ("scheduled", "reported", "reacted")
MEASURED = ("pre_start", "pre_ret", "pre_spy", "pre_excess", "react_ret", "react_spy",
            "react_excess", "drift_end", "drift_ret", "drift_spy", "drift_excess")


# ── Pure logic (tested in tests/test_earnings_test.py) ────────────────────────

def classify_session(ts: pd.Timestamp) -> str:
    """'bmo' (before 9:30 ET), 'intraday', 'amc' (16:00 ET or later), or 'unknown' (midnight = no time given)."""
    t = ts.tz_convert(ET) if ts.tzinfo else ts.tz_localize(ET)
    hm = (t.hour, t.minute)
    if hm == (0, 0):
        return "unknown"
    if hm < (9, 30):
        return "bmo"
    if hm >= (16, 0):
        return "amc"
    return "intraday"


def reaction_index(cal: pd.DatetimeIndex, report_date: date, session: str) -> int | None:
    """Position in `cal` (trading days) of the first session that can react, or None if not traded yet."""
    d = pd.Timestamp(report_date)
    pos = cal.searchsorted(d, side="right" if session == "amc" else "left")
    return int(pos) if pos < len(cal) else None


def daily_path(s: pd.Series, r: int) -> list[int | None]:
    """Daily returns at days R-PATH_DAYS..R+PATH_DAYS, ×100,000 and rounded; None where not available."""
    out: list[int | None] = []
    for i in range(r - PATH_DAYS, r + PATH_DAYS + 1):
        if i < 1 or i >= len(s) or pd.isna(s.iloc[i]) or pd.isna(s.iloc[i - 1]) or s.iloc[i - 1] <= 0:
            out.append(None)
        else:
            out.append(int(round((s.iloc[i] / s.iloc[i - 1] - 1) * 100_000)))
    return out


def spy_returns(closes: pd.DataFrame, since: date) -> list[dict]:
    """SPY daily returns (fraction) for every trading day on/after `since`."""
    b = closes[BENCH]
    ret = (b / b.shift(1) - 1).dropna()
    return [{"date": d.date(), "ret": round(float(v), 7)} for d, v in ret.items() if d.date() >= since]


def measure(closes: pd.DataFrame, ticker: str, report_date: date, session: str) -> dict:
    """Pre-move / reaction / drift for one report. Returns {'status', 'note'?, fields...}.

    `closes` holds FINAL daily closes only (index = trading days), with BENCH and `ticker` columns."""
    if session == "unknown":
        return {"status": "excluded", "note": "report time unknown"}
    if ticker not in closes:
        return {"status": "excluded", "note": "no prices"}
    cal = closes.index
    r = reaction_index(cal, report_date, session)
    if r is None:
        return {"status": "reported"}
    if r - 1 - PRE_DAYS < 0:
        return {"status": "excluded", "note": "not enough price history"}
    s, b = closes[ticker], closes[BENCH]
    i0, i1 = r - 1 - PRE_DAYS, r - 1
    vals = [s.iloc[i0], s.iloc[i1], s.iloc[r], b.iloc[i0], b.iloc[i1], b.iloc[r]]
    if any(pd.isna(v) or v <= 0 for v in vals):
        return {"status": "excluded", "note": "missing price around the report"}
    out = {
        "reaction_date": cal[r].date(),
        "pre_start": cal[i0].date(),
        "pre_ret": s.iloc[i1] / s.iloc[i0] - 1,
        "pre_spy": b.iloc[i1] / b.iloc[i0] - 1,
        "react_ret": s.iloc[r] / s.iloc[i1] - 1,
        "react_spy": b.iloc[r] / b.iloc[i1] - 1,
        "path": daily_path(s, r),
        "status": "reacted",
    }
    out["pre_excess"] = out["pre_ret"] - out["pre_spy"]
    out["react_excess"] = out["react_ret"] - out["react_spy"]
    j = r + DRIFT_DAYS
    if j < len(cal):
        if pd.isna(s.iloc[j]) or pd.isna(b.iloc[j]):
            return {"status": "excluded", "note": "missing price in the drift window"}
        out.update({
            "drift_end": cal[j].date(),
            "drift_ret": s.iloc[j] / s.iloc[r] - 1,
            "drift_spy": b.iloc[j] / b.iloc[r] - 1,
        })
        if r + PATH_DAYS < len(cal):
            out["status"] = "complete"  # every window the explorer can ask for has traded
        out["drift_excess"] = out["drift_ret"] - out["drift_spy"]
    return out


def registered_in_time(registered_at: datetime, reaction_date: date) -> bool:
    """True if the row was logged before the reaction session opened (9:30 ET)."""
    return registered_at < datetime.combine(reaction_date, dtime(9, 30), ET)


def plan_registrations(calendar: list[dict], existing: list[dict], today: date) -> list[dict]:
    """Live rows to add: reports scheduled in [today, today+7], on/after LIVE_FROM, not already logged
    for that ticker within ±MATCH_WINDOW_DAYS (Yahoo often moves the date a few days)."""
    logged: dict[str, list[date]] = {}
    for e in existing:
        logged.setdefault(e["ticker"], []).append(_d(e["scheduled_date"]))
    out = []
    for c in calendar:
        if not c.get("next_earnings"):
            continue
        d = _d(c["next_earnings"])
        if not (today <= d <= today + timedelta(days=REGISTER_AHEAD_DAYS)) or d < LIVE_FROM:
            continue
        near = logged.get(c["ticker"], [])
        if any(abs((d - x).days) <= MATCH_WINDOW_DAYS for x in near):
            continue
        logged.setdefault(c["ticker"], []).append(d)
        out.append({"ticker": c["ticker"], "scheduled_date": d, "source": "live", "status": "scheduled"})
    return out


def match_report(reports: list[dict], scheduled: date) -> dict | None:
    """The actual past report nearest the scheduled date, within ±MATCH_WINDOW_DAYS."""
    near = [r for r in reports if abs((r["report_date"] - scheduled).days) <= MATCH_WINDOW_DAYS]
    return min(near, key=lambda r: abs((r["report_date"] - scheduled).days)) if near else None


def reports_from_yahoo(df: pd.DataFrame | None, now: datetime) -> list[dict]:
    """Past reports from yfinance get_earnings_dates(): one per date (Yahoo repeats some), oldest first."""
    if df is None or len(df) == 0:
        return []
    out: dict[date, dict] = {}
    for ts, row in df.sort_index().iterrows():
        ts = pd.Timestamp(ts)
        ts = ts.tz_convert(ET) if ts.tzinfo else ts.tz_localize(ET)
        if ts.to_pydatetime() > now:
            continue  # a future date is only an estimate
        d = ts.date()
        if any(abs((d - k).days) < 25 for k in out):
            continue  # Yahoo repeats some reports, sometimes a few days apart: keep the first
        out[d] = {
            "report_date": d,
            "report_ts": ts.to_pydatetime(),
            "session": classify_session(ts),
            "eps_estimate": _num(row.get("EPS Estimate")),
            "eps_actual": _num(row.get("Reported EPS")),
            "surprise_pct": _num(row.get("Surprise(%)")),
        }
    return list(out.values())


def season_of(d: date) -> str:
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def _mean_t(xs: list[float]) -> dict:
    k = len(xs)
    if k == 0:
        return {"mean": None, "t": None, "seasons": 0, "positive": 0}
    m = sum(xs) / k
    if k < 2:
        return {"mean": m, "t": None, "seasons": k, "positive": sum(x > 0 for x in xs)}
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (k - 1))
    return {"mean": m, "t": (m / (sd / math.sqrt(k))) if sd > 0 else None,
            "seasons": k, "positive": sum(x > 0 for x in xs)}


def score(rows: pd.DataFrame) -> dict:
    """Season-by-season quintile test for one cohort. `rows`: reaction_date, pre_excess,
    react_excess, drift_excess (NaN until complete)."""
    df = rows.dropna(subset=["pre_excess", "react_excess"]).copy()
    if df.empty:
        return {"events": 0, "complete": 0, "seasons": [], "quintiles": [],
                "react_spread": _mean_t([]), "drift_spread": _mean_t([]),
                "same_sign": None, "spearman_react": None, "spearman_drift": None}
    df["season"] = [season_of(_d(x)) for x in df["reaction_date"]]
    df["q"] = pd.NA
    seasons, react_sp, drift_sp = [], [], []
    for s, g in df.groupby("season", sort=True):
        if len(g) < MIN_SEASON_EVENTS:
            seasons.append({"season": s, "events": len(g), "react_spread": None, "drift_spread": None})
            continue
        q = pd.qcut(g["pre_excess"].rank(method="first"), 5, labels=False) + 1
        df.loc[g.index, "q"] = q
        rs = g.loc[q == 5, "react_excess"].mean() - g.loc[q == 1, "react_excess"].mean()
        gd = g.assign(q=q).dropna(subset=["drift_excess"])
        ds = None
        if len(gd) >= MIN_SEASON_EVENTS:
            ds = gd.loc[gd.q == 5, "drift_excess"].mean() - gd.loc[gd.q == 1, "drift_excess"].mean()
            drift_sp.append(float(ds))
        react_sp.append(float(rs))
        seasons.append({"season": s, "events": len(g), "react_spread": float(rs),
                        "drift_spread": None if ds is None else float(ds)})
    scored = df.dropna(subset=["q"])
    quintiles = []
    for qn in range(1, 6):
        g = scored[scored.q == qn]
        if g.empty:
            continue
        quintiles.append({
            "q": qn, "events": len(g),
            "pre_excess": float(g.pre_excess.mean()),
            "react_excess": float(g.react_excess.mean()),
            "react_median": float(g.react_excess.median()),
            "react_up_share": float((g.react_excess > 0).mean()),
            "drift_excess": None if g.drift_excess.isna().all() else float(g.drift_excess.mean()),
        })
    nz = df[(df.pre_excess != 0) & (df.react_excess != 0)]
    dd = df.dropna(subset=["drift_excess"])
    return {
        "events": len(df),
        "complete": int(df.drift_excess.notna().sum()),
        "seasons": seasons,
        "quintiles": quintiles,
        "react_spread": _mean_t(react_sp),
        "drift_spread": _mean_t(drift_sp),
        "same_sign": float(((nz.pre_excess > 0) == (nz.react_excess > 0)).mean()) if len(nz) else None,
        "spearman_react": _spearman(df.pre_excess, df.react_excess),
        "spearman_drift": _spearman(dd.pre_excess, dd.drift_excess),
    }


def _spearman(a: pd.Series, b: pd.Series) -> float | None:
    """Rank correlation = plain correlation of the ranks (no scipy in this repo)."""
    if len(a) < 3:
        return None
    r = a.rank().corr(b.rank())
    return None if pd.isna(r) else float(r)


def _d(x) -> date:
    return x if isinstance(x, date) and not isinstance(x, datetime) else date.fromisoformat(str(x)[:10])


def _num(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


# ── IO ────────────────────────────────────────────────────────────────────────

def now_et() -> datetime:
    return datetime.now(ET)


def last_final_close(now: datetime) -> date:
    """Latest date whose close is final: today after 16:30 ET, else yesterday."""
    return now.date() if now.time() >= dtime(16, 30) else now.date() - timedelta(days=1)


def fetch_closes(tickers: list[str], start: date, final: date) -> pd.DataFrame:
    """Dividend-adjusted final daily closes for `tickers` + SPY, on SPY's trading days."""
    import yfinance as yf

    syms = sorted(set(tickers) | {BENCH})
    frames = []
    for i in range(0, len(syms), 100):
        chunk = syms[i:i + 100]
        for attempt in range(2):
            try:
                c = yf.download(chunk, start=str(start), auto_adjust=True, progress=False,
                                threads=True)["Close"]
                if isinstance(c, pd.Series):
                    c = c.to_frame(chunk[0])
                frames.append(c)
                break
            except Exception as e:  # noqa: BLE001 — retry once, then skip the chunk
                print(f"  price chunk {i}: {e}", flush=True)
                time.sleep(5)
    df = pd.concat(frames, axis=1) if frames else pd.DataFrame()
    df.index = pd.DatetimeIndex(df.index).tz_localize(None).normalize()
    df = df.loc[:, ~df.columns.duplicated()]
    if BENCH not in df or df[BENCH].dropna().empty:
        raise SystemExit("earnings_test: no SPY prices from Yahoo (rate-limited?) — nothing written")
    df = df[df[BENCH].notna()]  # SPY's trading calendar
    return df[df.index <= pd.Timestamp(final)]


def yahoo_reports(ticker: str, now: datetime, limit: int = 60) -> list[dict]:
    import yfinance as yf

    try:
        return reports_from_yahoo(yf.Ticker(ticker).get_earnings_dates(limit=limit), now)
    except Exception as e:  # noqa: BLE001 — ETFs / delisted names have none
        print(f"  {ticker}: no earnings dates ({str(e)[:80]})", flush=True)
        return []


def fetch_all(sb, table: str, columns: str, order: tuple[str, ...] = ("ticker", "scheduled_date"),
              **eq) -> list[dict]:
    rows, offset = [], 0
    while True:
        q = sb.table(table).select(columns)
        for k, v in eq.items():
            q = q.in_(k, v) if isinstance(v, (list, tuple)) else q.eq(k, v)
        for o in order:
            q = q.order(o)
        page = q.range(offset, offset + 999).execute().data
        rows += page
        if len(page) < 1000:
            return rows
        offset += 1000


def _row_out(r: dict) -> dict:
    """JSON-safe row for Supabase."""
    out = {}
    for k, v in r.items():
        if isinstance(v, datetime):
            out[k] = v.isoformat()
        elif isinstance(v, date):
            out[k] = v.isoformat()
        elif isinstance(v, float):
            out[k] = None if math.isnan(v) else round(v, 6)
        else:
            out[k] = v
    return out


def sector_map(sb) -> dict[str, str]:
    """Yahoo sector per ticker from `tickers` (migration 027)."""
    return {r["ticker"]: r["sector"] for r in fetch_all(sb, "tickers", "ticker,sector", order=("ticker",))
            if r.get("sector")}


def upsert_spy(sb, rows: list[dict]) -> None:
    for i in range(0, len(rows), 1000):
        sb.table("earnings_test_spy").upsert([_row_out(r) for r in rows[i:i + 1000]],
                                             on_conflict="date").execute()


def upsert(sb, rows: list[dict]) -> None:
    for i in range(0, len(rows), 500):
        sb.table("earnings_test_events").upsert([_row_out(r) for r in rows[i:i + 500]],
                                                on_conflict="ticker,scheduled_date").execute()


def apply_measure(row: dict, closes: pd.DataFrame, now: datetime) -> dict:
    """Measure a row that has a report; set source 'late' if a live row was logged too late."""
    m = measure(closes, row["ticker"], _d(row["report_date"]), row["session"])
    row = {**row, **m, "measured_at": now}
    if row["source"] == "live" and m.get("reaction_date"):
        reg = row["registered_at"]
        reg = reg if isinstance(reg, datetime) else datetime.fromisoformat(str(reg))
        if not registered_in_time(reg, m["reaction_date"]):
            row["source"] = "late"
    return row


def backfill(sb, limit: int | None, dry_run: bool) -> list[dict]:
    """History since BACKTEST_START for the BACKTEST_TICKERS largest stocks in earnings_calendar."""
    now = now_et()
    cal = fetch_all(sb, "earnings_calendar", "ticker,next_earnings,market_cap_usd", order=("ticker",))
    universe = sorted((c for c in cal if c.get("next_earnings")),
                      key=lambda c: -(c.get("market_cap_usd") or 0))
    done: set[str] = set()
    if not dry_run:
        done = {r["ticker"] for r in fetch_all(sb, "earnings_test_events", "ticker,scheduled_date",
                                               source="backtest")}
    top = [c["ticker"] for c in universe][:BACKTEST_TICKERS]
    tickers = [t for t in top if t not in done][:limit]
    print(f"backfill: {len(tickers)} tickers ({len(done)} already done)", flush=True)

    events: list[dict] = []
    for i, t in enumerate(tickers):
        for rep in yahoo_reports(t, now):
            if BACKTEST_START <= rep["report_date"] < LIVE_FROM:
                events.append({"ticker": t, "scheduled_date": rep["report_date"], "source": "backtest",
                               "status": "reported", "registered_at": now, **rep})
        if i % 100 == 0:
            print(f"  [{i:>4}/{len(tickers)}] events so far {len(events)}", flush=True)
        time.sleep(PACE_S)

    closes = fetch_closes(tickers, BACKTEST_START - timedelta(days=60), last_final_close(now))
    sectors = sector_map(sb)
    for e in events:
        e["sector"] = sectors.get(e["ticker"])
    rows = [apply_measure(e, closes, now) for e in events]
    if not dry_run:
        upsert(sb, rows)
        upsert_spy(sb, spy_returns(closes, BACKTEST_START - timedelta(days=60)))
    return rows


def daily(sb, dry_run: bool) -> None:
    now = now_et()
    today = now.date()
    existing = fetch_all(sb, "earnings_test_events", "ticker,scheduled_date", source=["live", "late"])
    cal = fetch_all(sb, "earnings_calendar", "ticker,next_earnings", order=("ticker",))
    new = plan_registrations(cal, existing, today)
    sectors = sector_map(sb) if new else {}
    for r in new:
        r["sector"] = sectors.get(r["ticker"])
    print(f"register: {len(new)} upcoming reports", flush=True)
    if new and not dry_run:
        sb.table("earnings_test_events").insert(
            [_row_out({**r, "registered_at": now}) for r in new]).execute()

    pending = fetch_all(sb, "earnings_test_events", "*", status=list(PENDING))
    updates: list[dict] = []
    for row in pending:
        if row["status"] != "scheduled":
            continue
        sched = _d(row["scheduled_date"])
        if sched > today:
            continue
        rep = match_report(yahoo_reports(row["ticker"], now, limit=12), sched)
        time.sleep(PACE_S)
        if rep:
            row.update({**rep, "status": "reported"})
        elif (today - sched).days > NO_REPORT_AFTER_DAYS:
            row.update({"status": "no_report", "note": f"no report within {MATCH_WINDOW_DAYS} days of the scheduled date"})
            updates.append(row)
    to_measure = [r for r in pending if r["status"] in ("reported", "reacted") and r.get("report_date")]
    if to_measure:
        start = min(_d(r["report_date"]) for r in to_measure) - timedelta(days=60)
        closes = fetch_closes([r["ticker"] for r in to_measure], start, last_final_close(now))
        # Re-measured daily until complete: the post-report part of the path grows each day.
        updates += [apply_measure(r, closes, now) for r in to_measure]
        if not dry_run:
            upsert_spy(sb, spy_returns(closes, start))
    print(f"measure: {len(to_measure)} reported, {len(updates)} rows written", flush=True)
    if updates and not dry_run:
        upsert(sb, updates)


def rescore(sb, dry_run: bool, rows: list[dict] | None = None) -> dict:
    if rows is None:
        rows = fetch_all(sb, "earnings_test_events",
                         "ticker,scheduled_date,source,status,reaction_date,pre_excess,react_excess,drift_excess",
                         status=["reacted", "complete"])
    df = pd.DataFrame(rows)
    out = {}
    for cohort in ("backtest", "live"):
        sub = df[(df.source == cohort) & df.status.isin(["reacted", "complete"])] if len(df) else df
        cols = ["reaction_date", "pre_excess", "react_excess", "drift_excess"]
        sub = sub.reindex(columns=cols).astype({c: float for c in cols[1:]}) if len(sub) else pd.DataFrame(columns=cols)
        out[cohort] = score(sub)
    if not dry_run:
        stamp = datetime.now(timezone.utc).isoformat()
        sb.table("earnings_test_summary").upsert(
            [{"cohort": k, "data": v, "computed_at": stamp} for k, v in out.items()],
            on_conflict="cohort").execute()
    return out


def print_score(name: str, s: dict) -> None:
    rs, ds = s["react_spread"], s["drift_spread"]
    fmt = lambda v: "—" if v is None else f"{v:+.2%}"  # noqa: E731
    print(f"\n[{name}] events {s['events']} (complete {s['complete']}), scored seasons {rs['seasons']}")
    if s["quintiles"]:
        print("  q   events   pre      reaction  (median)  up%    drift")
        for q in s["quintiles"]:
            print(f"  Q{q['q']}  {q['events']:>6}  {fmt(q['pre_excess']):>7}  {fmt(q['react_excess']):>8}"
                  f"  {fmt(q['react_median']):>8}  {q['react_up_share']:.0%}  {fmt(q['drift_excess']):>7}")
    for label, sp in (("reaction", rs), ("drift", ds)):
        if sp["seasons"]:
            t = "—" if sp["t"] is None else f"{sp['t']:+.2f}"
            print(f"  Q5−Q1 {label}: mean {fmt(sp['mean'])} per season, t {t}, positive in "
                  f"{sp['positive']}/{sp['seasons']} seasons")
    if s["same_sign"] is not None:
        print(f"  same sign (pre vs reaction): {s['same_sign']:.1%}   "
              f"spearman reaction {s['spearman_react']:+.3f}  drift {s['spearman_drift'] or 0:+.3f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill", action="store_true", help="one-off: history since BACKTEST_START")
    ap.add_argument("--dry-run", action="store_true", help="compute + print; write nothing")
    ap.add_argument("--limit", type=int, default=None, help="backfill: cap tickers (largest first)")
    ap.add_argument("--csv", help="backfill: also save the measured rows to this CSV")
    args = ap.parse_args()

    from supabase import create_client

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    if args.backfill:
        rows = backfill(sb, args.limit, args.dry_run)
        by = pd.Series([r["status"] for r in rows]).value_counts().to_dict() if rows else {}
        print(f"backfill rows: {len(rows)} {by}")
        if args.csv:
            pd.DataFrame([_row_out(r) for r in rows]).to_csv(args.csv, index=False)
        if args.dry_run:
            for k, v in rescore(sb, True, [_row_out(r) for r in rows]).items():
                print_score(k, v)
            return
    else:
        daily(sb, args.dry_run)
    for k, v in rescore(sb, args.dry_run).items():
        print_score(k, v)


if __name__ == "__main__":
    main()
