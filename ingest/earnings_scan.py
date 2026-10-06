"""Earnings test — scan many cuts for a link between pre-report information and the move after.

Vijay asked to "run a bunch of analysis and find where there is a correlation".
Trying ~1,000 cuts finds ~50 that look significant by chance alone, so the scan
is a two-step study (CLAUDE.md §2.2 note on the earnings test):

  1. Search half (reports before SPLIT_DATE): test every cut. Keep the ones that
     pass a false-discovery-rate correction (Benjamini–Hochberg, q < FDR_Q):
     at most ~10% of kept cuts are expected to be flukes.
  2. Check half (SPLIT_DATE on): re-test only the kept cuts, once.
     'confirmed' = same direction and p < 0.05 / (number kept) (Bonferroni);
     'same direction' = same direction and p < 0.05; else 'did not hold'.

A cut = one condition, or two conditions from different families (size tier,
move before, shape before, volume, insiders, trend, report time, sector,
previous reaction; EPS surprise only for the after-report drift, because it is
known only once the report is out).

Effect = how much the cut's outcome beat OTHER reports whose reaction fell in
the same week (outcome minus that week's average), so a cut can't win just by
landing in a strong week. Standard errors are clustered by week (reports in
the same week move together). Outcomes are minus SPY.

Usage:
  python -m ingest.earnings_scan             # scan, print, save to earnings_test_summary ('scan')
  python -m ingest.earnings_scan --dry-run   # scan and print only
  python -m ingest.earnings_scan --csv out.csv
"""
from __future__ import annotations

import argparse
import math
import os
from datetime import date, datetime, timezone
from itertools import combinations

import numpy as np
import pandas as pd

from ingest import earnings_test as et

SPLIT_DATE = "2024-04-01"   # search half before, check half from (reaction date)
FDR_Q = 0.10
MIN_N = 60                  # reports a cut needs in EACH half to be tested
PRE = (-10, -1)             # the before window for move / shape / volume conditions
OUTCOMES = {
    "react": "Reaction day",
    "week": "First week (day 0–4)",
    "drift": "Next 20 days (day 1–20)",
    "size": "Size of reaction-day move",
}


# ── Pure logic (tested in tests/test_earnings_scan.py) ────────────────────────

def bh_qvalues(p: np.ndarray) -> np.ndarray:
    """Benjamini–Hochberg q-values (same order as p)."""
    n = len(p)
    if n == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(q, 1.0)
    return out


def norm_p(t: float) -> float:
    """Two-sided p-value of a z/t statistic (normal approximation)."""
    return math.erfc(abs(t) / math.sqrt(2))


def cut_effect(resid: np.ndarray, week: np.ndarray, mask: np.ndarray) -> tuple[float, float, int]:
    """(mean week-demeaned outcome in the cut, week-clustered t, n). `resid` is already demeaned by week."""
    r, w = resid[mask], week[mask]
    n = len(r)
    if n < 2:
        return float("nan"), float("nan"), n
    mean = float(r.mean())
    sums = pd.Series(r - mean).groupby(w).sum().to_numpy()
    se = math.sqrt(float((sums ** 2).sum())) / n
    return mean, (mean / se if se > 0 else float("nan")), n


def demean_by_week(y: np.ndarray, week: np.ndarray) -> np.ndarray:
    s = pd.Series(y)
    return (s - s.groupby(week).transform("mean")).to_numpy()


def conditions(df: pd.DataFrame) -> dict[str, tuple[str, str, np.ndarray]]:
    """{key: (family, label, mask)} — every single condition, from columns built by features()."""
    c: dict[str, tuple[str, str, np.ndarray]] = {}

    def add(key, fam, label, mask):
        c[key] = (fam, label, np.asarray(mask.fillna(False) if isinstance(mask, pd.Series) else mask, dtype=bool))

    for t in ["small", "mid", "large", "mega"]:
        add(f"tier_{t}", "size", f"{t.capitalize()} cap", df.tier == t)
    x = df.pre
    add("pre_fell_big", "move", "Fell >10% in 10 days before", x < -0.10)
    add("pre_fell", "move", "Fell 3–10% before", (x >= -0.10) & (x < -0.03))
    add("pre_flat", "move", "Within ±3% before", x.abs() < 0.03)
    add("pre_rose", "move", "Rose 3–10% before", (x >= 0.03) & (x < 0.10))
    add("pre_rose_big", "move", "Rose >10% before", x >= 0.10)
    for k, label in [("up_days", "Rose most days"), ("down_days", "Fell most days"),
                     ("jump_last", "Jumped >3% day before"), ("drop_last", "Dropped >3% day before"),
                     ("dip_recover", "Dipped then recovered"), ("rally_fade", "Rallied then faded"),
                     ("quiet", "Quiet run-up")]:
        add(f"shape_{k}", "shape", label, df.patterns.apply(lambda p, k=k: k in p))
    v = df.vol
    add("vol_low", "volume", "Volume <0.8× normal", v < 0.8)
    add("vol_high", "volume", "Volume ≥1.25× normal", v >= 1.25)
    add("vol_vhigh", "volume", "Volume ≥2× normal", v >= 2)
    add("vol_spike", "volume", "Day-before volume ≥2× normal", df.vol_last >= 2)
    add("ins_any", "insiders", "Insider bought (90d)", df.insider_buyers > 0)
    add("ins_2", "insiders", "2+ insiders bought (90d)", df.insider_buyers >= 2)
    add("ma50_up", "trend", "Above 50-day avg", df.ma50_gap > 0)
    add("ma50_down", "trend", "Below 50-day avg", df.ma50_gap <= 0)
    add("ma200_up", "trend", "Above 200-day avg", df.ma200_gap > 0)
    add("ma200_down", "trend", "Below 200-day avg", df.ma200_gap <= 0)
    add("sess_bmo", "time", "Reported before open", df.session != "amc")
    add("sess_amc", "time", "Reported after close", df.session == "amc")
    for sec in sorted(df.sector.dropna().unique()):
        add(f"sec_{sec}", "sector", sec, df.sector == sec)
    add("prev_up", "previous", "Last report jumped >5%", df.prev_react > 0.05)
    add("prev_down", "previous", "Last report dropped >5%", df.prev_react < -0.05)
    s = df.surprise_pct
    add("eps_miss", "eps", "Missed EPS estimate", s < 0)
    add("eps_big", "eps", "Beat EPS by 15%+", s >= 15)
    return c


