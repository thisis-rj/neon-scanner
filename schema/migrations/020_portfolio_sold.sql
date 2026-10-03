-- Sold / closed-position tracking for portfolio_positions (the /my-stocks tab).
-- A position is 'open' by default; marking it sold records the sell price + date
-- and locks in realized P&L. Powers the "Sold" section + win rate.

alter table portfolio_positions
  add column if not exists status      text not null default 'open',  -- 'open' | 'sold'
  add column if not exists sell_price  numeric,
  add column if not exists sell_date   date;
