-- Earnings test: company size at report time + how each stock entered the
-- backtest, so /earnings-test can cut by small / mid / large / mega cap.
-- Also lets earnings_test_summary hold the cut-scan results ('scan').

alter table earnings_test_events
  add column if not exists mcap_at_report numeric,  -- today's market cap × close[R-1] / latest close (approximate: ignores share-count changes)
  add column if not exists sample text;             -- how the stock entered the backtest: top300 / random_small / random_mid / random_large / mega_all

alter table earnings_test_summary drop constraint if exists earnings_test_summary_cohort_check;
alter table earnings_test_summary add constraint earnings_test_summary_cohort_check
  check (cohort in ('backtest', 'live', 'scan'));
