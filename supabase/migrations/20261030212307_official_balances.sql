-- Official broker statement figures (decision 1 & 2): leading over any
-- reconstruction. Cash rows are CONFIRMED broker cash (e.g. DEGIRO free space
-- €90.38 on 2025-12-31); position rows are statement values. Market benchmarks
-- (Yahoo/COMEX) never go here. Owner reads; written by trusted code only.
create table public.official_balances (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  statement_date  date not null,
  platform        text not null,
  kind            text not null check (kind in ('cash', 'position')),
  investment_id   uuid,
  quantity        numeric(20,8),
  unit            text check (unit is null or unit in ('unit', 'gram', 'troy_ounce')),
  value_native    numeric(20,8),
  currency        text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  value_eur       numeric(14,2) not null,
  price_date      date,
  source_document text not null,  -- e.g. 'DEGIRO jaaroverzicht 2025'
  quality         text not null default 'confirmed' check (quality in ('confirmed', 'warning')),
  import_run_id   uuid,
  created_at      timestamptz not null default now(),
  constraint official_balances_kind_fields check (
    (kind = 'cash' and investment_id is null and quantity is null)
    or (kind = 'position' and investment_id is not null)),
  constraint official_balances_investment_owner_fk
    foreign key (investment_id, user_id) references public.investments(id, user_id) on delete restrict,
  constraint official_balances_import_run_owner_fk
    foreign key (import_run_id, user_id) references public.import_runs(id, user_id) on delete set null (import_run_id)
);
create unique index official_balances_cash_key on public.official_balances (user_id, statement_date, platform)
  where kind = 'cash';
create unique index official_balances_position_key on public.official_balances (user_id, statement_date, investment_id)
  where kind = 'position';
create index official_balances_investment_id_idx on public.official_balances (investment_id);
create index official_balances_import_run_id_idx on public.official_balances (import_run_id);

alter table public.official_balances enable row level security;
revoke all on table public.official_balances from public, anon, authenticated;
grant select on table public.official_balances to authenticated;
grant all on table public.official_balances to service_role;

create policy official_balances_select_own on public.official_balances for select to authenticated
  using ((select auth.uid()) = user_id);
