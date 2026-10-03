-- holdings_13f_effective becomes a stored (materialized) copy of the rule.
--
-- WHY: as a plain view (migration 023) every read re-evaluated the whole
-- rule. The Holdings page reads holdings_recent(2) in 24 pages of 1,000 rows,
-- so the rule ran 24 times per page load: measured on production 2026-10-03,
-- 23 s vs 8.5 s for the table-based RPC before 023. Readers page the Stocks
-- page and the nightly jobs the same way.
--
-- The rule itself is unchanged and lives on as holdings_13f_effective_live.
-- Every reader keeps the name holdings_13f_effective and now reads the stored
-- copy, which is refreshed by refresh_holdings_effective() after anything
-- writes holdings_13f (ingest/parse_13f.py, ingest/backfill_tickers.py) and
-- once in the release runbook. Until a refresh, readers see the previous
-- night's holdings, as they would have without the new filings anyway.

-- Re-runnable: only rename while holdings_13f_effective is still the plain view.
do $$
begin
  if exists (select 1 from pg_views where schemaname = 'public' and viewname = 'holdings_13f_effective') then
    alter view holdings_13f_effective rename to holdings_13f_effective_live;
  end if;
end $$;

create materialized view if not exists holdings_13f_effective as
  select * from holdings_13f_effective_live;

-- id is unique (holdings_13f primary key): required for REFRESH ... CONCURRENTLY,
-- which keeps readers working during a refresh.
create unique index if not exists holdings_13f_effective_id_idx on holdings_13f_effective (id);
create index if not exists holdings_13f_effective_cik_period_idx on holdings_13f_effective (cik, period_of_report);
create index if not exists holdings_13f_effective_period_id_idx on holdings_13f_effective (period_of_report desc, id);

comment on materialized view holdings_13f_effective is
  'Stored copy of holdings_13f_effective_live (the rule, migration 023). Refresh with refresh_holdings_effective().';

-- Service-role only: a refresh is a write.
create or replace function refresh_holdings_effective()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view concurrently holdings_13f_effective;
end;
$$;

revoke all on function refresh_holdings_effective() from public, anon, authenticated;
grant execute on function refresh_holdings_effective() to service_role;

-- holdings_recent() already names holdings_13f_effective; recreate it so the
-- definition on record matches what it reads.
create or replace function holdings_recent(max_periods int default 2)
returns table (
  cik               text,
  period_of_report  date,
  cusip             text,
  ticker            text,
  issuer_name       text,
  shares            bigint,
  value_usd         numeric,
  put_call          text,
  filer_name        text,
  filed_at          timestamptz
)
language sql
stable
as $$
  with ranked as (
    select
      h.cik, h.period_of_report, h.cusip, h.ticker, h.issuer_name,
      h.shares, h.value_usd, h.put_call, h.filing_id, h.id,
      dense_rank() over (partition by h.cik order by h.period_of_report desc) as rnk
    from holdings_13f_effective h
  )
  select
    r.cik, r.period_of_report, r.cusip, r.ticker, r.issuer_name,
    r.shares, r.value_usd, r.put_call,
    f.filer_name, f.filed_at
  from ranked r
  join filings_raw f on f.id = r.filing_id
  where r.rnk <= max_periods
  order by r.cik, r.period_of_report desc, r.id;
$$;
