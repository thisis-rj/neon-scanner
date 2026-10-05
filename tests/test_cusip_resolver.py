"""OpenFIGI request shape in ingest/cusip_resolver.py; no network."""
import pytest

from ingest import cusip_resolver
from ingest.cusip_resolver import figi_id_type


@pytest.mark.parametrize("cusip,expected", [
    ("H1467J104", "ID_CINS"),   # Chubb (Switzerland)
    ("G1151C101", "ID_CINS"),   # Accenture (Ireland)
    ("N07059210", "ID_CINS"),   # ASML (Netherlands)
    ("037833100", "ID_CUSIP"),  # Apple
    ("67066G104", "ID_CUSIP"),  # NVIDIA: letters inside, digit first
])
def test_figi_id_type(cusip, expected):
    assert figi_id_type(cusip) == expected


def test_lookup_sends_each_cusip_with_its_own_id_type(monkeypatch):
    sent = {}

    class Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return [{"data": [{"ticker": "CB", "exchCode": "US"}]}, {"warning": "No identifier found."}]

    def fake_post(url, json, headers, timeout):
        sent["body"] = json
        return Resp()

    monkeypatch.setattr(cusip_resolver.requests, "post", fake_post)
    out = cusip_resolver.openfigi_lookup(["H1467J104", "000000000"])
    assert [b["idType"] for b in sent["body"]] == ["ID_CINS", "ID_CUSIP"]
    assert out["H1467J104"]["ticker"] == "CB" and out["000000000"] is None
