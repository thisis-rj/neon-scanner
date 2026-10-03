"""Field parsing shared by the two Form 4 ingesters (bulk TSV and per-filing XML).

SEC spells the same facts several ways: booleans arrive as "1"/"0",
"true"/"false" or blank; the bulk relationship column is a comma list
("Director,Officer,TenPercentOwner"). Parsing them in one place keeps the
two ingesters from drifting apart (the bulk path once tested for
"TEN PERCENT" and never matched "TenPercentOwner").
"""
from __future__ import annotations

TRUE_VALUES = {"1", "true"}
FALSE_VALUES = {"0", "false"}


def parse_bool_flag(value: str | None) -> bool | None:
    """'1'/'true' → True, '0'/'false' → False, blank/other → None (unknown)."""
    v = (value or "").strip().lower()
    if v in TRUE_VALUES:
        return True
    if v in FALSE_VALUES:
        return False
    return None


def relationship_flags(relationship: str | None) -> dict[str, bool]:
    """Bulk RPTOWNER_RELATIONSHIP ('Director,Officer,TenPercentOwner', 'Other', ...) → role flags."""
    tokens = {t.strip().lower() for t in (relationship or "").split(",") if t.strip()}
    return {
        "reporter_is_officer": "officer" in tokens,
        "reporter_is_director": "director" in tokens,
        "reporter_is_ten_pct": "tenpercentowner" in tokens,
    }


def parse_number(value: str | None) -> float | None:
    try:
        return float(value) if value not in (None, "") else None
    except ValueError:
        return None


def direct_indirect(value: str | None) -> str | None:
    """'D' or 'I' (direct / indirect ownership); anything else → None."""
    v = (value or "").strip().upper()
    return v if v in ("D", "I") else None
