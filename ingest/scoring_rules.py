"""Pure scoring rules for the v6 confluence formula.

No I/O here: every function takes rows already loaded from Supabase and
returns plain data. compute_buy_signals.py does the fetching, the price
enrichment and the upsert; this module does the math, so it can be unit
tested and replayed against a snapshot (scripts/diff_signals.py).

Per CLAUDE.md §2.4 every score keeps its components: compute_signals()
returns the same `components` / `contributing_filers` breakdown that is
persisted to signals_latest.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, timedelta
from typing import Any, Iterable

TIER_MULT = {"S": 1.5, "A": 1.2, "B": 1.0, "C": 0.7}
MIN_MARKET_CAP_USD = 300_000_000
MIN_SCORE = 4.0
INSIDER_WINDOW_DAYS = 30
ACTIVIST_13D_WINDOW_DAYS = 90
RECENCY_CUTOFF_DAYS = 180


def cik10(c): return str(int(c)).zfill(10)


SUFFIX_RE = re.compile(
    r"\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|HOLDINGS|HLDGS|GROUP|GRP|LLC|LP|TRUST|N V|NV|SA|AG|TR|CL A|CL B|CLASS A|CLASS B|COM|ORD|ORDINARY|SHARES)\b\.?",
    re.I,
)
PUNCT_RE = re.compile(r"[.,&/\-\(\)\']")


def nm(s):
    if not s:
        return ""
    s = s.upper()
    s = PUNCT_RE.sub(" ", s)
    s = SUFFIX_RE.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


# ─── Filers ─────────────────────────────────────────────────────────────

def filer_weights(filers_cfg: Iterable[dict[str, Any]]):
    """tracked_filers.yml entries → (mult, name, tier, badge) dicts keyed by 10-digit CIK.

    Final filer weight = category multiplier × tier multiplier (§2.4: transparent).
    """
    mult, name, tier_of, badge = {}, {}, {}, {}
    for fl in filers_cfg:
        if not fl.get("cik"):
            continue
        c = cik10(fl["cik"])
        tier = fl.get("tier", "B")
        mult[c] = fl.get("multiplier", 1.0) * TIER_MULT.get(tier, 1.0)
        name[c] = fl["name"]
        tier_of[c] = tier
        badge[c] = fl.get("badge", "")
    return mult, name, tier_of, badge


# ─── 13F trajectories ───────────────────────────────────────────────────

def index_13f_filings(filings, filer_mult, window_end: str):
    """Group tracked filers' 13F-HR(/A) filings by CIK, sorted by (period, filed_at)."""
    f13f = defaultdict(list)
    for f in filings:
        if f["form_type"] not in ("13F-HR", "13F-HR/A"):
            continue
        if f["filed_at"][:10] > window_end:
            continue
        c = cik10(f["cik"])
        if c in filer_mult:
            f13f[c].append(f)
    for c in f13f:
        f13f[c].sort(key=lambda x: (x.get("period_of_report") or "", x["filed_at"]))
    return f13f


def holdings_by_filing(holding_rows, name_to_ticker):
    """filing_id → {ticker: total shares}. Falls back to issuer-name match for the ticker."""
    holdings = defaultdict(dict)
    for h in holding_rows:
        t = h.get("ticker") or name_to_ticker.get(nm(h.get("issuer_name", "")))
        if not t:
            continue
        holdings[h["filing_id"]][t] = holdings[h["filing_id"]].get(t, 0) + (h["shares"] or 0)
    return holdings


def build_trajectories(f13f, holdings):
    """(cik, ticker) → [(period, shares, filed_at), ...], one point per period.

    A quarter can have rows from two filings (the base filing plus a NEW
    HOLDINGS amendment); points for the same period are merged: shares
    summed, latest filed_at kept.
    """
    traj = {}
    for c, fs in f13f.items():
        for f in sorted(fs, key=lambda x: x.get("period_of_report") or x["filed_at"]):
            period, filed = f.get("period_of_report") or f["filed_at"][:10], f["filed_at"][:10]
            for t, sh in holdings.get(f["id"], {}).items():
                points = traj.setdefault((c, t), [])
                if points and points[-1][0] == period:
                    _, prev_sh, prev_filed = points[-1]
                    points[-1] = (period, prev_sh + sh, max(prev_filed, filed))
                else:
                    points.append((period, sh, filed))
    return traj


def filer_latest_periods(f13f):
    out = {}
    for c, fs in f13f.items():
        periods = [f.get("period_of_report") or f["filed_at"][:10] for f in fs]
        if periods:
            out[c] = max(periods)
    return out


