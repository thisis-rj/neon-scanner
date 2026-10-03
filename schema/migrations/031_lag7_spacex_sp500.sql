-- Lag7: SpaceX joins the ranking "on what it has", and the benchmark becomes
-- the S&P 500 total return index (^SP500TR) instead of SPY.
--
-- SpaceX (SPCX) listed 2026-06-12, so its 6- and 12-month returns don't exist
-- yet: those columns become nullable. A null rank is left out of avg_rank.

alter table mag7_ranks alter column ret_6m drop not null;
alter table mag7_ranks alter column ret_12m drop not null;
alter table mag7_ranks alter column rank_6m drop not null;
alter table mag7_ranks alter column rank_12m drop not null;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'mag7_equity' and column_name = 'spy') then
    alter table mag7_equity rename column spy to sp500;
  end if;
end$$;
