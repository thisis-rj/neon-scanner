-- Portfolio-level cash flows (money in/out of the US-stocks account from the
-- investor's pocket) for the /my-stocks pocket-return band.
--
-- Pocket P&L is cash-flow based, NOT cost-basis based: reinvested earnings are
-- internal and never count as new pocket money. Amounts are in INR (the
-- investor's home currency) — the ₹ that actually left/entered the bank.
--   amount_inr > 0  => deposit into the account (money from pocket)
--   amount_inr < 0  => withdrawal back out (money returned to pocket)
-- Net from pocket = sum(amount_inr). Pocket P&L (INR) = current_value_inr - net.

create table if not exists portfolio_cashflows (
  id          bigint generated always as identity primary key,
  person      text not null,              -- 'Riya' | 'Vijay'
  flow_date   date not null,
  amount_inr  numeric not null,           -- + deposit, - withdrawal
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists portfolio_cashflows_person_idx
  on portfolio_cashflows (person, flow_date);

alter table portfolio_cashflows enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'auth_read_portfolio_cashflows') then
    create policy auth_read_portfolio_cashflows
      on portfolio_cashflows for select
      using (auth.role() = 'authenticated');
  end if;
end$$;

-- Simple FX store, refreshed by the daily price job. One row per pair (e.g. USDINR).
create table if not exists fx_rates (
  pair        text primary key,           -- e.g. 'USDINR'
  rate        numeric not null,
  updated_at  timestamptz not null default now()
);
