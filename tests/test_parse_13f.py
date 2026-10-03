"""Fixture tests for ingest/parse_13f.py (CLAUDE.md §10: parsers have fixture tests).

Fixtures in tests/fixtures/13f/ are real SEC files, trimmed:
  infotable_mixed.xml             Oaktree 13F-HR/A, Q1-2026 — 2 bond (PRN), 2 share, 1 call, 1 put rows
  primary_doc_original.xml        Corvex 13F-HR cover page (no amendment info)
  primary_doc_restatement.xml     Oaktree 13F-HR/A 0000949509-26-000004 (RESTATEMENT)
  primary_doc_new_holdings.xml    Berkshire 13F-HR/A 0000950123-25-008361, Q1-2025 (NEW HOLDINGS)
"""
from pathlib import Path

import pytest

from ingest.parse_13f import parse_amendment_type, parse_info_table, pick_info_table, pick_primary_doc

FIX = Path(__file__).parent / "fixtures" / "13f"


def test_info_table_keeps_share_type_and_options():
    rows = parse_info_table((FIX / "infotable_mixed.xml").read_bytes())
    by_cusip = {r["cusip"]: r for r in rows}
    assert len(rows) == 6
    # Convertible bond: 10,313,000 is dollars of principal, not shares.
    bond = by_cusip["008073AA6"]
    assert (bond["issuer_name"], bond["shares"], bond["put_call"], bond["sh_type"]) == (
        "AEROVIRONMENT INC", 10313000, None, "PRN")
    assert bond["value_usd"] == 10117052.0
    assert by_cusip["L01800108"]["sh_type"] == "SH" and by_cusip["L01800108"]["put_call"] is None
    assert by_cusip["21874A106"]["put_call"] == "Call"
    assert by_cusip["46090E103"]["put_call"] == "Put"
    assert sorted(r["sh_type"] for r in rows) == ["PRN", "PRN", "SH", "SH", "SH", "SH"]


def test_info_table_unparseable_returns_empty():
    assert parse_info_table(b"<not xml") == []


@pytest.mark.parametrize("fixture,expected", [
    ("primary_doc_restatement.xml", "RESTATEMENT"),
    ("primary_doc_new_holdings.xml", "NEW HOLDINGS"),
    ("primary_doc_original.xml", None),
])
def test_amendment_type(fixture, expected):
    assert parse_amendment_type((FIX / fixture).read_bytes()) == expected


def test_amendment_type_unknown_value_and_bad_xml():
    doc = b'<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler"><amendmentType>SOMETHING</amendmentType></edgarSubmission>'
    assert parse_amendment_type(doc) is None
    assert parse_amendment_type(b"<broken") is None


@pytest.mark.parametrize("names,info,primary", [
    (["primary_doc.xml", "informationtable.xml"], "informationtable.xml", "primary_doc.xml"),
    (["primary_doc.xml", "13F_OCMLP_1Q2026.xml"], "13F_OCMLP_1Q2026.xml", "primary_doc.xml"),
    ([], None, None),
])
def test_file_picking(names, info, primary):
    assert pick_info_table(names) == info
    assert pick_primary_doc(names) == primary
