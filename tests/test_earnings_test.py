"""Earnings-test logic on synthetic prices — no network, no database."""
from datetime import date, datetime, timedelta, timezone

import pandas as pd
import pytest

from ingest import earnings_test as et
from ingest.earnings_test import BENCH, ET


def ts(s: str) -> pd.Timestamp:
    return pd.Timestamp(s, tz=ET)


def make_closes(start="2024-01-01", end="2024-04-30", **paths) -> pd.DataFrame:
    """Business-day closes; SPY flat at 100 unless given. paths: ticker → callable(i) → close."""
    idx = pd.bdate_range(start, end)
    cols = {BENCH: [100.0] * len(idx)}
    for t, f in paths.items():
        cols[t] = [f(i) for i in range(len(idx))]
    return pd.DataFrame(cols, index=idx)


def test_classify_session():
    assert et.classify_session(ts("2026-07-14 06:00")) == "bmo"
    assert et.classify_session(ts("2026-07-14 09:29")) == "bmo"
    assert et.classify_session(ts("2026-07-14 09:30")) == "intraday"
    assert et.classify_session(ts("2026-07-14 16:00")) == "amc"
    assert et.classify_session(ts("2026-07-14 00:00")) == "unknown"
    # a UTC timestamp is judged in New York time: 20:05 UTC = 16:05 EDT
    assert et.classify_session(pd.Timestamp("2026-07-14 20:05", tz="UTC")) == "amc"


def test_reaction_day_by_session():
    cal = pd.bdate_range("2024-03-01", "2024-03-15")
    wed, thu = date(2024, 3, 6), pd.Timestamp("2024-03-07")
    assert cal[et.reaction_index(cal, wed, "bmo")] == pd.Timestamp(wed)
    assert cal[et.reaction_index(cal, wed, "intraday")] == pd.Timestamp(wed)
    assert cal[et.reaction_index(cal, wed, "amc")] == thu
    # after-close Friday → Monday; a weekend report → Monday
    assert cal[et.reaction_index(cal, date(2024, 3, 8), "amc")] == pd.Timestamp("2024-03-11")
    assert cal[et.reaction_index(cal, date(2024, 3, 9), "bmo")] == pd.Timestamp("2024-03-11")
    assert et.reaction_index(cal, date(2024, 3, 15), "amc") is None  # not traded yet


def test_measure_windows_and_excess():
    # Stock: +1 per day from 100. SPY: +0.5 per day from 100.
    closes = make_closes(X=lambda i: 100 + i)
    closes[BENCH] = [100 + 0.5 * i for i in range(len(closes))]
    report = closes.index[30].date()  # before the open → R = index 30
    m = et.measure(closes, "X", report, "bmo")
    assert m["status"] == "complete"
    assert m["reaction_date"] == report
    assert m["pre_start"] == closes.index[19].date()             # R-1-10
    assert m["pre_ret"] == pytest.approx(129 / 119 - 1)          # close[R-1] / close[R-11]
    assert m["pre_spy"] == pytest.approx(114.5 / 109.5 - 1)
    assert m["pre_excess"] == pytest.approx(m["pre_ret"] - m["pre_spy"])
    assert m["react_ret"] == pytest.approx(130 / 129 - 1)
    assert m["drift_end"] == closes.index[50].date()             # R+20
    assert m["drift_ret"] == pytest.approx(150 / 130 - 1)
    assert m["drift_excess"] == pytest.approx(m["drift_ret"] - (125 / 115 - 1))


def test_measure_after_close_uses_next_day_and_waits_for_drift():
    closes = make_closes(X=lambda i: 100 + i)
    report = closes.index[-5].date()
    m = et.measure(closes, "X", report, "amc")
    assert m["reaction_date"] == closes.index[-4].date()
    assert m["status"] == "reacted" and "drift_ret" not in m
    assert et.measure(closes, "X", closes.index[-1].date(), "amc") == {"status": "reported"}