def cuts(conds: dict[str, tuple[str, str, np.ndarray]]):
    """Singles, then pairs from different families. EPS conditions only pair/score with 'drift'."""
    keys = list(conds)
    for k in keys:
        yield (k,)
    for a, b in combinations(keys, 2):
        if conds[a][0] != conds[b][0]:
            yield (a, b)


def scan(df: pd.DataFrame) -> list[dict]:
    """Two-step scan over all cuts × outcomes. df: one row per report from features()."""
    conds = conditions(df)
    week = df.week_id.to_numpy()
    search = (df.reaction_date < SPLIT_DATE).to_numpy()
    check = ~search
    resid = {o: demean_by_week(df[o].to_numpy(dtype=float), week) for o in OUTCOMES}
    valid = {o: ~np.isnan(df[o].to_numpy(dtype=float)) for o in OUTCOMES}
    base_up = {o: float((df[o] > 0).mean()) for o in OUTCOMES}

    rows = []
    for cut in cuts(conds):
        mask = np.logical_and.reduce([conds[k][2] for k in cut])
        has_eps = any(conds[k][0] == "eps" for k in cut)
        for o in OUTCOMES:
            if has_eps and o != "drift":
                continue
            m = mask & valid[o]
            if (m & search).sum() < MIN_N or (m & check).sum() < MIN_N:
                continue
            e1, t1, n1 = cut_effect(resid[o][search & valid[o]], week[search & valid[o]], m[search & valid[o]])
            rows.append({"cut": cut, "label": " + ".join(conds[k][1] for k in cut), "outcome": o,
                         "search_effect": e1, "search_t": t1, "search_n": n1, "search_p": norm_p(t1),
                         "_mask": m})
    if not rows:
        return []
    q = bh_qvalues(np.array([r["search_p"] for r in rows]))
    kept = [r for r, qq in zip(rows, q) if qq < FDR_Q]
    for r, qq in zip(rows, q):
        r["search_q"] = float(qq)
    k = max(len(kept), 1)
    for r in kept:
        o, m = r["outcome"], r["_mask"]
        e2, t2, n2 = cut_effect(resid[o][check & valid[o]], week[check & valid[o]], m[check & valid[o]])
        p2 = norm_p(t2)
        same = np.sign(e2) == np.sign(r["search_effect"])
        r.update({"check_effect": e2, "check_t": t2, "check_n": n2, "check_p": p2,
                  "verdict": "confirmed" if same and p2 < 0.05 / k else
                             "same direction" if same and p2 < 0.05 else "did not hold"})
        ys = df[o].to_numpy(dtype=float)[m]
        r["up_share"] = float((ys > 0).mean()) if o != "size" else None
        r["base_up"] = base_up[o] if o != "size" else None
    for r in rows:
        r.pop("_mask", None)
    kept.sort(key=lambda r: ({"confirmed": 0, "same direction": 1, "did not hold": 2}[r["verdict"]], r["search_q"]))
    return [{"tested": len(rows), "kept": len(kept)}] + kept


# ── Data ──────────────────────────────────────────────────────────────────────

