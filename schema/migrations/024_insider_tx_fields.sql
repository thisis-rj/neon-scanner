-- insider_transactions: the fields the insider-buy filters need (eng review R7).
--
--   is_10b5_1           Rule 10b5-1 checkbox on the Form 4 (mandatory since
--                       2023-04-01). A pre-scheduled plan buy is not a decision
--                       made now; research finds such "routine" trades earn ~0%
--                       (Cohen, Malloy & Pomorski 2012). NULL = not reported.
--   shares_owned_after  holding after the transaction (same ownership line),
--                       used for stake growth = shares / (after − shares).
--   direct_indirect     'D' or 'I' — which ownership line shares_owned_after is.
--
-- Additive only; ingesters fill them, the 1-year bulk backfill covers history.

alter table insider_transactions add column if not exists is_10b5_1 boolean;
alter table insider_transactions add column if not exists shares_owned_after numeric;
alter table insider_transactions add column if not exists direct_indirect text;