def is_stale(tr, filer_latest_period: str | None, recency_cutoff: str) -> bool:
    """True iff this filer→ticker trajectory should be excluded as stale.

    Exited: the filer has filed a more recent 13F without this ticker.
    Old: even the latest entry is older than the recency cutoff (~2 quarters).
    """
    latest_period = tr[-1][0]
    if filer_latest_period and filer_latest_period > latest_period:
        return True
    if latest_period < recency_cutoff:
        return True
    return False


def classify_positions(traj, universe, filer_mult, latest_period_by_filer, recency_cutoff):
    """Split live trajectories into new / add (>1.2x) / velocity (≥2x) contributors."""
    new_pos = defaultdict(list)
    add_pos = defaultdict(list)
    velocity = defaultdict(list)
    contributing_filings = defaultdict(set)  # ticker -> filed_at dates contributing
    for (c, t), tr in traj.items():
        if t not in universe:
            continue
        if is_stale(tr, latest_period_by_filer.get(c), recency_cutoff):
            continue
        mult = filer_mult[c]
        latest = tr[-1]
        if len(tr) == 1:
            new_pos[t].append((c, mult))
            contributing_filings[t].add(latest[2])
        else:
            cur, prev = tr[-1], tr[-2]
            if cur[1] and prev[1]:
                r = cur[1] / prev[1]
                if r > 1.2:
                    add_pos[t].append((c, mult))
                    contributing_filings[t].add(cur[2])
                if r >= 2.0:
                    velocity[t].append((c, mult, round(r, 1)))
                    contributing_filings[t].add(cur[2])
    return new_pos, add_pos, velocity, contributing_filings


def cross_quarter_initiations(traj, universe, latest_period_by_filer, recency_cutoff):
    """Filers whose first appearance in a ticker is the latest (iq1) or prior (iq2) period."""
    all_periods = sorted({tr[-1][0] for tr in traj.values()}, reverse=True)
    lp = all_periods[0] if all_periods else None
    pp = all_periods[1] if len(all_periods) > 1 else None
    iq1, iq2 = defaultdict(list), defaultdict(list)
    for (c, t), tr in traj.items():
        if t not in universe:
            continue
        if is_stale(tr, latest_period_by_filer.get(c), recency_cutoff):
            continue
        earliest = tr[0][0]
        if earliest == lp:
            iq1[t].append(c)
        elif earliest == pp:
            iq2[t].append(c)
    return iq1, iq2


# ─── Insiders ───────────────────────────────────────────────────────────

def insider_clusters(insider_rows, window_start: str, window_end: str, filters: dict | None = None):
    """Distinct qualifying insider buyers per ticker whose trade and filing fall in the window.

    With `filters` (signal_weights.yml `insider_filters`), each insider's buys
    in the window are judged together by insider_qualifies(); excluded
    insiders are returned with the reason so the signal can show them
    (CLAUDE.md §2.4). Without filters every buyer counts (the v6 rule).
    Returns (cluster, dates, meta, excluded): excluded is ticker → [{name, reason}].
    """
    in_window = defaultdict(list)  # (ticker, reporter) -> rows
    for r in insider_rows:
        t = r.get("issuer_ticker")
        if not t:
            continue
        td = r.get("transaction_date")
        if not td or td < window_start or td > window_end:
            continue
        fa = (r.get("filed_at") or "")[:10]
        if not fa or fa > window_end:
            continue
        in_window[(t, r["reporter_cik"])].append(r)

    ins_cluster = defaultdict(set)
    excluded = defaultdict(list)
    counted_ids = set()
    for (t, reporter), rows in in_window.items():
        ok, reason, counted = insider_qualifies(rows, filters) if filters else (True, None, rows)
        if not ok:
            excluded[t].append({"name": rows[0].get("reporter_name"), "reason": reason})
            continue
        ins_cluster[t].add(reporter)
        counted_ids.update(id(r) for r in counted)

    # Dates and buyer names in the original row order (what the page lists first).
    ins_dates = defaultdict(list)
    ins_meta = defaultdict(list)
    for r in insider_rows:
        if id(r) not in counted_ids:
            continue
        t = r["issuer_ticker"]
        ins_dates[t].append((r.get("filed_at") or "")[:10])
        ins_meta[t].append({"name": r.get("reporter_name"), "value": r.get("value_usd"),
                            "date": r.get("transaction_date")})
    return ins_cluster, ins_dates, ins_meta, excluded


