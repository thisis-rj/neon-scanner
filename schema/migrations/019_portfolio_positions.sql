-- portfolio_positions: Riya's and Vijay's personal holdings for the /my-stocks
-- tab. Static fields (qty, avg_cost) are entered from their broker;
-- current_price is refreshed from Yahoo by ingest/portfolio.py; target_price +
-- comment are their own editable notes (preserved across price refreshes).
--
-- NOT part of the signal engine — purely a personal P&L + notes view.

create table if not exists portfolio_positions (
  person         text not null,         -- 'Riya' | 'Vijay'
  ticker         text not null,
  stock_name     text,
  qty            numeric not null,
  avg_cost       numeric not null,      -- avg purchase price per share (USD)
  current_price  numeric,               -- latest price, refreshed from Yahoo
  target_price   numeric,               -- user-set target (editable, later)
  comment        text,                  -- shared internal note (editable, later)
  updated_at     timestamptz not null default now(),
  primary key (person, ticker)
);

alter table portfolio_positions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'auth_read_portfolio_positions') then
    create policy auth_read_portfolio_positions
      on portfolio_positions for select
      using (auth.role() = 'authenticated');
  end if;
end$$;
