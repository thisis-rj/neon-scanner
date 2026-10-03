-- Lag7 (Mag7 laggard sleeve): a personal strategy TRACKER (no execution).
-- Powers /lag7. See the CLAUDE.md §2.2 note on personal strategy trackers —
-- fixed 7-stock universe, never feeds signals.
--
-- Rule: at each month-end close, rank AAPL MSFT GOOGL AMZN NVDA META TSLA on
-- trailing 3/6/12-month total return (1 = best), average the three ranks, buy
-- the WORST average (tie → lower 12-month return). On the next trading day
-- the $100,000 sleeve switches into the pick, or holds if unchanged.
--
-- Written by ingest/mag7.py. Signals and model trades are FROZEN once written:
-- later Yahoo revisions never rewrite what the page already showed.

-- One row per month-end signal.
create table if not exists mag7_signals (
  signal_date   date primary key,          -- last trading day of the month
  selected      text not null,
  source        text not null check (source in ('backtest', 'live')),
  trade_date    date,                      -- first trading day after; null until it has closed
  action        text check (action in ('initial', 'switch', 'hold')),  -- null until trade_date known
  computed_at   timestamptz not null default now()
);

-- The full ranking table behind each signal.
create table if not exists mag7_ranks (
  signal_date   date not null references mag7_signals (signal_date) on delete cascade,
  ticker        text not null,
  ret_3m        numeric not null,          -- fraction; 0.12 = +12%
  ret_6m        numeric not null,
  ret_12m       numeric not null,
  rank_3m       int not null,              -- 1 = highest return of the seven
  rank_6m       int not null,
  rank_12m      int not null,
  avg_rank      numeric not null,
  primary key (signal_date, ticker)
);

-- Model sleeve ledger: pretend fills at the trade_date close, fractional shares.
create table if not exists mag7_trades (
  trade_date    date not null,
  signal_date   date not null references mag7_signals (signal_date) on delete cascade,
  side          text not null check (side in ('buy', 'sell')),
  ticker        text not null,
  shares        numeric not null,
  price         numeric not null,
  amount        numeric not null,          -- shares × price
  primary key (trade_date, side)
);

-- Sleeve value vs two benchmarks ($100,000 into each on the first trade date):
-- equal_weight = all seven bought equally and held; spy = SPY held.
-- One row per month-end (frozen) plus one moving 'latest' row.
create table if not exists mag7_equity (
  date          date primary key,
  kind          text not null check (kind in ('month_end', 'latest')),
  strategy      numeric not null,
  equal_weight  numeric not null,
  spy           numeric not null,
  closes        jsonb not null             -- {ticker: adjusted close} for the 7 + SPY
);

-- YOUR real Robinhood fills, typed in on the page. Separate from the model.
create table if not exists mag7_actual_trades (
  id            bigint generated always as identity primary key,
  trade_date    date not null,
  side          text not null check (side in ('buy', 'sell')),
  ticker        text not null,
  shares        numeric not null check (shares > 0),
  price         numeric not null check (price > 0),
  amount        numeric not null check (amount > 0),
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists mag7_actual_trades_date_idx on mag7_actual_trades (trade_date);

alter table mag7_signals enable row level security;
alter table mag7_ranks enable row level security;
alter table mag7_trades enable row level security;
alter table mag7_equity enable row level security;
alter table mag7_actual_trades enable row level security;
do $$
declare t text;
begin
  foreach t in array array['mag7_signals', 'mag7_ranks', 'mag7_trades', 'mag7_equity', 'mag7_actual_trades'] loop
    if not exists (select 1 from pg_policies where policyname = 'auth_read_' || t) then
      execute format('create policy %I on %I for select using (auth.role() = ''authenticated'')', 'auth_read_' || t, t);
    end if;
  end loop;
end$$;
