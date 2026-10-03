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
    """(cik, ticker) → [(period, shares, filed_at), ...] in filing order."""
    traj = {}
    for c, fs in f13f.items():
        for f in sorted(fs, key=lambda x: x.get("period_of_report") or x["filed_at"]):
            for t, sh in holdings.get(f["id"], {}).items():
                traj.setdefault((c, t), []).append(
                    (f.get("period_of_report") or f["filed_at"][:10], sh, f["filed_at"][:10])
                )
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

def insider_clusters(insider_rows, window_start: str, window_end: str):
    """Distinct insider buyers per ticker whose trade and filing fall in the window."""
    ins_cluster = defaultdict(set)
    ins_dates = defaultdict(list)
    ins_meta = defaultdict(list)
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
        ins_cluster[t].add(r["reporter_cik"])
        ins_dates[t].append(fa)
        ins_meta[t].append({"name": r.get("reporter_name"), "value": r.get("value_usd"), "date": td})
    return ins_cluster, ins_dates, ins_meta


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

    ins_cluster, ins_dates, ins_meta = insider_clusters(
        insider_rows, (as_of - timedelta(days=INSIDER_WINDOW_DAYS)).isoformat(), window_end
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
                "insider_cluster": {"n": len(ins_cluster.get(t, set())), "score": round(ins_score, 2)},
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
