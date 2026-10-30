-- M8 · MANUAL DATA MIGRATION — NOT part of the migration chain.
-- Moves the 8 legacy Trade Republic "contribution" buy rows of the OLD account
-- (U1) to capital_flow_entries. Requires M6 and the owner's explicit approval.
-- Runs in one transaction; before COMMIT check: exactly 8 rows inserted, sum
-- 220.71, and no is_contribution rows left counted twice. Otherwise ROLLBACK.
-- The €5.11 and €3.64 rows stay 'pending_classification' until a source proves them.
begin;
with src(ref, flow_date, quantity, amount_eur, flow_kind, external_id, source_datetime) as (values
  ('03235dae', date '2026-09-02', 0.069554, 8.80,  'saveback',               'tr:92473792-1c6c-44e2-955b-0a73f3afa6c1', timestamptz '2026-09-02T14:14:14.633Z'),
  ('5c5b75e3', date '2026-09-02', 0.39513,  50.00, 'savings_plan',           'tr:bb2f2a96-28cc-4db6-8cc4-24f0727d4fa0', timestamptz '2026-09-02T14:19:40.170Z'),
  ('6ab8acd1', date '2026-09-02', 0.040411, 5.11,  'pending_classification', 'tr:c5b55f32-0238-4c07-a43d-34703e315c7b', timestamptz '2026-09-02T14:04:21.438Z'),
  ('e45c5d18', date '2026-09-22', 0.109182, 50.00, 'order_payment',          'tr:8e2bd8a5-0588-4f22-b711-09982132fecf', timestamptz '2026-09-22T14:10:39.506Z'),
  ('240e4072', date '2026-10-02', 0.383715, 50.00, 'order_payment',          'tr:370282a7-ebe0-428a-ac11-39cd0778de32', timestamptz '2026-10-02T15:13:29.713Z'),
  ('a4f424b6', date '2026-10-02', 0.024268, 3.16,  'saveback',               'tr:f03f2660-ef17-46b1-af65-b29d88e6f565', timestamptz '2026-10-02T14:09:58.112Z'),
  ('b71dd440', date '2026-10-02', 0.027924, 3.64,  'pending_classification', 'tr:e788c223-3601-496e-9274-500f5a7ae788', timestamptz '2026-10-02T14:42:45.755Z'),
  ('50965424', date '2026-10-16', 0.10995,  50.00, 'savings_plan',           'tr:159ef1e9-ea7d-4b14-8b2e-f5b2a3204b48', timestamptz '2026-10-16T11:07:20.260Z')
), matched as (
  select s.*, t.id as tx_id, t.user_id from src s
  join public.transactions t
    on t.id::text like s.ref || '%' and t.date = s.flow_date and t.quantity = s.quantity
   and t.is_contribution = true and t.type = 'buy'
)
insert into public.capital_flow_entries
  (user_id, flow_date, year, platform, direction, amount_eur, source, external_id, source_datetime, flow_kind, linked_transaction_id)
select user_id, flow_date, extract(year from flow_date)::int, 'Trade Republic', 'to_portfolio', amount_eur,
       'trade_republic_transactions_export', external_id, source_datetime, flow_kind, tx_id
from matched;
-- Vóór commit controleren: precies 8 rijen, som 220.71, legacy-teller voor U1 = 0; anders rollback.
-- commit;   -- only after the checks above; otherwise: rollback;
