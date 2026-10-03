"""Fixture tests for the Form 4 ingesters (CLAUDE.md §10: parsers have fixture tests).

  tests/fixtures/form4/form4_plan.xml    Navios (NMM) 0001193125-26-135314 — aff10b5One "true",
                                         role flags written as "true" (not "1")
  tests/fixtures/form4/form4_noplan.xml  Zenas (ZBIO) 0001104659-26-038031 — aff10b5One "0"
The bulk test builds a tiny zip with SEC's real TSV headers (2026 Q1 file).
"""
import io
import zipfile
from pathlib import Path

import pytest

from ingest.form4_fields import direct_indirect, parse_bool_flag, parse_number, relationship_flags
from ingest.form4_universe import parse_form4
from ingest.form4_universe_bulk import parse_quarter

FIX = Path(__file__).parent / "fixtures" / "form4"


@pytest.mark.parametrize("raw,expected", [
    ("1", True), ("true", True), ("TRUE", True), (" 0 ", False), ("false", False), ("", None), (None, None), ("yes", None),
])
def test_parse_bool_flag(raw, expected):
    assert parse_bool_flag(raw) is expected


@pytest.mark.parametrize("rel,officer,director,ten", [
    ("Officer", True, False, False),
    ("Director,Officer", True, True, False),
    ("TenPercentOwner", False, False, True),          # the value the old "TEN PERCENT" check never matched
    ("Director,Officer,TenPercentOwner", True, True, True),
    ("TenPercentOwner,Other", False, False, True),
    ("Other", False, False, False),
    ("", False, False, False),
])
def test_relationship_flags(rel, officer, director, ten):
    assert relationship_flags(rel) == {
        "reporter_is_officer": officer, "reporter_is_director": director, "reporter_is_ten_pct": ten}


def test_small_field_parsers():
    assert parse_number("4686314.0") == 4686314.0 and parse_number("") is None and parse_number("n/a") is None
    assert direct_indirect("d") == "D" and direct_indirect("I") == "I" and direct_indirect("") is None


def test_xml_plan_buy_with_true_spelled_flags():
    rows = parse_form4((FIX / "form4_plan.xml").read_bytes())
    assert rows and all(r["transaction_code"] == "P" for r in rows)
    r = rows[0]
    assert r["issuer_ticker"] == "NMM"
    # Old parser compared to "1" and read all three as False for this filing.
    assert (r["reporter_is_officer"], r["reporter_is_director"], r["reporter_is_ten_pct"]) == (True, True, True)
    assert r["is_10b5_1"] is True
    assert r["shares_owned_after"] and r["direct_indirect"] in ("D", "I")


def test_xml_non_plan_buy():
    rows = parse_form4((FIX / "form4_noplan.xml").read_bytes())
    assert rows
    r = rows[0]
    assert r["issuer_ticker"] == "ZBIO"
    assert (r["reporter_is_officer"], r["reporter_is_director"], r["reporter_is_ten_pct"]) == (True, True, False)
    assert r["is_10b5_1"] is False


def test_xml_without_10b5_1_element_is_unknown():
    """Filings before April 2023 have no aff10b5One element."""
    xml = (FIX / "form4_noplan.xml").read_bytes().replace(b"<aff10b5One>0</aff10b5One>", b"")
    assert parse_form4(xml)[0]["is_10b5_1"] is None


def _tsv(header, rows):
    return "\t".join(header) + "\n" + "".join("\t".join(r.get(h, "") for h in header) + "\n" for r in rows)


SUB_H = ["ACCESSION_NUMBER", "FILING_DATE", "PERIOD_OF_REPORT", "DATE_OF_ORIG_SUB", "NO_SECURITIES_OWNED",
         "NOT_SUBJECT_SEC16", "FORM3_HOLDINGS_REPORTED", "FORM4_TRANS_REPORTED", "DOCUMENT_TYPE", "ISSUERCIK",
         "ISSUERNAME", "ISSUERTRADINGSYMBOL", "REMARKS", "AFF10B5ONE"]
OWN_H = ["ACCESSION_NUMBER", "RPTOWNERCIK", "RPTOWNERNAME", "RPTOWNER_RELATIONSHIP", "RPTOWNER_TITLE"]
TX_H = ["ACCESSION_NUMBER", "NONDERIV_TRANS_SK", "SECURITY_TITLE", "TRANS_DATE", "TRANS_CODE", "TRANS_SHARES",
        "TRANS_PRICEPERSHARE", "TRANS_ACQUIRED_DISP_CD", "SHRS_OWND_FOLWNG_TRANS", "DIRECT_INDIRECT_OWNERSHIP"]


