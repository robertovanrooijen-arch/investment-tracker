create table public.broker_value_observations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  investment_id uuid not null,
  quantity      numeric(20,8) not null check (quantity >= 0),
  quantity_unit text not null check (quantity_unit in ('gram', 'troy_ounce', 'unit')),
  price         numeric(20,8) not null check (price > 0),
  price_unit    text not null check (price_unit in ('gram', 'kilogram', 'troy_ounce', 'unit')),
  currency      text not null check (currency ~ '^[A-Z]{3}$'),
  total_value   numeric(14,2) not null check (total_value >= 0),
  observed_at   timestamptz not null,
  source        text not null check (length(btrim(source)) > 0),
  evidence      text not null default 'none' check (evidence in ('none', 'screenshot', 'export', 'statement')),
  notes         text,
  created_at    timestamptz not null default now(),
  constraint broker_value_observations_investment_owner_fk
    foreign key (investment_id, user_id) references public.investments(id, user_id) on delete cascade,
  constraint broker_value_observations_identity_key unique (user_id, investment_id, observed_at)
);

create index broker_value_observations_investment_idx
  on public.broker_value_observations (investment_id, observed_at desc);

alter table public.broker_value_observations enable row level security;
revoke all on table public.broker_value_observations from public, anon, authenticated;
grant select on table public.broker_value_observations to authenticated;
grant all on table public.broker_value_observations to service_role;

create policy "Users can read own broker value observations"
  on public.broker_value_observations for select to authenticated
  using ((select auth.uid()) = user_id);
