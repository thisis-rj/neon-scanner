# TODOS

## Scoring

### Rebuild the v6 backtest on corrected data
**What:** Recreate the v6 backtest in-repo (ingest/backtest.py) and re-run it on holdings_13f_effective + the current insider rule.
**Why:** Weights were fit to data where hedges counted as buys and restatements hid signals.
**Pros:** Weights become checkable and reproducible. **Cons:** Multi-day; needs historical prices.
**Context:** compute_buy_signals.py:1-14 docstring describes v6. Start by porting it to scoring_rules.py pure functions over historical snapshots.
**Depends on / blocked by:** the 2026-10-03 data-correctness release.

### Make CLAUDE.md and the scorer agree
**What:** Decide the FOMO late-stage filter (CLAUDE.md §2.2 vs compute_buy_signals.py:13), whether signal_weights.yml drives weights (§6.4), and whether the +5.0 multi-source bonus (compute_buy_signals.py) stays (§2.4). Update doc or code.
**Why:** CLAUDE.md steers every AI session in this repo. **Pros:** Removes wrong assumptions. **Cons:** Product decision; may move scores.
**Depends on / blocked by:** owner decision; ideally after the backtest TODO.
