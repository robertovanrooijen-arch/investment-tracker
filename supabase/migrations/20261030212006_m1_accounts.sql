-- M1 · Broker accounts (one per platform + account reference) per user.
create table public.accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  platform_code     text not null check (platform_code in
                      ('degiro', 'trade_republic', 'bitvavo', 'goldrepublic', 'holland_gold', 'abn', 'other')),
  account_ref       text not null default 'main',
  display_name      text not null,
  cash_in_portfolio boolean not null default true,
  source            text,
  external_id       text,
  created_at        timestamptz not null default now(),
  constraint accounts_user_platform_ref_key unique (user_id, platform_code, account_ref),
  constraint accounts_id_user_key unique (id, user_id),
  constraint accounts_source_external_key unique (user_id, source, external_id),
  constraint accounts_external_requires_source check (external_id is null or source is not null)
);

alter table public.accounts enable row level security;
revoke all on table public.accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.accounts to authenticated;
grant all on table public.accounts to service_role;

create policy accounts_select_own on public.accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy accounts_insert_own on public.accounts for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy accounts_update_own on public.accounts for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy accounts_delete_own on public.accounts for delete to authenticated
  using ((select auth.uid()) = user_id);
