-- M14 · APPLIED TO PRODUCTION ON 2026-10-31 after an exact-one-row guard.
-- Live verification showed the -€2.42 was a small temporary broker overdraft,
-- while current reconstructed cash is only a rounding residue. It stays in
-- the audit ledger and is outside the headline value; no external flow is made up.
--
-- Removes the owner-approved DEGIRO cash reconciliation of €2.42 on 2026-02-23
-- for the target account. The records already explain the balance: DEGIRO
-- charged debit interest on 2026-03-04 and 2026-04-08, and after the withdrawal
-- of 2026-10-08 the reconstructed cash is €0.00, so the reconciliation adds
-- €2.42 that does not exist. The app already ignores this exact row
-- (lib/returns/account-decisions.ts); after this change that entry can go.
--
-- Replace <target-user-id> before running. Expect exactly ONE row.

begin;

select id, platform, treatment, effective_date, amount_eur, notes
from public.portfolio_accounting_treatments
where user_id = '<target-user-id>'
  and platform = 'DEGIRO'
  and treatment = 'cash_reconciliation'
  and effective_date = date '2026-02-23'
  and amount_eur = 2.42;

delete from public.portfolio_accounting_treatments
where user_id = '<target-user-id>'
  and platform = 'DEGIRO'
  and treatment = 'cash_reconciliation'
  and effective_date = date '2026-02-23'
  and amount_eur = 2.42;
-- Check: "DELETE 1". Anything else → rollback;

commit;
