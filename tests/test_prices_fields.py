"""prices.py: industry/sector labels and stock splits for the /funds page. No network."""
import pandas as pd

from ingest.prices import has_fund_flow_schema, info_fields, splits_from_history, upsert_ticker


class FakeTable:
    def __init__(self, sb, name):
        self.sb, self.name = sb, name

    def upsert(self, row, on_conflict=None):
        self.sb.upserts.append((self.name, row))
        return self

    def select(self, *_):
        if self.name in self.sb.missing:
            raise RuntimeError(f'column "{self.name}" does not exist')
        return self

    def limit(self, *_):
        return self

    def execute(self):
        return self


class FakeSB:
    def __init__(self, missing=()):
        self.upserts, self.missing = [], set(missing)

    def table(self, name):
        return FakeTable(self, name)


STATS = {"price": 10.0, "market_cap_usd": 5e9, "avg_dollar_volume_20d": 1e7, "return_3mo": 0.1,
         "return_6mo": 0.2, "return_12mo": 0.3, "industry": "Semiconductors", "sector": "Technology",
         "splits": []}


def test_info_fields_reads_labels_and_ignores_blank_or_odd_values():
    assert info_fields({"industry": " Semiconductors ", "sector": "Technology"}) == \
        {"industry": "Semiconductors", "sector": "Technology"}
    assert info_fields({"industry": "", "sector": 7}) == {"industry": None, "sector": None}
    assert info_fields(None) == {"industry": None, "sector": None}


def test_splits_from_history_keeps_nonzero_rows():
    idx = pd.to_datetime(["2026-01-02", "2026-02-03", "2026-03-04"])
    hist = pd.DataFrame({"Close": [1, 2, 3], "Stock Splits": [0.0, 2.0, 0.1]}, index=idx)
    assert splits_from_history(hist) == [("2026-02-03", 2.0), ("2026-03-04", 0.1)]
    assert splits_from_history(pd.DataFrame({"Close": [1]})) == []
    assert splits_from_history(None) == []


def test_upsert_writes_labels_only_when_enabled_and_present():
    sb = FakeSB()
    upsert_ticker(sb, "AAA", "Alpha", STATS, with_labels=True)
    upsert_ticker(sb, "BBB", "Beta", STATS)  # schema not ready → no label keys at all
    upsert_ticker(sb, "CCC", "Gamma", {**STATS, "industry": None, "sector": None}, with_labels=True)
    rows = {r["ticker"]: r for _, r in sb.upserts}
    assert rows["AAA"]["industry"] == "Semiconductors" and rows["AAA"]["sector"] == "Technology"
    assert "industry" not in rows["BBB"] and "sector" not in rows["BBB"]
    assert "industry" not in rows["CCC"]  # a failed .info call never wipes yesterday's label
    assert rows["AAA"]["market_cap_usd"] == 5e9 and "splits" not in rows["AAA"]


def test_schema_check_is_false_until_migration_025_applies():
    assert has_fund_flow_schema(FakeSB()) is True
    assert has_fund_flow_schema(FakeSB(missing={"tickers"})) is False
    assert has_fund_flow_schema(FakeSB(missing={"stock_splits"})) is False