def test_bulk_quarter_parses_flags_and_new_fields(tmp_path):
    sub = [
        {"ACCESSION_NUMBER": "a1", "FILING_DATE": "05-MAR-2026", "DOCUMENT_TYPE": "4", "ISSUERCIK": "123",
         "ISSUERNAME": "Acme", "ISSUERTRADINGSYMBOL": "acme", "AFF10B5ONE": "true"},
        {"ACCESSION_NUMBER": "a2", "FILING_DATE": "06-MAR-2026", "DOCUMENT_TYPE": "4", "ISSUERCIK": "123",
         "ISSUERNAME": "Acme", "ISSUERTRADINGSYMBOL": "ACME", "AFF10B5ONE": ""},
        {"ACCESSION_NUMBER": "a3", "FILING_DATE": "06-MAR-2026", "DOCUMENT_TYPE": "4/A", "ISSUERCIK": "123"},
    ]
    own = [
        {"ACCESSION_NUMBER": "a1", "RPTOWNERCIK": "11", "RPTOWNERNAME": "Big Fund", "RPTOWNER_RELATIONSHIP": "TenPercentOwner"},
        {"ACCESSION_NUMBER": "a2", "RPTOWNERCIK": "22", "RPTOWNERNAME": "Jane CEO",
         "RPTOWNER_RELATIONSHIP": "Director,Officer", "RPTOWNER_TITLE": "CEO"},
        {"ACCESSION_NUMBER": "a2", "RPTOWNERCIK": "33", "RPTOWNERNAME": "Second owner on joint filing",
         "RPTOWNER_RELATIONSHIP": "Other"},
    ]
    tx = [
        {"ACCESSION_NUMBER": "a1", "TRANS_DATE": "03-MAR-2026", "TRANS_CODE": "P", "TRANS_SHARES": "1000",
         "TRANS_PRICEPERSHARE": "20", "SHRS_OWND_FOLWNG_TRANS": "50000", "DIRECT_INDIRECT_OWNERSHIP": "I"},
        {"ACCESSION_NUMBER": "a2", "TRANS_DATE": "04-MAR-2026", "TRANS_CODE": "P", "TRANS_SHARES": "500",
         "TRANS_PRICEPERSHARE": "40", "SHRS_OWND_FOLWNG_TRANS": "", "DIRECT_INDIRECT_OWNERSHIP": "D"},
        {"ACCESSION_NUMBER": "a2", "TRANS_DATE": "04-MAR-2026", "TRANS_CODE": "S", "TRANS_SHARES": "10",
         "TRANS_PRICEPERSHARE": "40"},
        {"ACCESSION_NUMBER": "a3", "TRANS_DATE": "04-MAR-2026", "TRANS_CODE": "P", "TRANS_SHARES": "10",
         "TRANS_PRICEPERSHARE": "40"},
    ]
    zpath = tmp_path / "2026q1_form345.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("SUBMISSION.tsv", _tsv(SUB_H, sub))
        z.writestr("REPORTINGOWNER.tsv", _tsv(OWN_H, own))
        z.writestr("NONDERIV_TRANS.tsv", _tsv(TX_H, tx))
    rows = {r["accession_number"]: r for r in parse_quarter(zpath)}
    assert set(rows) == {"a1", "a2"}  # the sale and the 4/A are skipped

    fund = rows["a1"]
    assert fund["reporter_is_ten_pct"] is True and not fund["reporter_is_officer"] and not fund["reporter_is_director"]
    assert fund["is_10b5_1"] is True
    assert (fund["shares_owned_after"], fund["direct_indirect"]) == (50000.0, "I")
    assert fund["issuer_ticker"] == "ACME" and fund["value_usd"] == 20000.0

    ceo = rows["a2"]
    assert ceo["reporter_name"] == "Jane CEO"  # first owner of a joint filing is kept
    assert ceo["reporter_is_officer"] and ceo["reporter_is_director"] and not ceo["reporter_is_ten_pct"]
    assert ceo["is_10b5_1"] is None and ceo["shares_owned_after"] is None and ceo["direct_indirect"] == "D"


# Value: protects=re-running the daily Form 4 ingest refreshes rows already stored (new 10b5-1/shares-after fields, corrected role flags); fails_when=the upsert goes back to ignore_duplicates=True and old rows keep stale values forever; why_new=no test covered insert_transactions; seam=none
def test_daily_upsert_refreshes_existing_rows():
    from ingest.form4_universe import insert_transactions

    calls = []

    class _Table:
        def upsert(self, rows, **kw):
            calls.append(kw)
            self.rows = rows
            return self

        def execute(self):
            return type("R", (), {"data": self.rows})()

    sb = type("SB", (), {"table": lambda self, name: _Table()})()
    assert insert_transactions(sb, [{"accession_number": "a", "is_10b5_1": True}]) == 1
    assert calls == [{"on_conflict": "accession_number,reporter_cik,transaction_date,transaction_code,shares",
                      "ignore_duplicates": False}]


# Value: protects=a daily batch with two rows sharing the conflict key is still written (deduped first); fails_when=dedup is removed and Postgres rejects the whole ON CONFLICT DO UPDATE batch; why_new=the refresh test above sends one row; seam=none
def test_daily_upsert_dedups_conflict_keys():
    from ingest.form4_universe import insert_transactions

    sent = []

    class _Table:
        def upsert(self, rows, **kw):
            keys = [(r["accession_number"], r["reporter_cik"], r["transaction_date"], r["transaction_code"], r["shares"])
                    for r in rows]
            assert len(keys) == len(set(keys)), "Postgres: ON CONFLICT DO UPDATE cannot affect row a second time"
            sent.extend(rows)
            return self

        def execute(self):
            return type("R", (), {"data": sent})()

    row = {"accession_number": "0001-26-000001", "reporter_cik": "9", "transaction_date": "2026-09-20",
           "transaction_code": "P", "shares": 100}
    sb = type("SB", (), {"table": lambda self, name: _Table()})()
    # Same filing listed under issuer and owner in the daily index, plus one distinct lot.
    assert insert_transactions(sb, [dict(row), dict(row), dict(row, shares=200)]) == 2