def insider_qualifies(rows, filters: dict):
    """Judge one insider's open-market buys of one ticker inside the window.

    Returns (qualifies, exclusion_reason, rows_counted). Filters, each off when
    its setting is falsy:
      officers_directors_only  officer or director; a pure 10% holder or "Other" is excluded
      exclude_10b5_1           pre-scheduled Rule 10b5-1 plan buys are dropped first
      min_value_usd            total of the remaining buys
      min_stake_growth_pct     Σ shares bought / shares held before; first purchase passes
    Unknown inputs (no 10b5-1 flag before April 2023, missing price or
    shares-after) never exclude anyone.
    """
    if filters.get("officers_directors_only") and not any(
        r.get("reporter_is_officer") or r.get("reporter_is_director") for r in rows
    ):
        return False, "not_officer_or_director", []

    if filters.get("exclude_10b5_1"):
        rows = [r for r in rows if r.get("is_10b5_1") is not True]
        if not rows:
            return False, "10b5_1_plan", []

    min_value = filters.get("min_value_usd")
    if min_value:
        values = [r.get("value_usd") for r in rows]
        if all(v is not None for v in values) and sum(values) < min_value:
            return False, "below_min_value", []

    min_growth = filters.get("min_stake_growth_pct")
    if min_growth:
        growth = stake_growth(rows)
        if growth is not None and growth < min_growth:
            return False, "stake_growth_below_min", []

    return True, None, rows


def stake_growth(rows) -> float | None:
    """Σ shares bought / shares held before the first buy, per ownership line (direct/indirect).

    Shares held before = latest shares_owned_after on each line − shares bought
    on that line. Returns inf for a first-ever purchase, None if any input is missing.
    """
    lines = defaultdict(list)
    for r in rows:
        if r.get("shares") is None or r.get("shares_owned_after") is None:
            return None
        lines[r.get("direct_indirect")].append(r)
    bought = held_before = 0.0
    for line_rows in lines.values():
        line_bought = sum(float(r["shares"]) for r in line_rows)
        bought += line_bought
        held_before += max(float(r["shares_owned_after"]) for r in line_rows) - line_bought
    if held_before <= 0:
        return float("inf")
    return bought / held_before


def insider_score(n_buyers: int) -> float:
    """Lakonishok-Lee cluster scoring: 0/1/2/3+ distinct buyers → 0 / 1.5 / 3.5 / 7.0 (+1 each beyond 3)."""
    if n_buyers == 0: return 0.0
    if n_buyers == 1: return 1.5
    if n_buyers == 2: return 3.5
    return 7.0 + (n_buyers - 3) * 1.0


# ─── 13D ────────────────────────────────────────────────────────────────

def activist_13d(e13d_rows, filed_at_by_filing, name_to_ticker, filer_mult, window_start, window_end):
    """Initial 13Ds from tracked filers in the window → (ticker → [(cik, mult)], ticker → {filed_at})."""
    act = defaultdict(list)
    dates = defaultdict(set)
    for r in e13d_rows:
        t = r.get("ticker") or name_to_ticker.get(nm(r.get("issuer_name", "")))
        if not t or r["form_subtype"] not in ("13D", "SCHEDULE 13D"):
            continue
        fa = filed_at_by_filing.get(r["filing_id"])
        if not fa or fa > window_end or fa < window_start:
            continue
        c = cik10(r["cik"])
        if c in filer_mult:
            act[t].append((c, filer_mult[c]))
            dates[t].add(fa)
    return act, dates


# ─── Whole formula ──────────────────────────────────────────────────────

