-- Earnings test: does a stock's 10-day move BEFORE an earnings report predict
-- its move AFTER? Powers /earnings-test. See the CLAUDE.md §2.2 note on the
-- earnings test (a §8 backtest exception the user approved 2026-10-06).
--
-- Written by ingest/earnings_test.py. Windows (fixed; see the module docstring):
--   reaction day R = first session that can react (report day if before the
--   open / intraday, next trading day if after the close)
--   pre-move = close[R-1] / close[R-11] - 1, reaction = close[R] / close[R-1] - 1,
--   drift = close[R+20] / close[R] - 1; each also for SPY; excess = stock - SPY.
-- Measured rows are never re-measured. (032 is reserved for the parked
-- page-loaders plan.)

create table if not exists earnings_test_events (
  ticker          text not null,
  scheduled_date  date not null,       -- live: Yahoo's date when logged; backtest: the report date
  source          text not null check (source in ('backtest', 'live', 'late')),
                                       -- late = a live row logged after its reaction session opened
  status          text not null check (status in
                    ('scheduled', 'reported', 'reacted', 'complete', 'excluded', 'no_report')),
  note            text,                -- why a row is excluded / no_report
  registered_at   timestamptz not null default now(),
  report_ts       timestamptz,         -- actual report time from Yahoo
  report_date     date,
  session         text check (session in ('bmo', 'intraday', 'amc', 'unknown')),
  eps_estimate    numeric,
  eps_actual      numeric,
  surprise_pct    numeric,
  reaction_date   date,
  pre_start       date,                -- close[R-11]
  pre_ret         numeric,             -- fractions; 0.03 = +3%
  pre_spy         numeric,
  pre_excess      numeric,
  react_ret       numeric,
  react_spy       numeric,
  react_excess    numeric,
  drift_end       date,                -- close[R+20]
  drift_ret       numeric,
  drift_spy       numeric,
  drift_excess    numeric,
  sector          text,                -- Yahoo sector from `tickers` when logged
  path            jsonb,               -- daily returns at days R-30..R+30 (61 ints, units of 0.001%; null = not traded)
  measured_at     timestamptz,
  primary key (ticker, scheduled_date)
);

create index if not exists earnings_test_events_status_idx on earnings_test_events (status);
create index if not exists earnings_test_events_source_date_idx on earnings_test_events (source, scheduled_date desc);

-- SPY daily returns (fraction) for the explorer's excess-return math.
create table if not exists earnings_test_spy (
  date  date primary key,
  ret   numeric not null
);

-- One row per cohort ('backtest', 'live'): the season-by-season quintile score.
create table if not exists earnings_test_summary (
  cohort       text primary key check (cohort in ('backtest', 'live')),
  data         jsonb not null,
  computed_at  timestamptz not null default now()
);

alter table earnings_test_events enable row level security;
alter table earnings_test_summary enable row level security;
alter table earnings_test_spy enable row level security;
do $$
declare t text;
begin
  foreach t in array array['earnings_test_events', 'earnings_test_summary', 'earnings_test_spy'] loop
    if not exists (select 1 from pg_policies where policyname = 'auth_read_' || t) then
      execute format('create policy %I on %I for select using (auth.role() = ''authenticated'')', 'auth_read_' || t, t);
    end if;
  end loop;
end$$;
