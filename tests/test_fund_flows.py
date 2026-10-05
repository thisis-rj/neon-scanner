"""Unit tests for the fund-flow rules in ingest/scoring_rules.py (the /funds page).

Hand-built rows shaped like holdings_13f_effective; no network.
"""
from datetime import date

import pytest

from ingest.scoring_rules import (
    classify_change,
    cusip_fallback_tickers,
    fund_position_changes,
    name_ticker_map,
    reporting_quarter,
    split_factor,
    stock_signal_extras,
)

AS_OF = date(2026, 10, 3)
FILERS = [
    {"cik": "1", "name": "Fund One", "tier": "S", "category": "value"},
    {"cik": "2", "name": "Fund Two", "tier": "B", "category": "growth"},
    {"cik": "3", "name": "Fund Three", "tier": "C", "category": "activist"},
]
UNIVERSE = [{"ticker": "AAA", "name": "Alpha Corp"}, {"ticker": "BBB", "name": "Beta Inc"}]


def h(cik, period, ticker, shares, value=None, cusip=None, issuer=None):
    return {"cik": cik, "period_of_report": period, "ticker": ticker, "cusip": cusip,
            "issuer_name": issuer or ticker, "shares": shares,
            "value_usd": value if value is not None else shares}


def changes(rows, cusip_map=None, splits=None, as_of=AS_OF):
    return fund_position_changes(as_of, FILERS, rows, cusip_map or {}, UNIVERSE, splits or {})


def events(out_rows, lag=1, rank=0):
    return {(r["cik"][-1], r["ticker"]): r["event"] for r in out_rows if r["lag_quarters"] == lag and r["pair_rank"] == rank}


@pytest.mark.parametrize("as_of,expected", [
    (date(2026, 10, 3), date(2026, 6, 30)),
    (date(2026, 11, 14), date(2026, 6, 30)),   # deadline day itself: Q3 not yet due
    (date(2026, 11, 15), date(2026, 9, 30)),
    (date(2026, 2, 15), date(2025, 12, 31)),
    (date(2026, 2, 14), date(2025, 9, 30)),
])
def test_reporting_quarter(as_of, expected):
    assert reporting_quarter(as_of) == expected


@pytest.mark.parametrize("prev,cur,factor,expected", [
    (0, 100, 1, "opened"),
    (None, 100, 1, "opened"),
    (100, 0, 1, "exited"),
    (100, None, 1, "exited"),
    (None, None, 1, None),
    (100, 110, 1, "added"),     # exactly +10%
    (100, 109.9, 1, None),      # +9.9% is held
    (100, 90, 1, "trimmed"),    # exactly −10% despite 0.9 − 1 = −0.0999…98
    (100, 90.1, 1, None),
    (100, 200, 2.0, None),      # 2-for-1 split, no trade
    (1000, 100, 0.1, None),     # 1-for-10 reverse split, no trade
    (100, 260, 2.0, "added"),   # split plus a 30% buy
    (100, 150, 2.0, "trimmed"), # split, then sold a quarter of the position
])
def test_classify_change(prev, cur, factor, expected):
    assert classify_change(prev, cur, factor) == expected


def test_split_factor_counts_splits_after_prev_up_to_cur():
    splits = [("2026-03-31", 3.0), ("2026-05-01", 2.0), ("2026-06-30", 0.5), ("2026-07-01", 10.0)]
    assert split_factor(splits, "2026-03-31", "2026-06-30") == 1.0  # 2.0 × 0.5; 3/31 and 7/1 excluded
    assert split_factor([], "2026-03-31", "2026-06-30") == 1.0
    assert split_factor(None, "2026-03-31", "2026-06-30") == 1.0