def compute_signals(
    as_of: date,
    filers_cfg,
    universe_rows,
    filings,
    holding_rows,
    insider_rows,
    e13d_rows,
    insider_filters: dict | None = None,
) -> list[dict[str, Any]]:
    """Score every candidate ticker with the v6 formula. Returns rows sorted by score desc.

    Rows carry ticker, score, num_sources, components, contributing_filers,
    first_detected_at, latest_signal_at, aum_usd — exactly what main() upserts
    before price enrichment.
    """
    filer_mult, filer_name, _, _ = filer_weights(filers_cfg)
    universe = {r["ticker"]: r for r in universe_rows}
    name_to_ticker = {nm(u.get("name", "")): t for t, u in universe.items()}
    window_end = as_of.isoformat()
    recency_cutoff = (as_of - timedelta(days=RECENCY_CUTOFF_DAYS)).isoformat()

    filed_at = {f["id"]: f["filed_at"][:10] for f in filings}
    f13f = index_13f_filings(filings, filer_mult, window_end)
    traj = build_trajectories(f13f, holdings_by_filing(holding_rows, name_to_ticker))
    latest_period = filer_latest_periods(f13f)

    ins_cluster, ins_dates, ins_meta, ins_excluded = insider_clusters(
        insider_rows, (as_of - timedelta(days=INSIDER_WINDOW_DAYS)).isoformat(), window_end,
        insider_filters,
    )
    new_pos, add_pos, velocity, contributing = classify_positions(
        traj, universe, filer_mult, latest_period, recency_cutoff
    )
    act_13d, act_dates = activist_13d(
        e13d_rows, filed_at, name_to_ticker, filer_mult,
        (as_of - timedelta(days=ACTIVIST_13D_WINDOW_DAYS)).isoformat(), window_end,
    )
    for t, ds in act_dates.items():
        contributing[t] |= ds
    iq1, iq2 = cross_quarter_initiations(traj, universe, latest_period, recency_cutoff)

    def xq_filers(t):
        return set(iq1.get(t, [])) | set(iq2.get(t, []))

    def s_new(t): return sum(m for _, m in new_pos.get(t, [])) * 2.0
    def s_add(t): return sum(m for _, m in add_pos.get(t, [])) * 0.5
    def s_vel(t): return sum(m for _, m, _ in velocity.get(t, [])) * 2.0
    def s_13d(t): return sum(m for _, m in act_13d.get(t, [])) * 5.0

    def s_xq(t):
        combined = xq_filers(t)
        return sum(filer_mult[c] for c in combined) * 1.5 if len(combined) >= 3 else 0.0

    def s_pat(t):
        types = sum([
            len(ins_cluster.get(t, set())) >= 2,
            len(new_pos.get(t, [])) >= 1 or len(add_pos.get(t, [])) >= 1,
            len(act_13d.get(t, [])) >= 1,
            len(velocity.get(t, [])) >= 1,
            len(xq_filers(t)) >= 3,
        ])
        return (5.0 if types >= 3 else 0.0, types)

    all_t = set(ins_cluster) | set(new_pos) | set(add_pos) | set(act_13d) | set(velocity) | set(iq1) | set(iq2)
    scored: list[dict[str, Any]] = []
    for t in all_t:
        if t not in universe:
            continue
        if (universe[t].get("market_cap_usd") or 0) < MIN_MARKET_CAP_USD:
            continue
        ins_score = insider_score(len(ins_cluster.get(t, set())))
        n_score, a_score, d13_score = s_new(t), s_add(t), s_13d(t)
        vel_score, xq_score = s_vel(t), s_xq(t)
        pat_score, n_types = s_pat(t)
        total = ins_score + n_score + a_score + d13_score + vel_score + xq_score + pat_score
        if total < MIN_SCORE:
            continue

        fdates = list(contributing.get(t, set())) + ins_dates.get(t, [])
        scored.append({
            "ticker": t,
            "score": round(total, 2),
            "num_sources": n_types,
            "components": {
                "insider_cluster": {
                    "n": len(ins_cluster.get(t, set())), "score": round(ins_score, 2),
                    **({"excluded": ins_excluded[t]} if ins_excluded.get(t) else {}),
                },
                "thirteenf_new": {"n": len(new_pos.get(t, [])), "score": round(n_score, 2)},
                "thirteenf_add": {"n": len(add_pos.get(t, [])), "score": round(a_score, 2)},
                "activist_13d": {"n": len(act_13d.get(t, [])), "score": round(d13_score, 2)},
                "share_velocity": {"n": len(velocity.get(t, [])), "score": round(vel_score, 2)},
                "cross_q_confluence": {"n": len(xq_filers(t)), "score": round(xq_score, 2)},
                "multi_source_bonus": {"applied": pat_score > 0, "n_types": n_types, "score": round(pat_score, 2)},
            },
            "contributing_filers": {
                "new": [filer_name.get(c, c) for c, _ in new_pos.get(t, [])][:5],
                "add": [filer_name.get(c, c) for c, _ in add_pos.get(t, [])][:5],
                "velocity": [(filer_name.get(c, c), r) for c, _, r in velocity.get(t, [])][:5],
                "activist": [filer_name.get(c, c) for c, _ in act_13d.get(t, [])][:3],
                "insider_buyers": [m["name"] for m in ins_meta.get(t, [])][:5],
            },
            "first_detected_at": min(fdates) if fdates else None,
            "latest_signal_at": max(fdates) if fdates else None,
            "aum_usd": universe[t].get("market_cap_usd"),
        })

    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored


