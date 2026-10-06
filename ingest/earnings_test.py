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
  Context known BEFORE the report, for cohorts:
    vol_path   = volume on days R-30..R-1 as % of normal (average of the 60
                 trading days before R-30);
    ma50_gap / ma200_gap = close[R-1] vs the average of the 50 / 200 closes
                 ending at R-1, minus 1;
    insider_buyers / insider_buy_usd = distinct insiders with open-market
                 buys (Form 4, code P) FILED in the 90 days before the report
                 date — filed, so the public could have seen them.
    analyst    = Yahoo upgrades/downgrades in the ANALYST_DAYS trading days
                 before day 0: [k, code, price-target change], k = the
                 trading day it was public by the close (after 16:00 → next day);
    ohlc_path  = [overnight gap, high-low range] for days R-30..R-1.

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
VOL_BASE_DAYS = 60                  # "normal" volume = average of the 60 trading days before day R-30
ANALYST_DAYS = 63                   # trading days (~3 months) of analyst actions kept before day 0
INSIDER_DAYS = 90                   # insider buys FILED in the 90 calendar days before the report
SAMPLE_SEED = 20261007              # fixed: the random size-tier samples are reproducible
TIERS = {                           # by market cap in `tickers` today (USD)
    "small": (3e8, 2e9), "mid": (2e9, 1e10), "large": (1e10, 2e11), "mega": (2e11, float("inf")),
}
PRICE_LOOKBACK_DAYS = 340           # calendar days of prices before a report: 200-day average + 30-day path
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


def volume_path(v: pd.Series, r: int) -> list[int | None] | None:
    """Volume on days R-30..R-1 as % of the average of the 60 trading days before R-30.
    None if that baseline has fewer than 40 days of volume."""
    lo, hi = r - PATH_DAYS - VOL_BASE_DAYS, r - PATH_DAYS
    if lo < 0:
        return None
    base = v.iloc[lo:hi]
    base = base[base > 0].dropna()
    if len(base) < 40:
        return None
    m = float(base.mean())
    out: list[int | None] = []
    for i in range(r - PATH_DAYS, r):
        x = v.iloc[i]
        out.append(None if pd.isna(x) or x <= 0 else int(round(x / m * 100)))
    return out


def ma_gap(s: pd.Series, r: int, n: int) -> float | None:
    """close[R-1] / average of the n closes ending at R-1, minus 1. None without n full closes."""
    if r - n < 0:
        return None
    w = s.iloc[r - n:r]
    if w.isna().any() or (w <= 0).any():
        return None
    return float(w.iloc[-1] / w.mean() - 1)


def insider_counts(buys: list[dict], report_date: date) -> tuple[int, float]:
    """(distinct insiders, total $) among one ticker's buys FILED in the INSIDER_DAYS before the report."""
    lo = report_date - timedelta(days=INSIDER_DAYS)
    who, usd = set(), 0.0
    for b in buys:
        f = _d(b["filed"])
        if lo <= f < report_date:
            who.add(b["who"])
            usd += b["usd"] or 0.0
    return len(who), usd


def ohlc_path(o: pd.Series, h: pd.Series, lo: pd.Series, c: pd.Series, r: int) -> list[list[int | None]] | None:
    """[gap, range] for days R-30..R-1, ×100,000: gap = open / previous close - 1, range = (high - low) / close."""
    if r - PATH_DAYS < 1:
        return None
    out = []
    for i in range(r - PATH_DAYS, r):
        pc, oo, hh, ll, cc = c.iloc[i - 1], o.iloc[i], h.iloc[i], lo.iloc[i], c.iloc[i]
        gap = None if pd.isna(pc) or pd.isna(oo) or pc <= 0 else int(round((oo / pc - 1) * 100_000))
        rng = None if pd.isna(hh) or pd.isna(ll) or pd.isna(cc) or cc <= 0 else int(round((hh - ll) / cc * 100_000))
        out.append([gap, rng])
    return out


ACTION_CODES = {"up": "up", "down": "down", "init": "init", "main": "main", "reit": "main"}


