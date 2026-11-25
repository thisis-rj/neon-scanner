-- Was this Form 4 trade made under a pre-arranged Rule 10b5-1 plan?
-- true = planned (routine), false = not planned (insider chose the timing),
-- null = form predates the checkbox (Apr 2023) and no plan footnote found.
-- Written by ingest/parse_form4.py; read by /my-stocks insider lists.
alter table events_form4
  add column if not exists is_10b5_1 boolean;
