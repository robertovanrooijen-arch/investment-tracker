-- M12 · MANUAL DATA PROPOSAL — NOT part of the migration chain, never run automatically.
-- Requires M6 (flow_kind incl. 'reused_sale_proceeds') and M9 (transactions.value_date).
-- Run in one transaction on the TARGET account only, after review; replace <target-user-id>.
-- Each statement must affect exactly one row; otherwise ROLLBACK.
begin;

-- 1. The Google order (Trade Republic, 29-10-2026, €438.00 + €1.00 fee) was paid with
--    proceeds of the S&P 500 sale (DEGIRO 06-10-2026, withdrawn 08-10-2026). Record the
--    deposit into Trade Republic as RE-USED sale proceeds: a return flow (it crossed the
--    portfolio boundary) but not new personal money. Idempotent on (user, source, external_id).
insert into public.capital_flow_entries
  (user_id, flow_date, year, platform, direction, amount_eur, source, external_id, flow_kind, notes)
values
  ('<target-user-id>', date '2026-10-29', 2026, 'Trade Republic', 'to_portfolio', 439.00,
   'owner_statement', 'google-order-2026-10-29-funding', 'reused_sale_proceeds',
   'Funding of the Alphabet C order with earlier S&P 500 sale proceeds (owner statement)')
on conflict (user_id, source, external_id) do nothing;

-- 2. VUSA dividend $2.69: value date 31-12-2025 (income / year analysis),
--    booking date 02-01-2026 stays in `date` (cash administration, TWR).
update public.transactions t
set value_date = date '2025-12-31'
from public.investments i
where t.investment_id = i.id
  and t.user_id = '<target-user-id>'
  and i.platform = 'DEGIRO' and i.ticker = 'VUSA.AS'
  and t.type = 'dividend' and t.date = date '2026-01-02' and t.amount = 2.69
  and t.value_date is null;

-- Check before commit: exactly 1 row inserted (or 0 if it already existed) and exactly 1 row updated.
-- commit;   -- only after the checks above; otherwise: rollback;