def test_basic_events_and_held_not_stored():
    rows = [
        h("1", "2026-03-31", "AAA", 100), h("1", "2026-03-31", "BBB", 100), h("1", "2026-03-31", "CCC", 100),
        h("1", "2026-06-30", "AAA", 150), h("1", "2026-06-30", "BBB", 50), h("1", "2026-06-30", "DDD", 10),
        h("1", "2026-06-30", "CCC", 105),
    ]
    out, stats = changes(rows)
    assert events(out) == {("1", "AAA"): "added", ("1", "BBB"): "trimmed", ("1", "DDD"): "opened"}
    assert stats["counted"] == [("Fund One", "2026-06-30")]


def test_exit_is_recorded_on_earlier_filing_value():
    rows = [h("1", "2026-03-31", "AAA", 100, value=400), h("1", "2026-03-31", "BBB", 100, value=600),
            h("1", "2026-06-30", "BBB", 100, value=500)]
    out, _ = changes(rows)
    (exit_row,) = [r for r in out if r["event"] == "exited"]
    assert exit_row["ticker"] == "AAA" and exit_row["shares_cur"] is None
    assert exit_row["value_usd"] == 400 and exit_row["pct_of_fund"] == pytest.approx(0.4)


def test_fund_with_one_filing_has_no_baseline():
    out, stats = changes([h("1", "2026-06-30", "AAA", 100), h("1", "2026-06-30", "BBB", 100)])
    assert out == []
    assert stats["no_baseline"] == [("Fund One", "2026-06-30")]


def test_fund_that_stopped_filing_is_left_out():
    # Reporting quarter on 2026-10-03 is Q2; previous is Q1 → a fund last seen in Q4 2025 stopped.
    rows = [h("2", "2025-09-30", "AAA", 100), h("2", "2025-12-31", "AAA", 300),
            h("1", "2026-03-31", "AAA", 100), h("1", "2026-06-30", "AAA", 300)]
    out, stats = changes(rows)
    assert {r["cik"] for r in out} == {"0000000001"}
    assert stats["stopped_filing"] == [("Fund Two", "2025-12-31")]


def test_fund_one_quarter_late_still_counts():
    rows = [h("2", "2025-12-31", "AAA", 100), h("2", "2026-03-31", "AAA", 300)]
    out, _ = changes(rows)
    assert events(out) == {("2", "AAA"): "added"}


def test_early_filer_and_on_time_filer_each_use_their_own_latest_pair():
    rows = [h("1", "2026-06-30", "AAA", 100), h("1", "2026-09-30", "AAA", 200),   # early Q3 filer
            h("2", "2026-03-31", "AAA", 100), h("2", "2026-06-30", "AAA", 200)]   # Q2 filer
    out, _ = changes(rows)
    latest = {r["cik"][-1]: (r["prev_period"], r["period"]) for r in out if r["lag_quarters"] == 1 and r["pair_rank"] == 0}
    assert latest == {"1": ("2026-06-30", "2026-09-30"), "2": ("2026-03-31", "2026-06-30")}


def test_today_cusip_map_beats_stored_ticker_so_quarters_match():
    # Q1 row was stored before OpenFIGI resolution (ticker None); Q2 row has the ticker.
    rows = [h("1", "2026-03-31", None, 100, cusip="111", issuer="ALPHA CORP CL A"),
            h("1", "2026-06-30", "AAA", 100, cusip="111")]
    out, _ = changes(rows, cusip_map={"111": "AAA"})
    assert out == []  # held, not exit + open


def test_issuer_name_fallback_when_no_cusip_match():
    rows = [h("1", "2026-03-31", None, 100, issuer="ALPHA CORP"), h("1", "2026-06-30", "AAA", 100)]
    out, _ = changes(rows)
    assert out == []


def test_unmapped_cusip_keeps_its_ticker_when_one_quarter_spells_the_issuer_differently():
    # Berkshire / Chubb: same CUSIP and shares every quarter, but Q1-2026 wrote
    # "CHUBB LTD SWITZ", which matches no ticker name. Was: exit, then re-open.
    rows = [h("1", "2025-12-31", None, 100, cusip="H1467J104", issuer="ALPHA LIMITED"),
            h("1", "2026-03-31", None, 100, cusip="H1467J104", issuer="ALPHA LTD SWITZ"),
            h("1", "2026-06-30", None, 100, cusip="H1467J104", issuer="ALPHA LIMITED")]
    out, _ = changes(rows)
    assert out == []


