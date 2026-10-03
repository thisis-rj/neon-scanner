-- portfolio_transactions: the buy/sell ledger behind the /my-stocks tab.
-- A stock's net qty, avg cost (average-cost basis), realized P&L and win rate
-- are DERIVED from this log — supporting partial sells, averaging up/down, and
-- multiple transactions per stock. portfolio_positions keeps the per-stock
-- metadata (stock_name, current_price, target_price, comment).

create table if not exists portfolio_transactions (
  id          bigint generated always as identity primary key,
  person      text not null,            -- 'Riya' | 'Vijay'
  ticker      text not null,
  txn_type    text not null,            -- 'buy' | 'sell'
  qty         numeric not null check (qty > 0),
  price       numeric not null check (price >= 0),
  trade_date  date not null default current_date,
  created_at  timestamptz not null default now()
);

create index if not exists portfolio_transactions_pt_idx
  on portfolio_transactions (person, ticker, trade_date, created_at);

alter table portfolio_transactions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'auth_read_portfolio_transactions') then
    create policy auth_read_portfolio_transactions
      on portfolio_transactions for select
      using (auth.role() = 'authenticated');
  end if;
end$$;
