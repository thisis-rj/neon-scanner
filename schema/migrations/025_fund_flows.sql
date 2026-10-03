-- Fund flows: which stocks the tracked funds are buying or leaving, by industry.
-- Read source for the /funds page (docs: ~/Launcher/docs/neon-fund-flow-list-spec.md).
--
-- WHY one per-fund table + one SQL function: the page lets you count only some
-- funds (tier S/A, activists, …) and switch between "latest quarter" and
-- "latest 2 quarters". If counts were pre-summed per stock, the page would need
-- a second copy of the counting rules. Instead ingest/compute_fund_flows.py
-- stores what each fund did (opened / added / trimmed / exited) and
-- fund_flows() below is the ONLY place that adds those facts up.
--
-- Additive only: two nullable columns on tickers, three new tables, one function.

-- Industry labels from Yahoo (saved by ingest/prices.py from the t.info call it
-- already makes). NULL = Yahoo has no label; the page shows "Unclassified".
alter table tickers add column if not exists industry text;
alter table tickers add column if not exists sector text;

-- Stock splits, so a 2-for-1 split isn't read as every holder doubling their
-- position. ratio = new shares per old share (2 = 2-for-1, 0.1 = 1-for-10).
create table if not exists stock_splits (
  ticker      text not null,
  split_date  date not null,
  ratio       numeric not null check (ratio > 0),
  primary key (ticker, split_date)
);
alter table stock_splits enable row level security;

-- One row per fund × stock × pair of that fund's own 13F filings.
--   lag_quarters 1: consecutive filings; pair_rank 0 = the fund's newest pair,
--                   1 = the pair before, … (pair_rank drives the streak)
--   lag_quarters 2: newest filing vs two filings back (pair_rank 0 only)
-- Held positions (|change| < 10%) are not stored.
create table if not exists fund_position_changes (
  cik           text not null,
  ticker        text not null,
  lag_quarters  smallint not null check (lag_quarters in (1, 2)),
  pair_rank     smallint not null check (pair_rank >= 0),
  period        date not null,          -- the fund's newer filing (quarter end)
  prev_period   date not null,          -- the filing it is compared with
  event         text not null check (event in ('opened', 'added', 'trimmed', 'exited')),
  shares_prev   numeric,
  shares_cur    numeric,
  split_factor  numeric not null default 1,
  value_usd     numeric,                -- newer filing; earlier filing for exits
  pct_of_fund   numeric,                -- value_usd / that filing's total 13F value
  issuer_name   text,
  filer_name    text not null,
  tier          text not null,          -- S / A / B / C, copied from tracked_filers.yml
  category      text,                   -- value / growth / activist / …
  tier_mult     numeric not null,       -- S 1.5, A 1.2, B 1.0, C 0.7
  run_id        text not null,
  computed_at   timestamptz not null default now(),
  primary key (cik, ticker, lag_quarters, pair_rank)
);
create index if not exists fund_position_changes_lag_rank_idx on fund_position_changes (lag_quarters, pair_rank, ticker);
create index if not exists fund_position_changes_cik_idx on fund_position_changes (cik);
create index if not exists fund_position_changes_run_idx on fund_position_changes (run_id);
alter table fund_position_changes enable row level security;

-- Insider-cluster and activist-13D columns, computed with the v6 scorer's own
-- rules (ingest/scoring_rules.stock_signal_extras) so /funds and Clusters agree.
create table if not exists stock_signal_extras (
  ticker           text primary key,
  insider_buyers   int not null default 0,
  insider_names    text[] not null default '{}',
  activist_filers  text[] not null default '{}',
  activist_latest  date,
  run_id           text not null,
  computed_at      timestamptz not null default now()
);
alter table stock_signal_extras enable row level security;