def test_lowercase_cusip_matches_the_upper_case_map_entry():
    # Akre files KKR as 48251w104; the map has 48251W104 → KKR (and a dead lower-case row).
    rows = [h("1", "2026-03-31", None, 100, cusip="48251w104", issuer="KKR & CO L P DEL"),
            h("1", "2026-06-30", None, 50, cusip="48251w104", issuer="KKR & CO L P DEL")]
    out, _ = changes(rows, cusip_map={"48251W104": "AAA", "48251w104": None})
    assert events(out) == {("1", "AAA"): "trimmed"}


def test_shared_name_picks_mapped_then_shortest_ticker():
    universe = [{"ticker": "KKRT", "name": "KKR & Co. Inc."}, {"ticker": "KKR", "name": "KKR & Co. Inc."},
                {"ticker": "AAC-WT", "name": "Ares Acquisition"}, {"ticker": "AAC", "name": "Ares Acquisition"},
                {"ticker": "ZZ", "name": "Zed Corp"}, {"ticker": "ZZZ", "name": "Zed Corp"}]
    names = name_ticker_map(universe, preferred={"ZZZ"})
    assert names == {"KKR": "KKR", "ARES ACQUISITION": "AAC", "ZED": "ZZZ"}


def test_cusip_fallback_votes_by_row_count_then_ticker():
    rows = [h("1", "2026-03-31", None, 1, cusip="X1", issuer="ALPHA CORP"),
            h("2", "2026-03-31", None, 1, cusip="X1", issuer="ALPHA CORP"),
            h("3", "2026-03-31", None, 1, cusip="X1", issuer="BETA INC"),
            h("1", "2026-03-31", None, 1, cusip="X2", issuer="BETA INC"),
            h("2", "2026-03-31", None, 1, cusip="X2", issuer="ALPHA CORP"),
            h("1", "2026-03-31", None, 1, cusip="X3", issuer="ALPHA CORP")]
    names = {"ALPHA": "AAA", "BETA": "BBB"}
    fb = cusip_fallback_tickers(rows, {"X3": "ZZZ"}, names)
    assert fb == {"X1": "AAA", "X2": "AAA"}  # X2 tie → alphabetical; mapped X3 not voted


def test_split_between_filings_is_not_an_add():
    rows = [h("1", "2026-03-31", "AAA", 100), h("1", "2026-06-30", "AAA", 200)]
    out, _ = changes(rows, splits={"AAA": [("2026-05-15", 2.0)]})
    assert out == []
    out, _ = changes(rows)  # without the split record it would look like a doubling
    assert events(out) == {("1", "AAA"): "added"}


def test_share_class_slash_becomes_dash_so_splits_and_prices_join():
    # OpenFIGI maps Berkshire B to "BRK/B"; tickers and stock_splits use "BRK-B".
    rows = [h("1", "2026-03-31", None, 100, cusip="084670702"), h("1", "2026-06-30", None, 200, cusip="084670702")]
    out, _ = changes(rows, cusip_map={"084670702": "BRK/B"}, splits={"BRK-B": [("2026-05-15", 2.0)]})
    assert out == []  # the split is found under the dash spelling
    out, _ = changes(rows, cusip_map={"084670702": "BRK/B"})
    assert events(out) == {("1", "BRK-B"): "added"}


def test_rows_for_one_ticker_in_one_quarter_are_summed():
    # Base filing + NEW HOLDINGS amendment, or two CUSIPs for one company.
    rows = [h("1", "2026-03-31", "AAA", 100),
            h("1", "2026-06-30", "AAA", 60), h("1", "2026-06-30", "AAA", 60)]
    out, _ = changes(rows)
    assert events(out) == {("1", "AAA"): "added"}
    assert out[0]["shares_cur"] == 120


