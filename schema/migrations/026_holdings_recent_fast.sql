-- holdings_recent(): same rows and order, less work per call.
--
-- WHY: the Holdings page reads this in 24 pages of 1,000 rows, and each call
-- ranked every stored holding (~150k rows) to find each filer's latest
-- periods, then sorted the result: 12.3 s per page load on production after
-- migration 025, vs 8.5 s before 023. Ranking only the distinct
-- (filer, period) pairs (~1,000) and reading their rows through an index in
-- the output order avoids both full passes.

create index if not exists holdings_13f_effective_cik_period_desc_id_idx
  on holdings_13f_effective (cik, period_of_report desc, id);

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
  with periods as (
    select p.cik, p.period_of_report
    from (
      select d.cik, d.period_of_report,
             dense_rank() over (partition by d.cik order by d.period_of_report desc) as rnk
      from (select distinct e.cik, e.period_of_report from holdings_13f_effective e) d
    ) p
    where p.rnk <= max_periods
  )
  select
    h.cik, h.period_of_report, h.cusip, h.ticker, h.issuer_name,
    h.shares, h.value_usd, h.put_call,
    f.filer_name, f.filed_at
  from periods p
  join holdings_13f_effective h on h.cik = p.cik and h.period_of_report = p.period_of_report
  join filings_raw f on f.id = h.filing_id
  -- The page reads this in .range() pages; a total order keeps rows from
  -- moving between pages.
  order by h.cik, h.period_of_report desc, h.id;
$$;
