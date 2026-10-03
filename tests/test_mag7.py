"""Mag7 sleeve logic on synthetic prices — no network, no database."""
from datetime import date

import pandas as pd
import pytest

from ingest import mag7
from ingest.mag7 import BENCHMARK, START_CAPITAL, TICKERS


def make_closes(growth: dict[str, float], start="2020-01-01", end="2021-06-30") -> pd.DataFrame:
    """Business-day closes where each ticker compounds at a fixed daily rate."""
    idx = pd.bdate_range(start, end)
    n = pd.Series(range(len(idx)), index=idx)
    return pd.DataFrame({t: 100 * (1 + growth.get(t, 0.0)) ** n for t in TICKERS + [BENCHMARK]})


def test_month_ends_excludes_current_month():
    closes = make_closes({}, end="2021-03-10")
    ends = mag7.month_ends(closes, date(2021, 3, 10))
    assert ends[-1] == pd.Timestamp("2021-02-26")  # last business day of Feb 2021
    assert all(d.month != 3 or d.year != 2021 for d in ends)


def test_signal_ranks_and_picks_laggard():
    closes = make_closes({"NVDA": 0.004, "MSFT": 0.002, "AAPL": 0.001, "TSLA": -0.002})
    ends = mag7.month_ends(closes, date(2021, 6, 30))
    assert mag7.compute_signal(closes, ends, 11) is None  # needs 12 months of history
    sig = mag7.compute_signal(closes, ends, 12)
    r = sig["ranks"]
    assert sig["selected"] == "TSLA"  # worst average rank
    assert r.loc["TSLA", ["rank_3m", "rank_6m", "rank_12m"]].tolist() == [7, 7, 7]
    assert r.loc["NVDA", ["rank_3m", "rank_6m", "rank_12m"]].tolist() == [1, 1, 1]
    assert r.loc["MSFT", "avg_rank"] == 2
    assert r.loc["NVDA", "ret_12m"] == pytest.approx(
        closes.loc[ends[12], "NVDA"] / closes.loc[ends[0], "NVDA"] - 1)


def test_tie_on_worst_average_rank_goes_to_lower_12m_return():
    closes = make_closes({t: 0.002 for t in TICKERS})  # everyone up, except the two we rig
    ends = mag7.month_ends(closes, date(2021, 6, 30))
    i = 12
    # Three-way tie at the bottom: ranks AAPL (7,6,5), META (6,5,7), MSFT (5,7,6) → all average 6.0.
    def set_ret(t, h, r):
        closes.loc[ends[i - h], t] = closes.loc[ends[i], t] / (1 + r)
    for t, (r3, r6, r12) in {"AAPL": (-0.30, -0.20, -0.10), "META": (-0.20, -0.10, -0.30),
                             "MSFT": (-0.10, -0.30, -0.20)}.items():
        set_ret(t, 3, r3); set_ret(t, 6, r6); set_ret(t, 12, r12)
    sig = mag7.compute_signal(closes, ends, i)
    assert sig["ranks"].loc[["AAPL", "META", "MSFT"], "avg_rank"].tolist() == [6.0, 6.0, 6.0]
    assert sig["selected"] == "META"  # lowest 12-month return of the tied three


def test_rebalance_initial_switch_hold_never_adds_capital():
    closes = make_closes({"NVDA": 0.003, "TSLA": 0.001})
    d1, d2, d3 = date(2020, 3, 2), date(2020, 4, 1), date(2020, 5, 1)

    pos, trades, action = mag7.rebalance(mag7.Position(), "NVDA", d1, date(2020, 2, 28), closes)
    assert action == "initial" and [t["side"] for t in trades] == ["buy"]
    assert trades[0]["amount"] == START_CAPITAL

    pos2, trades, action = mag7.rebalance(pos, "NVDA", d2, date(2020, 3, 31), closes)
    assert action == "hold" and trades == [] and pos2 is pos

    pos3, trades, action = mag7.rebalance(pos, "TSLA", d3, date(2020, 4, 30), closes)
    sell, buy = trades
    assert action == "switch" and (sell["side"], sell["ticker"]) == ("sell", "NVDA")
    grown = START_CAPITAL * closes.at[pd.Timestamp(d3), "NVDA"] / closes.at[pd.Timestamp(d1), "NVDA"]
    assert sell["amount"] == buy["amount"] == round(grown, 2)  # proceeds roll over, nothing added
    assert pos3.ticker == "TSLA" and pos3.amount == pytest.approx(grown)


def test_plan_run_never_rewrites_stored_rows():
    closes = make_closes({"NVDA": 0.003})
    today = date(2021, 6, 30)
    first = mag7.plan_run(closes, today, [], [], sleeve_start=date(2020, 1, 1))
    assert first.new_signals and all(s["source"] == "backtest" for s in first.new_signals)

    stored_signals = [{"signal_date": s["signal_date"], "selected": s["selected"],
                       "action": next(f["action"] for f in first.filled
                                      if f["signal_date"] == s["signal_date"])}
                      for s in first.new_signals]
    second = mag7.plan_run(closes, today, stored_signals, first.new_trades, sleeve_start=date(2020, 1, 1))
    assert second.new_signals == [] and second.new_trades == [] and second.filled == []
    assert [e["strategy"] for e in second.equity] == [e["strategy"] for e in first.equity]


def test_newcomer_ranked_on_what_it_has():
    closes = make_closes({t: 0.001 for t in TICKERS})
    closes["SPCX"] = 100 * 0.997 ** pd.Series(range(len(closes)), index=closes.index)  # falling
    closes.loc[closes.index < pd.Timestamp("2020-11-16"), "SPCX"] = float("nan")  # "IPO" mid-November
    ends = mag7.month_ends(closes, date(2021, 6, 30))

    before = mag7.compute_signal(closes, ends, 12)  # Jan 2021: no 3-month return yet
    assert "SPCX" not in before["ranks"].index and len(before["ranks"]) == 7

    sig = mag7.compute_signal(closes, ends, 13)  # Feb 2021: has 3-month only
    r = sig["ranks"]
    assert len(r) == 8 and r.loc["SPCX", "rank_3m"] == 8
    assert pd.isna(r.loc["SPCX", "rank_6m"]) and pd.isna(r.loc["SPCX", "rank_12m"])
    assert r.loc["SPCX", "avg_rank"] == 8  # average of the one rank it has
    assert sig["selected"] == "SPCX"


def test_pending_signal_waits_for_trade_day_close():
    closes = make_closes({"NVDA": 0.003}, end="2021-05-28")  # data stops on May's last day
    plan = mag7.plan_run(closes, date(2021, 6, 1), [], [], sleeve_start=date(2020, 1, 1))
    last = plan.new_signals[-1]
    assert last["signal_date"] == date(2021, 5, 28) and last["source"] == "live"
    assert all(f["signal_date"] != last["signal_date"] for f in plan.filled)


def test_sleeve_starts_at_first_trade_on_or_after_start_date():
    closes = make_closes({"NVDA": 0.003}, start="2019-01-01", end="2021-06-30")
    plan = mag7.plan_run(closes, date(2021, 6, 30), [], [], sleeve_start=date(2021, 1, 1))
    assert plan.new_signals[0]["signal_date"] == date(2020, 12, 31)  # trades 2021-01-01 (bdate) → kept
    first_buy = plan.new_trades[0]
    assert first_buy["side"] == "buy" and first_buy["trade_date"] >= date(2021, 1, 1)
    assert first_buy["amount"] == START_CAPITAL
    assert plan.equity[0]["date"] >= first_buy["trade_date"]
