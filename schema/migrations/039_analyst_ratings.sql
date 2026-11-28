-- Analyst rating / price-target changes (free Yahoo feed, firm-level — Yahoo
-- does not name the individual analyst) and each firm's target track record.
-- Written by ingest/analyst_ratings.py; read by /my-stocks and the daily report.
--
-- Track record = share of a firm's price targets reached within 12 months,
-- per Yahoo industry and overall. Shown as context only: tested Nov 2026, a
-- firm's past hit rate did NOT predict its later hit rate (2018-22 vs 2023-25).

create table if not exists analyst_calls (
  ticker        text not null,
  firm          text not null,
  graded_at     timestamptz not null,
  action        text,            -- up / down / main / reit / init
  to_grade      text,
  from_grade    text,
  pt_action     text,            -- Raises / Lowers / Maintains / Announces
  price_target  numeric,
  prior_target  numeric,
  fetched_at    timestamptz not null default now(),
  primary key (ticker, firm, graded_at)
);
create index if not exists analyst_calls_graded_idx on analyst_calls (graded_at desc);
create index if not exists analyst_calls_ticker_idx on analyst_calls (ticker, graded_at desc);
alter table analyst_calls enable row level security;

create table if not exists analyst_firm_records (
  firm           text not null,
  scope          text not null,   -- Yahoo industry, or 'ALL'
  targets        int not null,    -- targets old enough to judge (12m elapsed)
  hit_rate       numeric not null,
  hit_when_fell  numeric,         -- hit rate on targets where the stock fell over the 12m
  scope_avg      numeric,         -- all firms' hit rate in the same scope
  first_call     date,
  computed_at    timestamptz not null default now(),
  primary key (firm, scope)
);
alter table analyst_firm_records enable row level security;
