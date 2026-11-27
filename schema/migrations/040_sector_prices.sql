-- Daily closes for the /sectors overlay chart (Bitcoin, gold, silver and
-- sector ETFs). Written by ingest/sector_prices.py (yahoo job); the page
-- indexes each line to % change from the first day of the chosen range.
create table if not exists sector_prices (
  symbol  text not null,   -- Yahoo symbol, e.g. BTC-USD, GC=F, SMH
  date    date not null,
  close   numeric not null,
  primary key (symbol, date)
);
alter table sector_prices enable row level security;