def test_measure_exclusions():
    closes = make_closes(X=lambda i: 100 + i)
    assert et.measure(closes, "X", closes.index[5].date(), "bmo")["status"] == "excluded"   # < 10 days of history
    assert et.measure(closes, "X", closes.index[30].date(), "unknown")["status"] == "excluded"
    assert et.measure(closes, "Y", closes.index[30].date(), "bmo")["note"] == "no prices"
    closes.loc[closes.index[29], "X"] = float("nan")
    assert et.measure(closes, "X", closes.index[30].date(), "bmo")["status"] == "excluded"


def test_registered_in_time():
    reaction = date(2026, 10, 15)
    open_utc = datetime(2026, 10, 15, 13, 30, tzinfo=timezone.utc)  # 9:30 EDT
    assert et.registered_in_time(open_utc - timedelta(minutes=1), reaction)
    assert not et.registered_in_time(open_utc, reaction)


def test_plan_registrations_window_and_dedupe():
    today = max(et.LIVE_FROM, date(2026, 10, 7))
    cal = [
        {"ticker": "AAA", "next_earnings": str(today + timedelta(days=3))},
        {"ticker": "BBB", "next_earnings": str(today + timedelta(days=8))},   # too far ahead
        {"ticker": "CCC", "next_earnings": str(today - timedelta(days=1))},   # already passed
        {"ticker": "DDD", "next_earnings": str(today + timedelta(days=2))},   # date moved: logged at +0
        {"ticker": "EEE", "next_earnings": None},
    ]
    existing = [{"ticker": "DDD", "scheduled_date": str(today)}]
    new = et.plan_registrations(cal, existing, today)
    assert [r["ticker"] for r in new] == ["AAA"]
    assert new[0]["source"] == "live" and new[0]["status"] == "scheduled"


def test_reports_from_yahoo_dedupes_and_drops_future():
    idx = pd.DatetimeIndex([ts("2026-07-14 06:00"), ts("2026-07-14 06:00"), ts("2026-07-16 07:00"),
                            ts("2026-04-14 06:00"), ts("2026-10-13 08:00")], name="Earnings Date")
    df = pd.DataFrame({"EPS Estimate": [5.8, 5.8, 5.8, 5.5, 5.9], "Reported EPS": [6.1, 6.1, 6.1, 5.9, None],
                       "Surprise(%)": [5.9, 5.9, 5.9, 7.8, None]}, index=idx)
    reps = et.reports_from_yahoo(df, datetime(2026, 10, 6, tzinfo=ET))
    assert [r["report_date"] for r in reps] == [date(2026, 4, 14), date(2026, 7, 14)]
    assert reps[1]["session"] == "bmo" and reps[1]["eps_actual"] == 6.1


def test_match_report_nearest_within_window():
    reps = [{"report_date": date(2026, 7, 14)}, {"report_date": date(2026, 10, 20)}]
    assert et.match_report(reps, date(2026, 10, 15))["report_date"] == date(2026, 10, 20)
    assert et.match_report(reps, date(2026, 9, 1)) is None


def _season_rows(season_start: str, n: int, react_of_pre) -> list[dict]:
    d = pd.Timestamp(season_start)
    return [{"reaction_date": (d + pd.Timedelta(days=i % 60)).date(), "pre_excess": (i - n / 2) / n,
             "react_excess": react_of_pre((i - n / 2) / n), "drift_excess": None} for i in range(n)]


