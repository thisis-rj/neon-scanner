-- Earnings test: analyst actions and open/high/low context per report, for
-- cohorts and the cut scan (CLAUDE.md §2.2 note on the earnings test).
-- Written by ingest/earnings_test.py (--enrich, then the nightly step).

alter table earnings_test_events
  -- [k, code, pt] per analyst action in the 63 trading days before day 0: k = trading day it became
  -- public (after 16:00 ET → next day), code = up / down / init / main, pt = price-target change (fraction) or null
  add column if not exists analyst jsonb,
  -- [gap, range] for days R-30..R-1 in units of 0.001%: gap = open / previous close - 1,
  -- range = (high - low) / close
  add column if not exists ohlc_path jsonb;
