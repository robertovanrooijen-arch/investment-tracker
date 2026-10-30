-- M5 · Transactions: import keys, owner-safe FK, imported rows need FX.
alter table public.transactions
  add column import_run_id  uuid,
  add column order_group_id text;

alter table public.transactions add constraint transactions_id_user_key unique (id, user_id);

-- First the full unique constraint, THEN drop the old partial index, so
-- uniqueness of (user_id, source, external_id) never lapses. Preflight: 0 dups.
alter table public.transactions add constraint transactions_source_external_key
  unique (user_id, source, external_id);
drop index if exists public.transactions_user_source_external_id_uidx;

-- Owner check with the same ON DELETE CASCADE as the existing
-- transactions.investment_id → investments.id FK (which stays).
alter table public.transactions add constraint transactions_investment_owner_fk
  foreign key (investment_id, user_id) references public.investments(id, user_id) on delete cascade not valid;
alter table public.transactions validate constraint transactions_investment_owner_fk;  -- preflight: 0 violations

alter table public.transactions add constraint transactions_import_run_owner_fk
  foreign key (import_run_id, user_id) references public.import_runs(id, user_id) on delete set null (import_run_id);
alter table public.transactions add constraint transactions_external_requires_source
  check (external_id is null or source is not null);
alter table public.transactions add constraint transactions_imported_not_contribution
  check (external_id is null or is_contribution = false);

-- Imported rows: price AND fee must convert to EUR historically. A fee in a
-- third currency has no rate column of its own and is therefore refused.
-- NOT VALID: validate after checking the preflight (expected 0 violations).
alter table public.transactions add constraint transactions_imported_needs_fx check (
  external_id is null or (
    (coalesce(price_currency, 'EUR') = 'EUR' or fx_rate_to_eur is not null)
    and (fee = 0
         or coalesce(fee_currency, price_currency, 'EUR') = 'EUR'
         or (coalesce(fee_currency, price_currency) = price_currency and fx_rate_to_eur is not null))
  )) not valid;

create index transactions_import_run_id_idx on public.transactions (import_run_id);
