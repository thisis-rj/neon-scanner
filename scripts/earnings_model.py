"""Earnings test — can ANY combination of pre-entry signals pick the buy-before-earnings winners?

Enumerating cuts (ingest/earnings_scan.py) stops at small combinations: groups of 3+ signals get
too few reports to judge. This script instead lets a gradient-boosted tree model find
combinations of any depth, trained ONLY on the search half (reaction before SPLIT_DATE), then
scores its picks once on the check half it never saw. Settings are fixed in code, not tuned on
the check half. A placebo run (outcomes shuffled within each week) shows what "no signal" looks like.

Trade (same as earnings_scan --entry): buy at the close X days before day 0, sell at day -1 /
day 0 / day +5; inputs are only what is known at the entry close. Outcome = hold return minus
SPY, minus the average of other reports that week (so a pick can't win by landing in a good week).

Score on the check half, per week with 10+ reports: rank correlation of prediction vs outcome
(IC), and the model's top 20% minus bottom 20%. Averaged over weeks; t = mean / (sd / √weeks).
9 models (3 entries × 3 exits) are tested, so |t| > 2.8 is needed (Bonferroni, 5%).

Needs scikit-learn, which is NOT in requirements.txt (research only):
  python -m venv /tmp/mlvenv && /tmp/mlvenv/bin/pip install scikit-learn pandas numpy python-dotenv supabase
  /tmp/mlvenv/bin/python scripts/earnings_model.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ingest import earnings_scan as sc  # noqa: E402
from ingest import earnings_test as et  # noqa: E402

ENTRIES = (10, 5, 3)
EXITS = {"skip": "sell day before", "through": "sell after reaction", "after5": "sell 5 days after"}
SEED = 20261007
SHAPES = ["up_days", "down_days", "jump_last", "drop_last", "dip_recover", "rally_fade", "quiet"]


def design(df: pd.DataFrame, sectors: list[str]) -> pd.DataFrame:
    """Numeric inputs, all known at the entry close."""
    x = pd.DataFrame({
        "pre": df.pre, "vol": df.vol, "vol_last": df.vol_last,
        "insiders": df.insider_buyers.astype(float), "prev_react": df.prev_react,
        "amc": (df.session == "amc").astype(float),
    })
    for t in ["small", "mid", "large", "mega"]:
        x[f"tier_{t}"] = (df.tier == t).astype(float)
    for s in sectors:
        x[f"sec_{s}"] = (df.sector == s).astype(float)
    for p in SHAPES:
        x[f"shape_{p}"] = df.patterns.apply(lambda ps, p=p: p in ps).astype(float)
    return x


def weekly_scores(pred: np.ndarray, y: np.ndarray, week: np.ndarray) -> dict:
    """Per week (10+ reports): rank IC and top-20% minus bottom-20% outcome. Mean, t over weeks."""
    ics, spreads, top_all = [], [], []
    for w in np.unique(week):
        m = week == w
        if m.sum() < 10:
            continue
        p, o = pd.Series(pred[m]), pd.Series(y[m])
        ics.append(p.rank().corr(o.rank()))
        lo, hi = p.quantile(0.2), p.quantile(0.8)
        spreads.append(o[p >= hi].mean() - o[p <= lo].mean())
        top_all.append(o[p >= hi].mean())

    def mt(v):
        v = np.array([a for a in v if not np.isnan(a)])
        return float(v.mean()), float(v.mean() / (v.std(ddof=1) / np.sqrt(len(v)))), len(v)

    ic, ict, n = mt(ics)
    sp, spt, _ = mt(spreads)
    top, topt, _ = mt(top_all)
    return {"ic": ic, "ic_t": ict, "weeks": n, "spread": sp, "spread_t": spt, "top": top, "top_t": topt}


def main() -> None:
    from sklearn.ensemble import HistGradientBoostingRegressor
    from supabase import create_client

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SECRET_KEY"])
    events = [e for e in et.fetch_all(sb, "earnings_test_events",
                                      "ticker,reaction_date,session,sector,surprise_pct,path,vol_path,ma50_gap,"
                                      "ma200_gap,insider_buyers,mcap_at_report,status", source="backtest")
              if e["status"] in ("reacted", "complete")]
    spy = et.fetch_all(sb, "earnings_test_spy", "date,ret", order=("date",))
    rng = np.random.default_rng(SEED)
    print(f"reports {len(events)}; train on reactions before {sc.SPLIT_DATE}, score after; "
          f"|t| > 2.8 needed (9 models)\n")
    print(f"{'trade':<34}{'weeks':>6}{'rank IC':>9}{'t':>6}  {'top20−bottom20':>15}{'t':>6}  "
          f"{'top20 vs week':>14}{'t':>6}   placebo IC (t)")
    for x in ENTRIES:
        df = sc.features(events, spy, entry=x)
        sectors = sorted(df.sector.dropna().unique())
        X = design(df, sectors)
        search = (df.reaction_date < sc.SPLIT_DATE).to_numpy()
        week = df.week_id.to_numpy()
        for o, name in EXITS.items():
            y = df[o].astype(float)
            y = (y - y.groupby(df.week_id).transform("mean")).to_numpy()  # vs same-week reports
            ok = ~np.isnan(y)
            tr, te = search & ok, ~search & ok
            model = HistGradientBoostingRegressor(
                max_depth=3, learning_rate=0.03, max_iter=400, min_samples_leaf=100, l2_regularization=1.0,
                early_stopping=True, validation_fraction=0.2, n_iter_no_change=30, random_state=SEED,
            )
            # Clip extreme outcomes for training only (a few ±50% moves would dominate the fit).
            lo, hi = np.nanpercentile(y[tr], [1, 99])
            model.fit(X[tr], np.clip(y[tr], lo, hi))
            s = weekly_scores(model.predict(X[te]), y[te], week[te])
            # Placebo: shuffle outcomes within each training week, refit, score the same way.
            yp = y.copy()
            for w in np.unique(week[tr]):
                idx = np.where(tr & (week == w))[0]
                yp[idx] = yp[rng.permutation(idx)]
            model.fit(X[tr], np.clip(yp[tr], lo, hi))
            p = weekly_scores(model.predict(X[te]), y[te], week[te])
            print(f"buy -{x:<2} {name:<26}{s['weeks']:>6}{s['ic']:>+9.3f}{s['ic_t']:>+6.1f}  "
                  f"{s['spread']:>+14.2%}{s['spread_t']:>+6.1f}  {s['top']:>+13.2%}{s['top_t']:>+6.1f}   "
                  f"{p['ic']:+.3f} ({p['ic_t']:+.1f})")


if __name__ == "__main__":
    main()