-- fund_flows(): one row per stock that at least one counted fund changed.
--   p_lag         1 = each fund's newest filing vs its previous one (default)
--                 2 = newest vs two filings back ("latest 2 quarters combined")
--   p_tiers       only count these tiers, e.g. '{S,A}'; NULL = all
--   p_categories  only count these categories, e.g. '{activist}'; NULL = all
-- Every count respects the filters, including the streak. The streak is always
-- quarter to quarter (lag 1): consecutive pair_ranks, from the newest, in which
-- more counted funds bought than sold.
create or replace function fund_flows(
  p_lag        int    default 1,
  p_tiers      text[] default null,
  p_categories text[] default null
)
returns table (
  ticker                text,
  name                  text,
  industry              text,
  sector                text,
  market_cap_usd        numeric,
  avg_dollar_volume_20d numeric,
  return_6mo            numeric,
  buyers                int,
  sellers               int,
  net                   int,
  opened                int,
  added                 int,
  trimmed               int,
  exited                int,
  tier_net              numeric,
  sa_buyers             int,
  conviction_max        numeric,
  conviction_max_filer  text,
  conviction_sum        numeric,
  streak                int,
  min_period            date,
  max_period            date,
  insider_buyers        int,
  insider_names         text[],
  activist_filers       text[],
  activist_latest       date,
  funds                 jsonb,
  computed_at           timestamptz
)
language sql
stable
as $$
  with f as (
    select c.*, (c.event in ('opened', 'added')) as is_buy
    from fund_position_changes c
    where (p_tiers is null or c.tier = any(p_tiers))
      and (p_categories is null or c.category = any(p_categories))
  ),
  cur as (
    select * from f where f.lag_quarters = p_lag and f.pair_rank = 0
  ),
  agg as (
    select
      cur.ticker,
      max(cur.issuer_name)                                              as issuer_name,
      count(*) filter (where cur.is_buy)::int                           as buyers,
      count(*) filter (where not cur.is_buy)::int                       as sellers,
      count(*) filter (where cur.event = 'opened')::int                 as opened,
      count(*) filter (where cur.event = 'added')::int                  as added,
      count(*) filter (where cur.event = 'trimmed')::int                as trimmed,
      count(*) filter (where cur.event = 'exited')::int                 as exited,
      sum(case when cur.is_buy then cur.tier_mult else -cur.tier_mult end) as tier_net,
      count(*) filter (where cur.is_buy and cur.tier in ('S', 'A'))::int as sa_buyers,
      max(cur.pct_of_fund) filter (where cur.is_buy)                    as conviction_max,
      (array_agg(cur.filer_name order by cur.pct_of_fund desc nulls last)
         filter (where cur.is_buy))[1]                                  as conviction_max_filer,
      sum(cur.pct_of_fund) filter (where cur.is_buy)                    as conviction_sum,
      min(cur.period)                                                   as min_period,
      max(cur.period)                                                   as max_period,
      max(cur.computed_at)                                              as computed_at,
      jsonb_agg(jsonb_build_object(
        'cik', cur.cik, 'filer', cur.filer_name, 'tier', cur.tier, 'category', cur.category,
        'event', cur.event, 'pct', cur.pct_of_fund, 'shares_prev', cur.shares_prev,
        'shares_cur', cur.shares_cur, 'split', cur.split_factor,
        'period', cur.period, 'prev_period', cur.prev_period
      ) order by cur.is_buy desc, cur.tier_mult desc, cur.pct_of_fund desc nulls last) as funds
    from cur
    group by cur.ticker
  ),
  hist as (
    select f.ticker, f.pair_rank,
           sum(case when f.is_buy then 1 else -1 end) as net
    from f
    where f.lag_quarters = 1
    group by f.ticker, f.pair_rank
  ),
  streaks as (
    -- Ranks with net buying, numbered from 0; the streak is the leading run
    -- where the rank equals its position (0, 1, 2, … with no gap).
    select x.ticker, count(*)::int as streak
    from (
      select hist.ticker, hist.pair_rank,
             row_number() over (partition by hist.ticker order by hist.pair_rank) - 1 as rn
      from hist
      where hist.net > 0
    ) x
    where x.pair_rank = x.rn
    group by x.ticker
  )
  select
    a.ticker,
    coalesce(t.name, a.issuer_name),
    t.industry,
    t.sector,
    t.market_cap_usd::numeric,
    t.avg_dollar_volume_20d::numeric,
    t.return_6mo::numeric,
    a.buyers,
    a.sellers,
    a.buyers - a.sellers,
    a.opened,
    a.added,
    a.trimmed,
    a.exited,
    a.tier_net,
    a.sa_buyers,
    a.conviction_max,
    a.conviction_max_filer,
    a.conviction_sum,
    coalesce(s.streak, 0),
    a.min_period,
    a.max_period,
    coalesce(e.insider_buyers, 0),
    coalesce(e.insider_names, '{}'),
    coalesce(e.activist_filers, '{}'),
    e.activist_latest,
    a.funds,
    a.computed_at
  from agg a
  left join tickers t on t.ticker = a.ticker
  left join streaks s on s.ticker = a.ticker
  left join stock_signal_extras e on e.ticker = a.ticker;
$$;

comment on function fund_flows(int, text[], text[]) is
  'Per-stock fund buying/selling from fund_position_changes, with optional tier/category filters. See migration 025.';

grant execute on function fund_flows(int, text[], text[]) to authenticated, service_role, anon;