def features(events: list[dict], spy: list[dict]) -> pd.DataFrame:
    """One row per measured report: outcomes (minus SPY) and every condition's inputs."""
    sd = [str(s["date"]) for s in spy]
    sr = np.array([float(s["ret"]) for s in spy])
    at = {d: i for i, d in enumerate(sd)}
    recs = []
    for e in events:
        i = at.get(str(e["reaction_date"]))
        if i is None or not e.get("path"):
            continue
        stock = np.array([np.nan if v is None else v / 1e5 for v in e["path"]])
        spyp = np.array([sr[i + k - 30] if 0 <= i + k - 30 < len(sr) else np.nan for k in range(61)])
        win = lambda arr, a, b: float(np.prod(1 + arr[a + 30:b + 31]) - 1)  # noqa: E731
        ex = lambda a, b: win(stock, a, b) - win(spyp, a, b)  # noqa: E731
        days = list(stock[PRE[0] + 30:PRE[1] + 31] - spyp[PRE[0] + 30:PRE[1] + 31])
        v = e.get("vol_path") or None
        vv = [x for x in (v[PRE[0] + 30:PRE[1] + 31] if v else []) if x is not None]
        cap = e.get("mcap_at_report")
        tier = None
        if cap:
            cap = float(cap)
            tier = next((t for t, (lo, hi) in et.TIERS.items() if lo <= cap < hi), "micro" if cap < 3e8 else None)
        react = ex(0, 0)
        recs.append({
            "ticker": e["ticker"], "reaction_date": str(e["reaction_date"]),
            "week_id": pd.Timestamp(str(e["reaction_date"])).to_period("W").ordinal,  # calendar week
            "pre": ex(*PRE), "react": react, "week": ex(0, 4), "drift": ex(1, 20),  # 'week' = first-week outcome
            "patterns": shape_patterns(days),
            "vol": float(np.mean(vv)) / 100 if vv else np.nan,
            "vol_last": (v[29] / 100) if v and v[29] is not None else np.nan,
            "insider_buyers": e.get("insider_buyers"), "ma50_gap": _f(e.get("ma50_gap")),
            "ma200_gap": _f(e.get("ma200_gap")), "session": e.get("session"), "sector": e.get("sector"),
            "surprise_pct": _f(e.get("surprise_pct")), "tier": tier,
        })
    df = pd.DataFrame(recs)
    if df.empty:
        return df
    df["size"] = df.react.abs()
    df = df.sort_values(["ticker", "reaction_date"]).reset_index(drop=True)
    df["prev_react"] = df.groupby("ticker").react.shift(1)
    df["insider_buyers"] = pd.to_numeric(df.insider_buyers)
    return df


def shape_patterns(days: list[float]) -> list[str]:
    """Same shape rules as the page (web/lib/earnings-explore.ts patternsOf)."""
    n = len(days)
    if n == 0 or any(np.isnan(d) for d in days):
        return []
    comp = lambda xs: float(np.prod([1 + d for d in xs]) - 1)  # noqa: E731
    out = []
    ups, downs = sum(d > 0 for d in days), sum(d < 0 for d in days)
    if n >= 3 and ups / n >= 0.7:
        out.append("up_days")
    if n >= 3 and downs / n >= 0.7:
        out.append("down_days")
    if days[-1] > 0.03:
        out.append("jump_last")
    if days[-1] < -0.03:
        out.append("drop_last")
    if n >= 4:
        h = n // 2
        a, b = comp(days[:h]), comp(days[h:])
        if a < 0 < b:
            out.append("dip_recover")
        if a > 0 > b:
            out.append("rally_fade")
    if abs(comp(days)) < 0.02 and all(abs(d) <= 0.02 for d in days):
        out.append("quiet")
    return out


def _f(v):
    return None if v is None else float(v)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--csv")
    args = ap.parse_args()

    from supabase import create_client

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    events = et.fetch_all(sb, "earnings_test_events",
                          "ticker,reaction_date,session,sector,surprise_pct,path,vol_path,ma50_gap,ma200_gap,"
                          "insider_buyers,mcap_at_report,status", source="backtest")
    events = [e for e in events if e["status"] in ("reacted", "complete")]
    spy = et.fetch_all(sb, "earnings_test_spy", "date,ret", order=("date",))
    df = features(events, spy)
    print(f"reports {len(df)}; by size tier: {df.tier.value_counts(dropna=False).to_dict()}")
    res = scan(df)
    head, kept = res[0], res[1:]
    print(f"cut × outcome tests: {head['tested']}; kept by the search half (q < {FDR_Q}): {head['kept']}")
    for r in kept:
        fmt = (lambda v: f"{v:+.2%}")
        print(f"  [{r['verdict']:<15}] {OUTCOMES[r['outcome']]:<26} {r['label']:<60} "
              f"search {fmt(r['search_effect'])} (t {r['search_t']:+.1f}, n {r['search_n']}, q {r['search_q']:.3f}) | "
              f"check {fmt(r['check_effect'])} (t {r['check_t']:+.1f}, n {r['check_n']})")
    if args.csv:
        pd.DataFrame(kept).to_csv(args.csv, index=False)
    if not args.dry_run:
        out = {"tested": head["tested"], "kept": kept, "split": SPLIT_DATE, "fdr_q": FDR_Q, "min_n": MIN_N,
               "reports": len(df), "tiers": {str(k): int(v) for k, v in df.tier.value_counts().items()},
               "computed": datetime.now(timezone.utc).isoformat()}
        for r in out["kept"]:
            r["cut"] = list(r["cut"])
        sb.table("earnings_test_summary").upsert({"cohort": "scan", "data": out, "computed_at": out["computed"]},
                                                 on_conflict="cohort").execute()


if __name__ == "__main__":
    main()