# ─── Fund flows (the /funds page) ───────────────────────────────────────
#
# One row per fund × stock × quarter pair: what the fund did to the stock
# between two of its own consecutive 13F filings. No scoring here — the
# counting (net funds, tier-weighted net, conviction, streak) happens in the
# fund_flows() SQL function (migration 025) so every view counts the same way.
#
#   opened   absent in the earlier filing, present now
#   added    split-adjusted shares up ≥ 10%
#   trimmed  split-adjusted shares down ≥ 10%
#   exited   present in the earlier filing, absent now
#   (held — anything else — is not stored)
#
# Pairing (eng review D5): each fund's newest filing vs its previous filing,
# so an early filer counts the day it files. A fund whose newest filing is
# older than the previous reporting quarter has stopped filing and is left
# out. A fund with a single filing has no baseline and records nothing.

FLOW_CHANGE_THRESHOLD = 0.10
FILING_DEADLINE_DAYS = 45


def quarter_end_on_or_before(d: date) -> date:
    """Latest calendar quarter end ≤ d."""
    for month, day in ((12, 31), (9, 30), (6, 30), (3, 31)):
        q = date(d.year, month, day)
        if q <= d:
            return q
    return date(d.year - 1, 12, 31)


def previous_quarter_end(q: date) -> date:
    return quarter_end_on_or_before(q.replace(day=1) - timedelta(days=1))


def reporting_quarter(as_of: date) -> date:
    """Latest quarter whose 45-day 13F deadline has passed (deadline day excluded)."""
    q = quarter_end_on_or_before(as_of)
    while q + timedelta(days=FILING_DEADLINE_DAYS) >= as_of:
        q = previous_quarter_end(q)
    return q


def resolve_holding_ticker(h, cusip_map, name_to_ticker):
    """Ticker for a 13F row. Today's CUSIP map first, so both quarters of a pair
    resolve the same way; then the stored ticker; then an issuer-name match."""
    return (cusip_map.get(h.get("cusip") or "") or h.get("ticker")
            or name_to_ticker.get(nm(h.get("issuer_name", ""))))


def fund_snapshots(holding_rows, cusip_map, name_to_ticker):
    """cik → period → {"positions": {ticker: {shares, value, issuer}}, "total_value": float}.

    total_value covers every row in the quarter, resolved or not — it is the
    denominator for a position's share of the fund's 13F book.
    """
    snaps: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for h in holding_rows:
        c, period = cik10(h["cik"]), h["period_of_report"]
        snap = snaps[c].setdefault(period, {"positions": {}, "total_value": 0.0})
        value = float(h.get("value_usd") or 0)
        snap["total_value"] += value
        t = resolve_holding_ticker(h, cusip_map, name_to_ticker)
        if not t:
            continue
        p = snap["positions"].setdefault(t, {"shares": 0.0, "value": 0.0, "issuer": h.get("issuer_name")})
        p["shares"] += float(h.get("shares") or 0)
        p["value"] += value
    return snaps


def split_factor(splits_for_ticker, after: str, upto: str) -> float:
    """Product of split ratios dated in (after, upto]. 2.0 = 2-for-1, 0.1 = 1-for-10."""
    f = 1.0
    for d, ratio in splits_for_ticker or ():
        if after < d <= upto and ratio:
            f *= ratio
    return f


def classify_change(prev_shares, cur_shares, factor: float = 1.0,
                    threshold: float = FLOW_CHANGE_THRESHOLD) -> str | None:
    """opened / added / trimmed / exited, or None for held / nothing held."""
    prev, cur = prev_shares or 0, cur_shares or 0
    if prev <= 0 and cur <= 0:
        return None
    if prev <= 0:
        return "opened"
    if cur <= 0:
        return "exited"
    # Rounded so 100 → 90 (0.9 − 1 = −0.0999…98 in floating point) is a trim.
    change = round(cur / (prev * factor) - 1, 9)
    if change >= threshold:
        return "added"
    if change <= -threshold:
        return "trimmed"
    return None


