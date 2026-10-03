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
--           at least one holdings row (a filing whose table failed to parse
--           never wipes out the quarter). amendment_type NULL on a 13F-HR/A
--           (cover page unreadable) counts as RESTATEMENT.
--   extra = 13F-HR/A NEW HOLDINGS filed after the base (or with no base),
--           minus any row that is an exact copy of a base row (same CUSIP,
--           shares, put/call). Filers sometimes label a full re-list
--           "NEW HOLDINGS": First Eagle Q2-2026 re-listed all 614 original
--           rows plus 2 new ones; Akre Q1-2024 and ValueAct Q3-2024 did the
--           same. Trusting the label would count those positions twice.
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
    f.id, f.cik, f.period_of_report, f.filed_at,
    case
      when f.form_type = '13F-HR' then 'ORIGINAL'
      when f.amendment_type = 'NEW HOLDINGS' then 'NEW HOLDINGS'
      else 'RESTATEMENT'
    end as kind
  from filings_raw f
  where f.form_type in ('13F-HR', '13F-HR/A')
    and exists (select 1 from holdings_13f h where h.filing_id = f.id)
),
base as (
  select distinct on (cik, period_of_report) id, cik, period_of_report, filed_at
  from thirteenf
  where kind in ('ORIGINAL', 'RESTATEMENT')
  order by cik, period_of_report, filed_at desc, id desc
),
effective_filings as (
  select id, null as base_id from base
  union all
  select n.id, b.id as base_id
  from thirteenf n
  left join base b on b.cik = n.cik and b.period_of_report = n.period_of_report
  where n.kind = 'NEW HOLDINGS'
    and (b.id is null or n.filed_at > b.filed_at)
)
select h.*
from holdings_13f h
join effective_filings e on e.id = h.filing_id
where h.put_call is null
  and coalesce(h.sh_type, 'SH') <> 'PRN'
  -- NEW HOLDINGS rows that merely repeat a base row are not new holdings.
  and not exists (
    select 1 from holdings_13f o
    where e.base_id is not null
      and o.filing_id = e.base_id
      and o.cusip is not distinct from h.cusip
      and o.shares is not distinct from h.shares
      and o.put_call is not distinct from h.put_call
  );

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
      h.shares, h.value_usd, h.put_call, h.filing_id,
      dense_rank() over (partition by h.cik order by h.period_of_report desc) as rnk
    from holdings_13f_effective h
  )
  select
    r.cik, r.period_of_report, r.cusip, r.ticker, r.issuer_name,
    r.shares, r.value_usd, r.put_call,
    f.filer_name, f.filed_at
  from ranked r
  join filings_raw f on f.id = r.filing_id
  where r.rnk <= max_periods;
$$;
