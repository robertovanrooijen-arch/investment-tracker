create table public.portfolio_accounting_treatments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (length(btrim(platform)) > 0),
  treatment text not null check (treatment in ('storage_costs_paid_privately', 'cash_reconciliation')),
  effective_date date not null,
  amount_eur numeric(14, 2),
  notes text not null check (length(btrim(notes)) > 0),
  created_at timestamptz not null default now(),
  constraint portfolio_accounting_treatments_amount_check check (
    (treatment = 'cash_reconciliation' and amount_eur > 0)
    or
    (treatment = 'storage_costs_paid_privately' and amount_eur is null)
  ),
  constraint portfolio_accounting_treatments_identity_key unique (user_id, platform, treatment, effective_date)
);

alter table public.portfolio_accounting_treatments enable row level security;
revoke all on table public.portfolio_accounting_treatments from public, anon, authenticated;
grant select on table public.portfolio_accounting_treatments to authenticated;
grant all on table public.portfolio_accounting_treatments to service_role;

create policy "Users can read own portfolio accounting treatments"
  on public.portfolio_accounting_treatments
  for select
  to authenticated
  using ((select auth.uid()) = user_id);
