-- holdings_13f_effective: one place that answers "which 13F rows are this
-- filer's actual long equity holdings for this quarter?"
--
-- WHY: five readers (compute_buy_signals, filer_returns, cost_basis, the
-- Stocks page, the Holdings page) each answered it differently or not at all:
--   • put/call option rows were added to share counts (a hedge looked like a buy);
--   • PRN rows (bond principal, in dollars) were stored and summed as shares —
--     Oaktree's Q1-2026 table has 90 PRN rows vs 57 SH rows;
--   • 13F-HR/A amendments were either all treated as replacements (Holdings
--     page) or stacked on top of the original (scorer, returns). SEC has two
--     kinds: RESTATEMENT replaces the original; NEW HOLDINGS only adds the
--     positions the filer had kept confidential (Berkshire Q1-2025: original
--     110 holdings + a 4-holding NEW HOLDINGS amendment = 114).
--
-- RULE, per (cik, period_of_report):
--   base  = most recently filed of {13F-HR, 13F-HR/A RESTATEMENT} that has
--           at least one holdings row (same day: RESTATEMENT, then later accession) (a filing whose table failed to parse
--           never wipes out the quarter). amendment_type NULL on a 13F-HR/A
--           (cover page unreadable) counts as RESTATEMENT.
--   extra = 13F-HR/A NEW HOLDINGS filed on or after the base date (or with no base),
--           minus any row that is an exact copy of a row in the base or in an
--           earlier NEW HOLDINGS amendment (same CUSIP, shares, put/call). Filers sometimes label a full re-list
--           "NEW HOLDINGS": First Eagle Q2-2026 re-listed all 614 original
--           rows plus 2 new ones; Akre Q1-2024 and ValueAct Q3-2024 did the
--           same. Trusting the label would count those positions twice.
--           A NEW HOLDINGS amendment repeating >= half of the base's
--           securities (and at least 5) is a re-list and counts as RESTATEMENT.
--   rows  = base ∪ extra, minus option rows and PRN rows.
--
-- Additive only: two nullable columns, an index and a view. Old code keeps
-- working; parse_13f fills the columns (one-time `--reparse` backfills them).

alter table filings_raw add column if not exists amendment_type text;   -- 'RESTATEMENT' | 'NEW HOLDINGS' | null
alter table holdings_13f add column if not exists sh_type text;         -- 'SH' | 'PRN' | null (pre-reparse)

-- The view joins holdings to filings by filing_id; there was no index on it.
create index if not exists holdings_13f_filing_id_idx on holdings_13f(filing_id);

create or replace view holdings_13f_effective as
with thirteenf as (
  select
    f.id, f.cik, f.period_of_report, f.filed_at, f.accession_number,
    case
      when f.form_type = '13F-HR' then 'ORIGINAL'
      when f.amendment_type = 'NEW HOLDINGS' then 'NEW HOLDINGS'
      else 'RESTATEMENT'
    end as kind
  from filings_raw f
  where f.form_type in ('13F-HR', '13F-HR/A')
    and exists (select 1 from holdings_13f h where h.filing_id = f.id)
),
base0 as (
  select distinct on (cik, period_of_report) id, cik, period_of_report
  from thirteenf
  where kind in ('ORIGINAL', 'RESTATEMENT')
  order by cik, period_of_report, filed_at desc, (kind = 'RESTATEMENT') desc,
           accession_number desc, id desc
),
-- A "NEW HOLDINGS" amendment that repeats most of the base is a mislabelled
-- full re-list: treat it as a RESTATEMENT so it replaces the quarter (a
-- corrected share count then can't be added on top of the old one). In the
-- 35 amendments on file, true NEW HOLDINGS repeat 0-1 base securities and
-- re-lists repeat 99-100% (at least 8); the 5-security floor keeps a tiny
-- filer's same-stock confidential lot from being misread as a re-list.
classified as (
  select t.id, t.cik, t.period_of_report, t.filed_at, t.accession_number,
    case when t.kind = 'NEW HOLDINGS' and b0.id is not null and s.shared >= 5 and s.shared * 2 >= s.base_n
         then 'RESTATEMENT' else t.kind end as kind
  from thirteenf t
  left join base0 b0 on b0.cik = t.cik and b0.period_of_report = t.period_of_report
  left join lateral (
    select
      (select count(distinct o.cusip) from holdings_13f o where o.filing_id = b0.id) as base_n,
      (select count(distinct n.cusip) from holdings_13f n
        where n.filing_id = t.id
          and n.cusip in (select o.cusip from holdings_13f o where o.filing_id = b0.id)) as shared
  ) s on t.kind = 'NEW HOLDINGS' and b0.id is not null
),
base as (
  select distinct on (cik, period_of_report) id, cik, period_of_report, filed_at, accession_number
  from classified
  where kind in ('ORIGINAL', 'RESTATEMENT')
  -- filed_at is a date, so an original and its restatement can tie: the
  -- restatement wins, then the later accession number (never the random id).
  order by cik, period_of_report, filed_at desc, (kind = 'RESTATEMENT') desc,
           accession_number desc, id desc
),
effective_filings as (
  select id, cik, period_of_report, filed_at, accession_number, true as is_base from base
  union all
  select n.id, n.cik, n.period_of_report, n.filed_at, n.accession_number, false as is_base
  from classified n
  left join base b on b.cik = n.cik and b.period_of_report = n.period_of_report
  where n.kind = 'NEW HOLDINGS'
    -- >= because filed_at is a date: a same-day NEW HOLDINGS still counts;
    -- the copy check below drops any rows that repeat the base.
    and (b.id is null or n.filed_at >= b.filed_at)
)
select h.*
from holdings_13f h
join effective_filings e on e.id = h.filing_id
where h.put_call is null
  and coalesce(h.sh_type, 'SH') <> 'PRN'
  -- NEW HOLDINGS rows that merely repeat a row of the base, or of a NEW
  -- HOLDINGS amendment filed before it, are not new holdings.
  and (e.is_base or not exists (
    select 1
    from effective_filings p
    join holdings_13f o on o.filing_id = p.id
    where p.cik = e.cik and p.period_of_report = e.period_of_report
      and (p.is_base or (p.filed_at, p.accession_number) < (e.filed_at, e.accession_number))
      and o.cusip is not distinct from h.cusip
      and o.shares is not distinct from h.shares
      and o.put_call is not distinct from h.put_call
  ));

comment on view holdings_13f_effective is
  'Long equity 13F holdings per filer-quarter: latest original/restatement ∪ later NEW HOLDINGS amendments (rows not already in the base); excludes put/call and PRN rows. See migration 023.';

-- Holdings page RPC: same signature and columns as migration 015, now reading
-- the view. put_call is always null here (kept so the page contract is unchanged).
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
  -- The page reads this in 1,000-row .range() pages; without a total order
  -- rows can move between pages and be skipped or counted twice.
  order by r.cik, r.period_of_report desc, r.id;
$$;
