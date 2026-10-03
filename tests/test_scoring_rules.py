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
    cluster, dates, meta, excluded = insider_clusters(rows, "2026-09-03", "2026-10-03")
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


# ─── Insider filters (eng review R7: all four on) ────────────────────────
from ingest.scoring_rules import insider_qualifies, stake_growth  # noqa: E402

FILTERS = {"officers_directors_only": True, "exclude_10b5_1": True,
           "min_value_usd": 25_000, "min_stake_growth_pct": 0.10}


def buy(**kw):
    base = {"reporter_cik": "1", "reporter_name": "Jane CEO", "reporter_is_officer": True,
            "reporter_is_director": False, "is_10b5_1": False, "shares": 1000, "value_usd": 50_000,
            "shares_owned_after": 5000, "direct_indirect": "D"}
    return {**base, **kw}


@pytest.mark.parametrize("rows,ok,reason", [
    ([buy()], True, None),                                                       # 1,000 on 4,000 held = +25%
    ([buy(reporter_is_officer=False, reporter_is_director=True)], True, None),   # director counts
    ([buy(reporter_is_officer=False)], False, "not_officer_or_director"),        # pure 10% holder / other
    ([buy(is_10b5_1=True)], False, "10b5_1_plan"),
    ([buy(is_10b5_1=None)], True, None),                                          # pre-2023: unknown never excludes
    ([buy(value_usd=20_000)], False, "below_min_value"),
    ([buy(value_usd=None)], True, None),                                          # missing price: unknown
    ([buy(shares=100, shares_owned_after=100_100)], False, "stake_growth_below_min"),  # +0.1%
    ([buy(shares_owned_after=None)], True, None),                                 # missing: unknown
    ([buy(shares_owned_after=1000)], True, None),                                 # first-ever purchase
    # Split buys are judged together: three $10k fills = one $30k buy.
    ([buy(value_usd=10_000, shares=300, shares_owned_after=4300),
      buy(value_usd=10_000, shares=300, shares_owned_after=4600),
      buy(value_usd=10_000, shares=300, shares_owned_after=4900)], True, None),
    # A plan buy is dropped before the value test; the $20k left is too small.
    ([buy(is_10b5_1=True, value_usd=40_000), buy(value_usd=20_000)], False, "below_min_value"),
])
def test_insider_qualifies(rows, ok, reason):
    got_ok, got_reason, counted = insider_qualifies(rows, FILTERS)
    assert (got_ok, got_reason) == (ok, reason)
    assert bool(counted) is ok


def test_filters_individually_switch_off():
    assert insider_qualifies([buy(reporter_is_officer=False)], {**FILTERS, "officers_directors_only": False})[0]
    assert insider_qualifies([buy(is_10b5_1=True)], {**FILTERS, "exclude_10b5_1": False})[0]
    assert insider_qualifies([buy(value_usd=1)], {**FILTERS, "min_value_usd": 0})[0]
    assert insider_qualifies([buy(shares=1, shares_owned_after=1_000_001)], {**FILTERS, "min_stake_growth_pct": None})[0]


def test_stake_growth_per_ownership_line():
    # 1,000 bought directly (4,000 held before) + 500 via trust (500 held before): 1,500 / 4,500
    rows = [buy(shares=1000, shares_owned_after=5000, direct_indirect="D"),
            buy(shares=500, shares_owned_after=1000, direct_indirect="I")]
    assert stake_growth(rows) == pytest.approx(1500 / 4500)


def test_cluster_counts_only_qualifying_and_lists_exclusions():
    def row(cik, name, **kw):
        return {"issuer_ticker": "XYZ", "transaction_date": "2026-09-20", "filed_at": "2026-09-22T00:00:00",
                **buy(reporter_cik=cik, reporter_name=name, **kw)}
    rows = [row("1", "Ann CFO"), row("2", "Big Fund", reporter_is_officer=False),
            row("3", "Bob COO", is_10b5_1=True), row("4", "Cy Director", reporter_is_officer=False, reporter_is_director=True)]
    cluster, dates, meta, excluded = insider_clusters(rows, "2026-09-03", "2026-10-03", FILTERS)
    assert cluster["XYZ"] == {"1", "4"}
    assert [m["name"] for m in meta["XYZ"]] == ["Ann CFO", "Cy Director"]
    assert excluded["XYZ"] == [{"name": "Big Fund", "reason": "not_officer_or_director"},
                               {"name": "Bob COO", "reason": "10b5_1_plan"}]


def test_compute_signals_shows_excluded_insiders_in_components():
    filers = [{"name": "Fund A", "cik": "1", "multiplier": 1.0, "tier": "S"}]
    universe = [{"ticker": "BIG", "name": "Big Co", "market_cap_usd": 5e9}]
    filings = [_filing("f1", "1", "2026-06-30", "2026-08-14")]
    holdings = [{"filing_id": "f1", "ticker": "BIG", "shares": 1000, "issuer_name": "BIG CO"}]
    insiders = [{"issuer_ticker": "BIG", "transaction_date": "2026-09-20", "filed_at": "2026-09-22T00:00:00",
                 **buy(reporter_cik=str(i), reporter_name=f"Insider {i}", is_10b5_1=(i == 2))} for i in range(3)]
    big = compute_signals(AS_OF, filers, universe, filings, holdings, insiders, [], FILTERS)[0]
    assert big["components"]["insider_cluster"] == {
        "n": 2, "score": 3.5, "excluded": [{"name": "Insider 2", "reason": "10b5_1_plan"}]}
    assert big["contributing_filers"]["insider_buyers"] == ["Insider 0", "Insider 1"]
