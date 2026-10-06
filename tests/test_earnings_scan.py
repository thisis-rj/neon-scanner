"""Earnings cut-scan logic on synthetic data — no network, no database."""
import numpy as np
import pandas as pd
import pytest

from ingest import earnings_scan as sc


def test_bh_qvalues_matches_hand_calculation():
    p = np.array([0.01, 0.04, 0.03, 0.20])
    # sorted: .01 .03 .04 .20 → ×4/rank: .04 .06 .0533 .20 → running min from the top: .04 .0533 .0533 .20
    assert sc.bh_qvalues(p) == pytest.approx([0.04, 0.05333, 0.05333, 0.20], abs=1e-4)


def test_demean_and_cut_effect():
    y = np.array([1.0, 3.0, 10.0, 14.0])
    wk = np.array([1, 1, 2, 2])
    r = sc.demean_by_week(y, wk)
    assert r.tolist() == [-1.0, 1.0, -2.0, 2.0]
    mean, t, n = sc.cut_effect(r, wk, np.array([False, True, False, True]))
    assert (mean, n) == (1.5, 2)


def synthetic(n=6000, effect=0.02, seed=1) -> pd.DataFrame:
    """Reports over 2021-10 … 2026-09; only 'busy volume' moves the reaction day."""
    rng = np.random.default_rng(seed)
    dates = pd.to_datetime("2021-10-04") + pd.to_timedelta(rng.integers(0, 5 * 365, n), unit="D")
    vol = rng.lognormal(0, 0.35, n)
    df = pd.DataFrame({
        "ticker": [f"T{i % 400}" for i in range(n)],
        "reaction_date": dates.strftime("%Y-%m-%d"),
        "week_id": dates.to_period("W").astype("int64"),
        "pre": rng.normal(0, 0.06, n),
        "patterns": [[] for _ in range(n)],
        "vol": vol, "vol_last": vol,
        "insider_buyers": rng.integers(0, 2, n),
        "ma50_gap": rng.normal(0, 0.05, n), "ma200_gap": rng.normal(0, 0.1, n),
        "session": rng.choice(["bmo", "amc"], n),
        "sector": rng.choice(["Tech", "Energy", "Health"], n),
        "surprise_pct": rng.normal(5, 10, n),
        "tier": rng.choice(["small", "mid", "large", "mega"], n),
        "prev_react": rng.normal(0, 0.05, n),
    })
    noise = lambda: rng.normal(0, 0.05, n)  # noqa: E731
    df["react"] = noise() + effect * (df.vol >= 1.25)
    df["week"] = noise()
    df["drift"] = noise()
    df["size"] = df.react.abs()
    return df


def test_scan_finds_and_confirms_a_planted_effect_and_little_noise():
    res = sc.scan(synthetic())
    head, kept = res[0], res[1:]
    assert head["tested"] > 500
    confirmed = [r for r in kept if r["verdict"] == "confirmed"]
    assert any(r["cut"] == ("vol_high",) and r["outcome"] == "react" for r in confirmed)
    assert all(r["search_effect"] > 0 for r in confirmed if r["outcome"] == "react")
    # pure-noise outcomes: nothing confirmed for the first week or the drift
    assert not [r for r in confirmed if r["outcome"] in ("week", "drift")]


def test_scan_pure_noise_confirms_nothing():
    res = sc.scan(synthetic(effect=0.0, seed=7))
    assert not [r for r in res[1:] if r["verdict"] == "confirmed"]


def test_eps_conditions_only_score_the_drift():
    res = sc.scan(synthetic())
    eps_rows = [r for r in res[1:] if any(k.startswith("eps_") for k in r["cut"])]
    assert all(r["outcome"] == "drift" for r in eps_rows)


def test_shape_patterns_match_page_rules():
    assert sc.shape_patterns([0.01, 0.01, 0.01, -0.001]) == ["up_days"]
    assert "drop_last" in sc.shape_patterns([0, 0, -0.04])
    assert sc.shape_patterns([0.01, float("nan")]) == []


def test_entry_mode_uses_only_information_known_at_entry():
    # 61-day path: +1% on day -2 only (after a day -5 entry). SPY flat.
    path = [0] * 61
    path[30 - 2] = 1000
    spy = [{"date": d.strftime("%Y-%m-%d"), "ret": 0.0} for d in pd.bdate_range("2024-01-01", "2024-06-28")]
    ev = {"ticker": "X", "reaction_date": spy[60]["date"], "path": path, "vol_path": None, "session": "amc",
          "sector": "Tech", "surprise_pct": 1.0, "insider_buyers": 0, "ma50_gap": 0.2, "ma200_gap": 0.3,
          "mcap_at_report": 5e9}
    d = sc.features([ev], spy, entry=5)
    r = d.iloc[0]
    assert r.skip == pytest.approx(0.01) and r.through == pytest.approx(0.01)   # held days -4..-1 / -4..0
    assert r.pre == pytest.approx(0.0)                                          # days -14..-5: before the jump
    assert pd.isna(r.ma50_gap) and pd.isna(r.ma200_gap)                         # measured after entry: dropped