def _change_rows(cik, meta, cur_period, prev_period, cur_snap, prev_snap, splits, lag, rank):
    rows = []
    cur_pos, prev_pos = cur_snap["positions"], prev_snap["positions"]
    for t in sorted(set(cur_pos) | set(prev_pos)):
        cur, prev = cur_pos.get(t), prev_pos.get(t)
        factor = split_factor(splits.get(t), prev_period, cur_period)
        event = classify_change(prev and prev["shares"], cur and cur["shares"], factor)
        if not event:
            continue
        # Exits are measured on the earlier filing; everything else on the newer one.
        side, snap = (prev, prev_snap) if event == "exited" else (cur, cur_snap)
        total = snap["total_value"]
        rows.append({
            "cik": cik,
            "ticker": t,
            "lag_quarters": lag,
            "pair_rank": rank,
            "period": cur_period,
            "prev_period": prev_period,
            "event": event,
            "shares_prev": prev["shares"] if prev else None,
            "shares_cur": cur["shares"] if cur else None,
            "split_factor": factor,
            "value_usd": side["value"],
            "pct_of_fund": (side["value"] / total) if total > 0 else None,
            "issuer_name": side["issuer"],
            **meta,
        })
    return rows


def fund_position_changes(as_of: date, filers_cfg, holding_rows, cusip_map, universe_rows, splits):
    """All fund_position_changes rows plus per-fund stats.

    lag 1: every consecutive pair of the fund's filings, rank 0 = newest pair
           (rank drives the streak). lag 2: newest filing vs two filings back,
           rank 0 only (the "latest 2 quarters combined" filter).
    splits: ticker → [(split_date 'YYYY-MM-DD', ratio)].
    """
    name_to_ticker = {nm(u.get("name", "")): u["ticker"] for u in universe_rows if u.get("name")}
    meta = {}
    for fl in filers_cfg:
        if not fl.get("cik"):
            continue
        tier = fl.get("tier", "B")
        meta[cik10(fl["cik"])] = {
            "filer_name": fl["name"], "tier": tier, "category": fl.get("category"),
            "tier_mult": TIER_MULT.get(tier, 1.0),
        }
    cutoff = previous_quarter_end(reporting_quarter(as_of)).isoformat()
    snaps = fund_snapshots(holding_rows, cusip_map, name_to_ticker)

    rows: list[dict[str, Any]] = []
    stats = {"counted": [], "no_baseline": [], "stopped_filing": [], "untracked": 0}
    for c, by_period in snaps.items():
        if c not in meta:
            stats["untracked"] += 1
            continue
        periods = sorted(by_period, reverse=True)
        name = meta[c]["filer_name"]
        if periods[0] < cutoff:
            stats["stopped_filing"].append((name, periods[0]))
            continue
        if len(periods) < 2:
            stats["no_baseline"].append((name, periods[0]))
            continue
        stats["counted"].append((name, periods[0]))
        for rank, (cur_p, prev_p) in enumerate(zip(periods, periods[1:])):
            rows += _change_rows(c, meta[c], cur_p, prev_p, by_period[cur_p], by_period[prev_p],
                                 splits, lag=1, rank=rank)
        if len(periods) >= 3:
            rows += _change_rows(c, meta[c], periods[0], periods[2], by_period[periods[0]],
                                 by_period[periods[2]], splits, lag=2, rank=0)
    return rows, stats


def stock_signal_extras(as_of: date, filers_cfg, filings, insider_rows, e13d_rows, universe_rows,
                        insider_filters: dict | None = None):
    """Insider-cluster and activist-13D columns for /funds, using the same rules
    (and windows) as the v6 scorer so both pages agree."""
    filer_mult, filer_name, _, _ = filer_weights(filers_cfg)
    name_to_ticker = {nm(u.get("name", "")): u["ticker"] for u in universe_rows if u.get("name")}
    window_end = as_of.isoformat()
    cluster, _, ins_meta, _ = insider_clusters(
        insider_rows, (as_of - timedelta(days=INSIDER_WINDOW_DAYS)).isoformat(), window_end, insider_filters)
    filed_at = {f["id"]: f["filed_at"][:10] for f in filings}
    act, act_dates = activist_13d(e13d_rows, filed_at, name_to_ticker, filer_mult,
                                  (as_of - timedelta(days=ACTIVIST_13D_WINDOW_DAYS)).isoformat(), window_end)
    out = []
    for t in sorted(set(cluster) | set(act)):
        names = list(dict.fromkeys(m["name"] for m in ins_meta.get(t, []) if m.get("name")))
        out.append({
            "ticker": t,
            "insider_buyers": len(cluster.get(t, ())),
            "insider_names": names[:5],
            "activist_filers": list(dict.fromkeys(filer_name.get(c, c) for c, _ in act.get(t, []))),
            "activist_latest": max(act_dates[t]) if act_dates.get(t) else None,
        })
    return out