def test_ranks_walk_back_through_history_and_lag2_compares_two_filings_back():
    rows = [h("1", "2025-12-31", "AAA", 100), h("1", "2026-03-31", "AAA", 150), h("1", "2026-06-30", "AAA", 140)]
    out, _ = changes(rows)
    assert events(out, lag=1, rank=0) == {}                       # 150 → 140 is −6.7%: held
    assert events(out, lag=1, rank=1) == {("1", "AAA"): "added"}  # 100 → 150
    assert events(out, lag=2, rank=0) == {("1", "AAA"): "added"}  # 100 → 140
    assert not [r for r in out if r["lag_quarters"] == 2 and r["pair_rank"] != 0]


def test_conviction_is_share_of_fund_book_and_handles_empty_book():
    rows = [h("1", "2026-03-31", "BBB", 10, value=100),
            h("1", "2026-06-30", "AAA", 10, value=250), h("1", "2026-06-30", "BBB", 10, value=750)]
    out, _ = changes(rows)
    (opened,) = [r for r in out if r["event"] == "opened"]
    assert opened["pct_of_fund"] == pytest.approx(0.25)
    zero = [h("1", "2026-03-31", "BBB", 10, value=0), h("1", "2026-06-30", "AAA", 10, value=0)]
    out, _ = changes(zero)
    assert all(r["pct_of_fund"] is None for r in out)


def test_rows_carry_fund_tier_and_category_and_untracked_funds_are_ignored():
    rows = [h("1", "2026-03-31", "AAA", 1), h("1", "2026-06-30", "BBB", 1),
            h("99", "2026-03-31", "AAA", 1), h("99", "2026-06-30", "BBB", 1)]
    out, stats = changes(rows)
    assert {(r["tier"], r["category"], r["tier_mult"], r["filer_name"]) for r in out} == {("S", "value", 1.5, "Fund One")}
    assert stats["untracked"] == 1


def test_stock_signal_extras_reuses_insider_and_activist_rules():
    insiders = [
        {"issuer_ticker": "AAA", "reporter_cik": "a", "reporter_name": "Ann", "transaction_date": "2026-09-20", "filed_at": "2026-09-22"},
        {"issuer_ticker": "AAA", "reporter_cik": "b", "reporter_name": "Bob", "transaction_date": "2026-09-21", "filed_at": "2026-09-22"},
        {"issuer_ticker": "AAA", "reporter_cik": "a", "reporter_name": "Ann", "transaction_date": "2026-09-25", "filed_at": "2026-09-26"},
        {"issuer_ticker": "BBB", "reporter_cik": "c", "reporter_name": "Cy", "transaction_date": "2026-06-01", "filed_at": "2026-06-02"},  # too old
    ]
    filings = [{"id": "f1", "filed_at": "2026-09-01T00:00:00"}, {"id": "f2", "filed_at": "2026-01-01T00:00:00"}]
    e13d = [{"ticker": "BBB", "cik": "3", "form_subtype": "SCHEDULE 13D", "filing_id": "f1", "issuer_name": "Beta"},
            {"ticker": "AAA", "cik": "3", "form_subtype": "SCHEDULE 13D", "filing_id": "f2", "issuer_name": "Alpha"}]  # too old
    out = {r["ticker"]: r for r in stock_signal_extras(AS_OF, FILERS, filings, insiders, e13d, UNIVERSE)}
    assert out["AAA"]["insider_buyers"] == 2 and out["AAA"]["insider_names"] == ["Ann", "Bob"]
    assert out["AAA"]["activist_filers"] == []
    assert out["BBB"]["insider_buyers"] == 0
    assert out["BBB"]["activist_filers"] == ["Fund Three"] and out["BBB"]["activist_latest"] == "2026-09-01"