def actions_from_yahoo(df: pd.DataFrame | None) -> list[dict]:
    """Yahoo upgrades_downgrades → [{public: date it was known by the close, code, pt}]."""
    if df is None or len(df) == 0:
        return []
    out = []
    for ts, row in df.iterrows():
        ts = pd.Timestamp(ts)
        code = ACTION_CODES.get(str(row.get("Action", "")).lower())
        if code is None:
            continue
        cur, prior = _num(row.get("currentPriceTarget")), _num(row.get("priorPriceTarget"))
        pt = (cur / prior - 1) if cur and prior and prior > 0 else None
        # Yahoo's GradeDate has no zone; treat it as New York time. After the close → known next day.
        day = ts.date() + timedelta(days=1) if (ts.hour, ts.minute) >= (16, 0) else ts.date()
        out.append({"public": day, "code": code, "pt": pt})
    return out


def analyst_window(acts: list[dict], cal: pd.DatetimeIndex, r: int) -> list[list]:
    """[k, code, pt] for actions public on trading days R-ANALYST_DAYS..R-1 (k < 0)."""
    out = []
    lo = r - ANALYST_DAYS
    for a in acts:
        d = pd.Timestamp(a["public"])
        if len(cal) == 0 or d < cal[0]:
            continue  # before the price calendar: can't place it (and it's far older than the window)
        i = int(cal.searchsorted(d, side="left"))  # weekend → next trading day
        if lo <= i < r:
            out.append([i - r, a["code"], None if a["pt"] is None else round(float(a["pt"]), 4)])
    return sorted(out, key=lambda x: x[0])


def context(closes: pd.DataFrame, volumes: pd.DataFrame | None, ticker: str, report_date: date,
            session: str, buys: list[dict] | None, cap_today: float | None = None,
            ohl: dict[str, pd.DataFrame] | None = None, acts: list[dict] | None = None) -> dict:
    """Pre-report context for cohorts (vol_path, ma gaps, insider buys, size, analyst actions, gaps/ranges).
    Only keys it could compute."""
    out: dict = {}
    if buys is not None:
        out["insider_buyers"], out["insider_buy_usd"] = insider_counts(buys, report_date)
    if session == "unknown" or ticker not in closes:
        return out
    r = reaction_index(closes.index, report_date, session)
    if r is None:
        return out
    if cap_today:
        s = closes[ticker].dropna()
        then = closes[ticker].iloc[r - 1] if r >= 1 else float("nan")
        if len(s) and pd.notna(then) and then > 0:
            out["mcap_at_report"] = float(cap_today * then / s.iloc[-1])
    out["ma50_gap"] = ma_gap(closes[ticker], r, 50)
    out["ma200_gap"] = ma_gap(closes[ticker], r, 200)
    if volumes is not None and ticker in volumes:
        out["vol_path"] = volume_path(volumes[ticker].reindex(closes.index), r)
    if ohl is not None and all(ticker in ohl[k] for k in ("Open", "High", "Low")):
        o, h, lo = (ohl[k][ticker].reindex(closes.index) for k in ("Open", "High", "Low"))
        out["ohlc_path"] = ohlc_path(o, h, lo, closes[ticker], r)
    if acts is not None:
        out["analyst"] = analyst_window(acts, closes.index, r)
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