def test_score_detects_reversal_and_skips_small_seasons():
    rows = (_season_rows("2024-01-01", 100, lambda p: -0.1 * p)
            + _season_rows("2024-04-01", 100, lambda p: -0.1 * p)
            + _season_rows("2024-07-01", 20, lambda p: 0.5 * p))   # too small: not scored
    s = et.score(pd.DataFrame(rows).astype({"pre_excess": float, "react_excess": float, "drift_excess": float}))
    assert s["events"] == 220
    assert [x["season"] for x in s["seasons"]] == ["2024Q1", "2024Q2", "2024Q3"]
    assert s["seasons"][2]["react_spread"] is None
    assert s["react_spread"]["seasons"] == 2 and s["react_spread"]["positive"] == 0
    assert s["react_spread"]["mean"] == pytest.approx(-0.1 * 0.8)   # Q5 mean pre 0.39, Q1 −0.41
    assert [q["q"] for q in s["quintiles"]] == [1, 2, 3, 4, 5]
    assert s["quintiles"][0]["react_excess"] > s["quintiles"][4]["react_excess"]
    assert s["spearman_react"] < -0.5
    assert s["drift_spread"]["seasons"] == 0


def test_score_empty():
    s = et.score(pd.DataFrame(columns=["reaction_date", "pre_excess", "react_excess", "drift_excess"]))
    assert s["events"] == 0 and s["quintiles"] == []


def test_daily_path_offsets_and_gaps():
    closes = make_closes(X=lambda i: 100 * 1.01 ** i)
    closes.loc[closes.index[45], "X"] = float("nan")
    r = 40
    m = et.measure(closes, "X", closes.index[r].date(), "bmo")
    p = m["path"]
    assert len(p) == 2 * et.PATH_DAYS + 1
    assert p[0] == 1000                       # day R-30: +1.000% in units of 0.001%
    assert p[et.PATH_DAYS + 5] is None        # day R+5 close missing
    assert p[et.PATH_DAYS + 6] is None        # ...so day R+6 has no previous close either
    early = et.measure(closes, "X", closes.index[15].date(), "bmo")["path"]
    assert early[:15] == [None] * 15          # before the first close (and day 0 has no previous)


def test_complete_needs_full_post_path():
    closes = make_closes(X=lambda i: 100 + i)
    n = len(closes)
    m = et.measure(closes, "X", closes.index[n - 25].date(), "bmo")   # R+20 exists, R+30 doesn't
    assert m["status"] == "reacted" and "drift_ret" in m


def test_spy_returns():
    closes = make_closes()
    closes[BENCH] = [100 * 1.001 ** i for i in range(len(closes))]
    rows = et.spy_returns(closes, closes.index[2].date())
    assert rows[0]["date"] == closes.index[2].date() and rows[0]["ret"] == pytest.approx(0.001)


def test_volume_path_relative_to_normal():
    closes = make_closes(end="2024-08-30", X=lambda i: 100.0)
    vol = pd.Series(1_000.0, index=closes.index)
    r = 120
    vol.iloc[r - 1] = 3_000.0                      # day R-1: 3x normal
    p = et.volume_path(vol, r)
    assert len(p) == et.PATH_DAYS and p[-1] == 300 and p[0] == 100
    assert et.volume_path(vol, 60) is None         # not enough history for the 60-day baseline


def test_ma_gap():
    closes = make_closes(end="2024-12-31", X=lambda i: 100 + i)
    r = 250
    s = closes["X"]
    assert et.ma_gap(s, r, 50) == pytest.approx(s.iloc[r - 1] / s.iloc[r - 50:r].mean() - 1)
    assert et.ma_gap(s, 100, 200) is None


def test_insider_counts_use_filing_date_window():
    rd = date(2024, 5, 1)
    buys = [
        {"who": "A", "filed": "2024-04-30", "usd": 100.0},
        {"who": "A", "filed": "2024-03-01", "usd": 50.0},     # same insider, counted once
        {"who": "B", "filed": "2024-02-01", "usd": 10.0},
        {"who": "C", "filed": "2024-01-15", "usd": 999.0},    # 107 days before: outside 90
        {"who": "D", "filed": "2024-05-01", "usd": 999.0},    # filed on report day: not before
    ]
    assert et.insider_counts(buys, rd) == (2, 160.0)


def test_norm_ticker():
    assert et.norm_ticker(" brk.b ") == "BRK-B"
