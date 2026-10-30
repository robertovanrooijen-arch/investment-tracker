-- Follow-up hardening after the Supabase advisor check.
-- Composite owner-safe foreign keys need covering indexes in the same order.
create index if not exists cfe_account_owner_idx on public.capital_flow_entries (account_id, user_id);
create index if not exists cfe_import_run_owner_idx on public.capital_flow_entries (import_run_id, user_id);
create index if not exists cfe_linked_tx_owner_idx on public.capital_flow_entries (linked_transaction_id, user_id);
create index if not exists investments_account_owner_idx on public.investments (account_id, user_id);
create index if not exists investments_import_run_owner_idx on public.investments (import_run_id, user_id);
create index if not exists official_balances_import_run_owner_idx on public.official_balances (import_run_id, user_id);
create index if not exists official_balances_investment_owner_idx on public.official_balances (investment_id, user_id);
create index if not exists transactions_import_run_owner_idx on public.transactions (import_run_id, user_id);
create index if not exists transactions_investment_owner_idx on public.transactions (investment_id, user_id);

-- The composite indexes replace the earlier single-column variants.
drop index if exists public.cfe_account_id_idx;
drop index if exists public.cfe_import_run_id_idx;
drop index if exists public.investments_account_id_idx;
drop index if exists public.investments_import_run_id_idx;
drop index if exists public.official_balances_import_run_id_idx;
drop index if exists public.official_balances_investment_id_idx;
drop index if exists public.transactions_import_run_id_idx;
drop index if exists public.transactions_investment_id_idx;

-- This index already existed under idx_rt_user_id before MA hardening.
drop index if exists public.recurring_transactions_user_id_idx;
