"""Unit tests for ingest/scoring_rules.py — the v6 confluence formula (CLAUDE.md §6.4).

Inputs are hand-built rows shaped like the Supabase tables; no network.
"""
from datetime import date

import pytest

from ingest.scoring_rules import (
    classify_positions,
    compute_signals,
    insider_clusters,
    insider_score,
    is_stale,
)

AS_OF = date(2026, 10, 3)
CUTOFF = "2026-04-06"  # AS_OF - 180 days


@pytest.mark.parametrize("n,expected", [(0, 0.0), (1, 1.5), (2, 3.5), (3, 7.0), (5, 9.0)])
def test_insider_score_by_distinct_buyers(n, expected):
    assert insider_score(n) == expected


@pytest.mark.parametrize("tr,filer_latest,expected", [
    ([("2026-06-30", 100, "2026-08-14")], "2026-06-30", False),  # live: latest filing holds it
    ([("2026-03-31", 100, "2026-05-15")], "2026-06-30", True),   # exited: newer 13F without it
    ([("2026-03-31", 100, "2026-05-15")], "2026-03-31", True),   # older than the 180-day cutoff
    ([("2026-06-30", 100, "2026-08-14")], None, False),
])
def test_is_stale(tr, filer_latest, expected):
    assert is_stale(tr, filer_latest, CUTOFF) is expected


def _classify(traj, latest="2026-06-30"):
    universe = {"XYZ": {}}
    return classify_positions(traj, universe, {"A": 2.0}, {"A": latest}, CUTOFF)


def test_single_point_trajectory_is_new():
    new, add, vel, contrib = _classify({("A", "XYZ"): [("2026-06-30", 100, "2026-08-14")]})
    assert new["XYZ"] == [("A", 2.0)] and not add and not vel
    assert contrib["XYZ"] == {"2026-08-14"}


@pytest.mark.parametrize("prev,cur,is_add,velocity", [
    (100, 120, False, None),   # +20% is not an add (needs > 1.2x)
    (100, 121, True, None),
    (100, 200, True, 2.0),     # ≥ 2x is also velocity
    (100, 50, False, None),    # trims are not scored
])
def test_add_and_velocity_thresholds(prev, cur, is_add, velocity):
    traj = {("A", "XYZ"): [("2026-03-31", prev, "2026-05-15"), ("2026-06-30", cur, "2026-08-14")]}
    new, add, vel, _ = _classify(traj)
    assert not new
    assert bool(add.get("XYZ")) is is_add
    assert (vel["XYZ"][0][2] if vel.get("XYZ") else None) == velocity


def test_ticker_outside_universe_is_ignored():
    traj = {("A", "NOPE"): [("2026-06-30", 100, "2026-08-14")]}
    new, *_ = _classify(traj)
    assert not new


def test_insider_window_uses_trade_date_and_filed_date():
    rows = [
        {"issuer_ticker": "XYZ", "reporter_cik": "1", "transaction_date": "2026-09-20", "filed_at": "2026-09-22T00:00:00"},
        {"issuer_ticker": "XYZ", "reporter_cik": "1", "transaction_date": "2026-09-21", "filed_at": "2026-09-22T00:00:00"},
        {"issuer_ticker": "XYZ", "reporter_cik": "2", "transaction_date": "2026-08-01", "filed_at": "2026-08-03T00:00:00"},  # trade too old
        {"issuer_ticker": "XYZ", "reporter_cik": "3", "transaction_date": "2026-10-01", "filed_at": "2026-10-04T00:00:00"},  # filed after as-of
        {"issuer_ticker": None, "reporter_cik": "4", "transaction_date": "2026-09-20", "filed_at": "2026-09-22T00:00:00"},
    ]
    cluster, dates, meta = insider_clusters(rows, "2026-09-03", "2026-10-03")
    assert cluster["XYZ"] == {"1"}  # same insider twice counts once
    assert len(meta["XYZ"]) == 2


def _filing(fid, cik, period, filed, form="13F-HR"):
    return {"id": fid, "cik": cik, "form_type": form, "filed_at": filed + "T00:00:00", "period_of_report": period}


def test_compute_signals_end_to_end():
    filers = [{"name": "Fund A", "cik": "1", "multiplier": 1.0, "tier": "S"}]  # 1.0 × 1.5
    universe = [
        {"ticker": "BIG", "name": "Big Co", "market_cap_usd": 5e9},
        {"ticker": "TINY", "name": "Tiny Co", "market_cap_usd": 1e8},
    ]
    filings = [_filing("f1", "1", "2026-06-30", "2026-08-14")]
    holdings = [
        {"filing_id": "f1", "ticker": "BIG", "shares": 1000, "issuer_name": "BIG CO"},
        {"filing_id": "f1", "ticker": "TINY", "shares": 1000, "issuer_name": "TINY CO"},
    ]
    insiders = [
        {"issuer_ticker": "BIG", "reporter_cik": str(i), "reporter_name": f"Insider {i}",
         "transaction_date": "2026-09-20", "filed_at": "2026-09-22T00:00:00", "value_usd": 50_000}
        for i in range(3)
    ]
    out = compute_signals(AS_OF, filers, universe, filings, holdings, insiders, [])
    assert [s["ticker"] for s in out] == ["BIG"]  # TINY is under the $300M market-cap floor
    big = out[0]
    # 3 insiders → 7.0; new position by 1.5x filer → 3.0; 2 source types → no bonus
    assert big["score"] == 10.0
    assert big["components"]["insider_cluster"] == {"n": 3, "score": 7.0}
    assert big["components"]["thirteenf_new"] == {"n": 1, "score": 3.0}
    assert big["components"]["multi_source_bonus"]["applied"] is False
    assert big["contributing_filers"]["new"] == ["Fund A"]
    assert big["first_detected_at"] == "2026-08-14" and big["latest_signal_at"] == "2026-09-22"


def test_compute_signals_drops_scores_below_four():
    filers = [{"name": "Fund A", "cik": "1", "multiplier": 1.0, "tier": "C"}]  # 0.7 → new = 1.4
    universe = [{"ticker": "BIG", "name": "Big Co", "market_cap_usd": 5e9}]
    filings = [_filing("f1", "1", "2026-06-30", "2026-08-14")]
    holdings = [{"filing_id": "f1", "ticker": "BIG", "shares": 1000, "issuer_name": "BIG CO"}]
    assert compute_signals(AS_OF, filers, universe, filings, holdings, [], []) == []


def test_same_period_points_merge_when_a_quarter_has_two_filings():
    """Base filing + NEW HOLDINGS amendment for one quarter → one trajectory point."""
    from ingest.scoring_rules import build_trajectories

    f13f = {"A": [
        {"id": "q1", "period_of_report": "2026-03-31", "filed_at": "2026-05-15T00:00:00"},
        {"id": "base", "period_of_report": "2026-06-30", "filed_at": "2026-08-14T00:00:00"},
        {"id": "nh", "period_of_report": "2026-06-30", "filed_at": "2026-08-30T00:00:00"},
    ]}
    holdings = {"q1": {"XYZ": 100}, "base": {"XYZ": 150}, "nh": {"XYZ": 50, "NEW": 10}}
    traj = build_trajectories(f13f, holdings)
    assert traj[("A", "XYZ")] == [("2026-03-31", 100, "2026-05-15"), ("2026-06-30", 200, "2026-08-30")]
    assert traj[("A", "NEW")] == [("2026-06-30", 10, "2026-08-30")]
