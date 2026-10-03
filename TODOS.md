# TODOS

## Scoring

### Rebuild the v6 backtest on corrected data
**What:** Recreate the v6 backtest in-repo (ingest/backtest.py) and re-run it on holdings_13f_effective + the current insider rule.
**Why:** Weights were fit to data where hedges counted as buys and restatements hid signals.
**Pros:** Weights become checkable and reproducible. **Cons:** Multi-day; needs historical prices.
**Context:** compute_buy_signals.py:1-14 docstring describes v6. Start by porting it to scoring_rules.py pure functions over historical snapshots.
**Depends on / blocked by:** the 2026-10-03 data-correctness release.

### Make CLAUDE.md and the scorer agree
**What:** Decide the FOMO late-stage filter (CLAUDE.md §2.2 vs the "No FOMO filter" line in the compute_buy_signals.py module docstring), whether signal_weights.yml drives weights (§6.4), and whether the +5.0 multi-source bonus (`s_pat` in ingest/scoring_rules.py compute_signals) stays (§2.4). Update doc or code.
**Why:** CLAUDE.md steers every AI session in this repo. **Pros:** Removes wrong assumptions. **Cons:** Product decision; may move scores.
**Depends on / blocked by:** owner decision; ideally after the backtest TODO.

## Fund flows

### SIC fallback for industries
**What:** Fill `tickers.industry` from SEC SIC codes (data.sec.gov submissions + a `config/sic_to_industry.yml` mapping) when Yahoo leaves it blank.
**Why:** Stocks without a Yahoo industry land in the "Unclassified" row of the /funds rollup.
**Pros:** Every fund-held stock gets an industry. **Cons:** A hand-made ~400-row mapping to maintain.
**Context:** Deferred in the 2026-10-03 eng review (D2). `prices.py` saves Yahoo's label nightly. Measure first: share of fund-held stocks (rows in `fund_position_changes`) with `tickers.industry` null.
**Depends on / blocked by:** trigger when more than 10% of fund-held stocks are Unclassified. **Triggered:** measured 2026-10-04 at 14.5% (429 of 2,967 /funds stocks). Many of those are acquired or delisted names funds are exiting (MASI, CTRA, THR), which SEC data may not label either; check how many are still listed before building.

### Make /funds load in ~2 s instead of ~7 s
**What:** In `web/lib/fund-flows.ts`, fetch the 1000-row pages of `fund_flows()` in parallel (or in one call), instead of one after another.
**Why:** Each page re-runs the whole function (~1.9 s), and 2,967 rows = 3 pages, so the page takes ~7 s (measured on the preview 2026-10-04).
**Pros:** ~3× faster with no schema change. **Cons:** 3 concurrent DB calls per page view.
**Context:** PostgREST caps responses at 1000 rows, which is why the loader pages.
**Depends on / blocked by:** nothing.

### Cross-check stock splits against our own 13F data
**What:** A read-only query: holdings where a fund's share count jumped and value ÷ shares fell by the same factor between two filings, with no row in `stock_splits`.
**Why:** Catches splits Yahoo missed, including the 967 tickers the backfill excluded (`logs/backfill_splits_excluded_20261003-2249.log`). A missed split shows as every holder adding.
**Pros:** Uses data we already have. **Cons:** A split and a crash-plus-doubling look alike for one fund; needs agreement across holders.
**Context:** The split backfill ran 2026-10-03 (5,365 records, 1,813 tickers).
**Depends on / blocked by:** nothing.

### Label ETFs as "ETF" instead of Unclassified
**What:** Use `cusip_ticker_map.security_type` (from OpenFIGI) to give ETFs an "ETF" industry on /funds.
**Why:** Yahoo has no industry for ETFs (e.g. SGOV), so they sit in Unclassified.
**Depends on / blocked by:** nothing.

### Fix foreign-listing tickers on US stocks (CCL1EUR)
**What:** `cusip_ticker_map` maps Carnival Corp to `CCL1EUR` (a euro listing), so it gets no price or industry. Find other `…EUR` / `…USD` / `…GBP` codes on US-listed CUSIPs and prefer the US ticker.
**Why:** These stocks show as Unclassified on /funds and with no price elsewhere.
**Context:** Found 2026-10-04. Most of the 490 double failures in the split backfill have this shape.
**Depends on / blocked by:** nothing.

### Share-class tickers on other pages (BRK/B vs BRK-B)
**What:** /funds now uses the dash spelling (`market_symbol()` in `ingest/scoring_rules.py`). Check whether Holdings, Stocks and cost basis still join `BRK/B` to `tickers` (which has `BRK-B`) and show blank prices for the 12 share-class stocks.
**Also:** `stock_signal_extras` insider/activist columns for these stocks: Form 4 and 13D may spell them a third way (`BRK.B`); unchecked.
**Depends on / blocked by:** nothing.

### Cost basis uses split-adjusted prices with raw share counts (unverified)
**What:** `ticker_quarter_vwap` holds split-adjusted prices (NVDA Q1 2024 = $73.93; it traded ~$800 then), but `ingest/cost_basis.py` multiplies them by 13F share counts that are not adjusted. Before a split, cost basis would be ~10× too low for NVDA.
**Why:** Wrong estimated entry prices on pages that show cost basis.
**Context:** A guess from reading the code on 2026-10-04, not verified. `auto_adjust=False` in yfinance only skips dividend adjustment; splits are always applied. `stock_splits` now exists and can un-adjust.
**Depends on / blocked by:** nothing.

### Holdings page takes ~39 s in production
**What:** Measured 2026-10-04 (two loads, 39.2 s and 38.7 s). Migration 026's note says 8.5 s.
**Why:** Users wait 40 s for a page.
**Depends on / blocked by:** Not /funds work; Riya's call.

### Retire /events (Clusters) and decide on /signals
**What:** Redirect /events to the /funds insiders filter and drop it from the nav. Decide whether /signals and the nightly `compute_buy_signals` step stay (its velocity rule uses raw share ratios, so splits read as adds: `scoring_rules.py` velocity component).
**Why:** /funds replaces both (spec open item 2).
**Depends on / blocked by:** /funds checked in production.
