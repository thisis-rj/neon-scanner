-- Insider role on Form 4 events (who sold/bought: Director, CFO, 10% owner…).
-- Written by ingest/parse_form4.py from <reportingOwnerRelationship>; read by
-- /my-stocks "Signals on your stocks" sell lists. Old rows are null until reparsed
-- (parse_form4 --tickers … --since …).
alter table events_form4
  add column if not exists officer_title text,
  add column if not exists is_director boolean,
  add column if not exists is_officer boolean,
  add column if not exists is_ten_pct boolean;