def fetch_prices(tickers: list[str], start: date, final: date, ohl: dict | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(closes, volumes): dividend-adjusted final daily closes and share volumes for `tickers` + SPY,
    on SPY's trading days. Pass a dict as `ohl` to also get adjusted Open / High / Low frames in it."""
    import yfinance as yf

    syms = sorted(set(tickers) | {BENCH})
    frames, vframes, extra = [], [], {"Open": [], "High": [], "Low": []}
    for i in range(0, len(syms), 100):
        chunk = syms[i:i + 100]
        for attempt in range(2):
            try:
                raw = yf.download(chunk, start=str(start), auto_adjust=True, progress=False, threads=True)
                c, v = raw["Close"], raw["Volume"]
                if isinstance(c, pd.Series):
                    c, v = c.to_frame(chunk[0]), v.to_frame(chunk[0])
                frames.append(c)
                vframes.append(v)
                if ohl is not None:
                    for k in extra:
                        x = raw[k]
                        extra[k].append(x.to_frame(chunk[0]) if isinstance(x, pd.Series) else x)
                break
            except Exception as e:  # noqa: BLE001 — retry once, then skip the chunk
                print(f"  price chunk {i}: {e}", flush=True)
                time.sleep(5)
    def tidy(fs: list[pd.DataFrame]) -> pd.DataFrame:
        d = pd.concat(fs, axis=1) if fs else pd.DataFrame()
        d.index = pd.DatetimeIndex(d.index).tz_localize(None).normalize()
        return d.loc[:, ~d.columns.duplicated()]

    df, vol = tidy(frames), tidy(vframes)
    if BENCH not in df or df[BENCH].dropna().empty:
        raise SystemExit("earnings_test: no SPY prices from Yahoo (rate-limited?) — nothing written")
    df = df[df[BENCH].notna()]  # SPY's trading calendar
    df = df[df.index <= pd.Timestamp(final)]
    if ohl is not None:
        for k, fs in extra.items():
            ohl[k] = tidy(fs).reindex(df.index)
    return df, vol.reindex(df.index)



def yahoo_actions(ticker: str) -> list[dict]:
    import yfinance as yf

    try:
        return actions_from_yahoo(yf.Ticker(ticker).upgrades_downgrades)
    except Exception as e:  # noqa: BLE001 — some tickers have no analyst coverage
        print(f"  {ticker}: no analyst actions ({str(e)[:80]})", flush=True)
        return []


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


def apply_measure(row: dict, closes: pd.DataFrame, now: datetime, volumes: pd.DataFrame | None = None,
                  buys: dict[str, list[dict]] | None = None, ohl: dict | None = None,
                  acts: dict[str, list[dict]] | None = None) -> dict:
    """Measure a row that has a report (+ its pre-report context); set source 'late' if a live row
    was logged too late."""
    m = measure(closes, row["ticker"], _d(row["report_date"]), row["session"])
    ctx = context(closes, volumes, row["ticker"], _d(row["report_date"]), row["session"],
                  None if buys is None else buys.get(row["ticker"], []), ohl=ohl,
                  acts=None if acts is None else acts.get(row["ticker"], []))
    row = {**row, **m, **ctx, "measured_at": now}
    if row["source"] == "live" and m.get("reaction_date"):
        reg = row["registered_at"]
        reg = reg if isinstance(reg, datetime) else datetime.fromisoformat(str(reg))
        if not registered_in_time(reg, m["reaction_date"]):
            row["source"] = "late"
    return row


def norm_ticker(t: str | None) -> str | None:
    """Form 4 writes BRK.B; Yahoo writes BRK-B."""
    return t.strip().upper().replace(".", "-") if t else None


def _add_buy(out: dict[str, list[dict]], seen: set, ticker, acc, who, filed, td, shares, usd) -> None:
    t = norm_ticker(ticker)
    key = (acc, who, str(td), round(float(shares or 0), 4))
    if not t or key in seen:
        return
    seen.add(key)
    out.setdefault(t, []).append({"who": who, "filed": str(filed)[:10], "usd": float(usd or 0)})


def insider_buys_db(sb, tickers: list[str], since: date) -> dict[str, list[dict]]:
    """Open-market buys from Neon's insider_transactions (kept current by the daily Form 4 job)."""
    out: dict[str, list[dict]] = {}
    seen: set = set()
    forms = sorted({t.replace("-", ".") for t in tickers} | set(tickers))
    for i in range(0, len(forms), 100):
        offset = 0
        while True:
            page = (sb.table("insider_transactions")
                    .select("accession_number,issuer_ticker,reporter_cik,transaction_date,filed_at,shares,value_usd")
                    .in_("issuer_ticker", forms[i:i + 100]).eq("transaction_code", "P")
                    .gte("filed_at", str(since)).order("id").range(offset, offset + 999).execute().data)
            for b in page:
                _add_buy(out, seen, b["issuer_ticker"], b["accession_number"], b["reporter_cik"],
                         b["filed_at"], b["transaction_date"], b["shares"], b["value_usd"])
            if len(page) < 1000:
                break
            offset += 1000
    out["_seen"] = seen  # type: ignore[assignment]  — lets the bulk loader skip duplicates
    return out


def insider_buys_bulk(out: dict[str, list[dict]], tickers: set[str], since: date, until: date) -> list[str]:
    """Add SEC's quarterly Form 345 bulk files (read locally, never written to Neon's tables).
    Returns the quarters it could not download."""
    from ingest.form4_universe_bulk import download, parse_quarter

    seen = out.pop("_seen", set())  # type: ignore[arg-type]
    missing = []
    y, q = since.year, (since.month - 1) // 3 + 1
    while (y, q) <= (until.year, (until.month - 1) // 3 + 1):
        z = download(f"{y}q{q}")
        if z is None:
            missing.append(f"{y}q{q}")
        else:
            for b in parse_quarter(z):
                if norm_ticker(b["issuer_ticker"]) in tickers:
                    _add_buy(out, seen, b["issuer_ticker"], b["accession_number"], b["reporter_cik"],
                             b["filed_at"], b["transaction_date"], b["shares"], b["value_usd"])
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)
    return missing


def enrich(sb, dry_run: bool) -> list[dict]:
    """Add pre-report context (volume, moving averages, insider buys) to every measured row."""
    now = now_et()
    rows = [r for r in fetch_all(sb, "earnings_test_events", "*", status=["reacted", "complete"])
            if r.get("report_date")]
    tickers = sorted({r["ticker"] for r in rows})
    first = min(_d(r["report_date"]) for r in rows)
    print(f"enrich: {len(rows)} rows, {len(tickers)} tickers, reports from {first}", flush=True)
    ohl: dict = {}
    closes, volumes = fetch_prices(tickers, first - timedelta(days=PRICE_LOOKBACK_DAYS), last_final_close(now), ohl)
    acts: dict[str, list[dict]] = {}
    for i, t in enumerate(tickers):
        acts[t] = yahoo_actions(t)
        if i % 100 == 0:
            print(f"  analyst actions [{i:>4}/{len(tickers)}]", flush=True)
        time.sleep(PACE_S)
    since = first - timedelta(days=INSIDER_DAYS)
    buys = insider_buys_db(sb, tickers, since)
    missing = insider_buys_bulk(buys, set(tickers), since, now.date())
    print(f"insider buys loaded for {len(buys)} tickers; bulk quarters not available: {missing}", flush=True)
    caps = {t["ticker"]: float(t["market_cap_usd"]) for t in
            fetch_all(sb, "tickers", "ticker,market_cap_usd", order=("ticker",)) if t.get("market_cap_usd")}
    out = []
    for r in rows:
        ctx = context(closes, volumes, r["ticker"], _d(r["report_date"]), r["session"], buys.get(r["ticker"], []),
                      caps.get(r["ticker"]), ohl, acts.get(r["ticker"], []))
        sample = r.get("sample") or ("top300" if r["source"] == "backtest" else None)
        out.append({**r, **ctx, "sample": sample})
    if not dry_run:
        upsert(sb, out)
    return out


def plan_sample(universe: list[dict], done: set[str], spec: dict[str, int | None], seed: int = SAMPLE_SEED) -> dict[str, str]:
    """{ticker: sample label}: per size tier, `n` stocks drawn at random (None = all) from operating
    companies (Yahoo sector known) not already in the backtest."""
    import random

    rng = random.Random(seed)
    out: dict[str, str] = {}
    for tier, n in spec.items():
        lo, hi = TIERS[tier]
        pool = sorted(u["ticker"] for u in universe
                      if u.get("sector") and u.get("market_cap_usd") and lo <= float(u["market_cap_usd"]) < hi
                      and u["ticker"] not in done)
        pick = pool if n is None or n >= len(pool) else rng.sample(pool, n)
        label = f"{tier}_all" if n is None else f"random_{tier}"
        out.update({t: label for t in pick})
    return out


def backfill(sb, limit: int | None, dry_run: bool, sample: dict[str, int | None] | None = None) -> list[dict]:
    """History since BACKTEST_START: the BACKTEST_TICKERS largest stocks in earnings_calendar, or with
    `sample`, random stocks per size tier from `tickers`."""
    now = now_et()
    cal = fetch_all(sb, "earnings_calendar", "ticker,next_earnings,market_cap_usd", order=("ticker",))
    universe = sorted((c for c in cal if c.get("next_earnings")),
                      key=lambda c: -(c.get("market_cap_usd") or 0))
    done: set[str] = set()
    if not dry_run:
        done = {r["ticker"] for r in fetch_all(sb, "earnings_test_events", "ticker,scheduled_date",
                                               source="backtest")}
    if sample:
        uni = fetch_all(sb, "tickers", "ticker,market_cap_usd,sector", order=("ticker",))
        labels = plan_sample(uni, done, sample)
    else:
        labels = {t: "top300" for t in [c["ticker"] for c in universe][:BACKTEST_TICKERS]}
    tickers = [t for t in labels if t not in done][:limit]
    print(f"backfill: {len(tickers)} tickers ({len(done)} already done)", flush=True)

    events: list[dict] = []
    for i, t in enumerate(tickers):
        for rep in yahoo_reports(t, now):
            if BACKTEST_START <= rep["report_date"] < LIVE_FROM:
                events.append({"ticker": t, "scheduled_date": rep["report_date"], "source": "backtest",
                               "status": "reported", "registered_at": now, "sample": labels[t], **rep})
        if i % 100 == 0:
            print(f"  [{i:>4}/{len(tickers)}] events so far {len(events)}", flush=True)
        time.sleep(PACE_S)

    closes, volumes = fetch_prices(tickers, BACKTEST_START - timedelta(days=PRICE_LOOKBACK_DAYS),
                                   last_final_close(now))
    sectors = sector_map(sb)
    for e in events:
        e["sector"] = sectors.get(e["ticker"])
    rows = [apply_measure(e, closes, now, volumes) for e in events]  # insider buys: run --enrich after
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
        first = min(_d(r["report_date"]) for r in to_measure)
        start = first - timedelta(days=60)
        tickers = sorted({r["ticker"] for r in to_measure})
        ohl: dict = {}
        closes, volumes = fetch_prices(tickers, first - timedelta(days=PRICE_LOOKBACK_DAYS), last_final_close(now), ohl)
        buys = insider_buys_db(sb, tickers, first - timedelta(days=INSIDER_DAYS))
        buys.pop("_seen", None)
        acts = {}
        for t in tickers:
            acts[t] = yahoo_actions(t)
            time.sleep(PACE_S)
        # Re-measured daily until complete: the post-report part of the path grows each day.
        updates += [apply_measure(r, closes, now, volumes, buys, ohl, acts) for r in to_measure]
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
    ap.add_argument("--sample", help="backfill: random stocks per size tier, e.g. small:300,mid:300,large:150,mega:all")
    ap.add_argument("--enrich", action="store_true",
                    help="one-off: add volume / moving-average / insider context to measured rows")
    args = ap.parse_args()

    from supabase import create_client

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    if args.enrich:
        rows = enrich(sb, args.dry_run)
        df = pd.DataFrame(rows)
        for c in ("insider_buyers", "ma50_gap", "ma200_gap", "vol_path", "analyst", "ohlc_path"):
            print(f"  {c}: {df[c].notna().sum() if c in df else 0} of {len(df)} rows filled")
        if args.dry_run and len(df):
            print("  rows with insider buyers > 0:", int((df.insider_buyers.fillna(0) > 0).sum()))
        return
    if args.backfill:
        spec = None
        if args.sample:
            spec = {k: (None if v == "all" else int(v)) for k, v in (x.split(":") for x in args.sample.split(","))}
        rows = backfill(sb, args.limit, args.dry_run, spec)
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
