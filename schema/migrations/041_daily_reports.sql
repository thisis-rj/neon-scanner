-- One saved daily report per person per day. Built by ingest/daily_report.py
-- (daily-report.yml, 13:00 UTC = 6:30 PM IST, Mon-Fri), shown at
-- /report/<date>-<person> and summarised in the WhatsApp message.
create table if not exists daily_reports (
  person       text not null,          -- 'Riya' / 'Vijay' (portfolio_positions.person)
  report_date  date not null,          -- IST date the report was built for
  window_start timestamptz not null,   -- items since this moment are "new"
  built_at     timestamptz not null default now(),
  summary      jsonb not null,         -- the 5 WhatsApp lines {market, insider, shorts, ratings, earnings}
  content      jsonb not null,         -- full report sections for the page
  sent_at      timestamptz,            -- WhatsApp accepted the message
  primary key (person, report_date)
);
alter table daily_reports enable row level security;
