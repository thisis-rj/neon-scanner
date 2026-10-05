-- Earnings test: pre-report context per report, for cohorts on /earnings-test
-- (CLAUDE.md §2.2 note on the earnings test). Written by ingest/earnings_test.py
-- (--enrich once, then the nightly step). All of it is known before the report.

alter table earnings_test_events
  add column if not exists vol_path        jsonb,    -- volume on days R-30..R-1, % of normal (avg of the 60 trading days before R-30)
  add column if not exists ma50_gap        numeric,  -- close[R-1] / 50-day average ending R-1, minus 1
  add column if not exists ma200_gap       numeric,  -- same for 200 days
  add column if not exists insider_buyers  int,      -- distinct insiders with open-market buys FILED in the 90 days before the report
  add column if not exists insider_buy_usd numeric;  -- their total $
