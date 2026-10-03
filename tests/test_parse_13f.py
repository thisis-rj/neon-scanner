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


# ─── parse_one_filing: amendment type + sh_type reach the database ───────
# Value: protects=13F-HR/A cover type stored only when read (never blanked), sh_type written, holdings parse even if the cover page fails; fails_when=record_amendment_type writes NULL on a failed read, raises on fetch error, or sh_type is dropped from the insert; why_new=existing tests cover pure parsers only, not the parse→DB write path; seam=none
import requests  # noqa: E402

import ingest.parse_13f as p13f  # noqa: E402


class _Resp:
    def __init__(self, status, content=b"", payload=None):
        self.status_code, self.content, self._payload = status, content, payload

    def json(self):
        return self._payload


class _FakeSupabase:
    """Records every write; parse_one_filing only deletes, inserts and updates."""

    def __init__(self):
        self.ops = []

    def table(self, name):
        sb, op = self, {"table": name}

        class _Q:
            def delete(self): op["op"] = "delete"; return self
            def insert(self, rows): op.update(op="insert", rows=rows); return self
            def update(self, values): op.update(op="update", values=values); return self
            def eq(self, k, v): op["eq"] = (k, v); return self
            def execute(self): sb.ops.append(op); return _Resp(200)
        return _Q()


@pytest.mark.parametrize("form,cover,stored", [
    ("13F-HR/A", _Resp(200, (FIX / "primary_doc_new_holdings.xml").read_bytes()), "NEW HOLDINGS"),
    ("13F-HR/A", _Resp(200, (FIX / "primary_doc_restatement.xml").read_bytes()), "RESTATEMENT"),
    ("13F-HR/A", _Resp(404), None),                                   # cover page missing
    ("13F-HR/A", requests.ConnectionError("reset"), None),             # retries exhausted
    ("13F-HR/A", _Resp(200, b"<broken"), None),                        # unreadable cover page
    ("13F-HR", AssertionError("an original's cover page must not be fetched"), None),
])
def test_parse_one_filing_records_amendment_type_only_when_read(monkeypatch, form, cover, stored):
    def fake_get(url, _headers):
        if url.endswith("/index.json"):
            return _Resp(200, payload={"directory": {"item": [
                {"name": "primary_doc.xml"}, {"name": "infotable.xml"}, {"name": "0001.txt"}]}})
        if url.endswith("/infotable.xml"):
            return _Resp(200, (FIX / "infotable_mixed.xml").read_bytes())
        assert url.endswith("/primary_doc.xml"), url
        if isinstance(cover, Exception):
            raise cover
        return cover

    sb = _FakeSupabase()
    monkeypatch.setattr(p13f, "_polite_get", fake_get)
    monkeypatch.setattr(p13f, "_supabase", lambda: sb)
    filing = {"id": "f-1", "cik": "949509", "accession_number": "0000949509-26-000004",
              "period_of_report": "2026-03-31", "form_type": form}

    unreadable_amendment = form == "13F-HR/A" and stored is None
    if unreadable_amendment:
        # Left unparsed and untouched (retried next run): an untyped amendment would count as a
        # RESTATEMENT and could replace the whole quarter.
        assert p13f.parse_one_filing(filing) == (0, "amendment type unreadable; left unparsed, will retry")
        assert sb.ops == []
        return
    assert p13f.parse_one_filing(filing) == (6, None)

    updates = [o for o in sb.ops if o["table"] == "filings_raw"]
    if stored is None:
        assert updates == []  # an original's cover page is never read or written
    else:
        assert updates == [{"table": "filings_raw", "op": "update", "values": {"amendment_type": stored},
                            "eq": ("id", "f-1")}]
    inserted = [r for o in sb.ops if o.get("op") == "insert" for r in o["rows"]]
    assert sorted(r["sh_type"] for r in inserted) == ["PRN", "PRN", "SH", "SH", "SH", "SH"]
    assert [o["op"] for o in sb.ops if o["table"] == "holdings_13f"] == ["delete", "insert"]


# Value: protects=a batch insert failure leaves the filing with no rows, so the next run re-parses it; fails_when=the cleanup delete is removed and a truncated filing becomes the quarter's base; why_new=no test covered insert failures; seam=none
def test_parse_one_filing_failed_insert_leaves_no_partial_rows(monkeypatch):
    def fake_get(url, _headers):
        if url.endswith("/index.json"):
            return _Resp(200, payload={"directory": {"item": [{"name": "infotable.xml"}]}})
        return _Resp(200, (FIX / "infotable_mixed.xml").read_bytes())

    sb = _FakeSupabase()
    real_table = sb.table

    def flaky_table(name):
        q = real_table(name)
        insert = q.insert
        def failing_insert(rows):
            raise requests.ConnectionError("reset mid-batch")
        q.insert = failing_insert if name == "holdings_13f" else insert
        return q

    sb.table = flaky_table
    monkeypatch.setattr(p13f, "_polite_get", fake_get)
    monkeypatch.setattr(p13f, "_supabase", lambda: sb)
    filing = {"id": "f-2", "cik": "1", "accession_number": "0000000001-26-000001",
              "period_of_report": "2026-03-31", "form_type": "13F-HR"}

    with pytest.raises(requests.ConnectionError):
        p13f.parse_one_filing(filing)
    assert [o["op"] for o in sb.ops if o["table"] == "holdings_13f"] == ["delete", "delete"]
