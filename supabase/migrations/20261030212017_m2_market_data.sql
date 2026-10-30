-- M2 · Global market data: instruments, daily closes, daily FX.
-- Readable by signed-in users; written only by trusted server code (service_role).
create table public.instruments (
  id             uuid primary key default gen_random_uuid(),
  instrument_key text not null unique,
  isin           text unique check (isin is null or isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
  name           text not null,
  asset_class    text not null check (asset_class in ('stock', 'ETF', 'crypto', 'commodity', 'cash')),
  quote_currency text not null check (quote_currency ~ '^[A-Z]{3}$'),
  price_symbol   text,
  price_source   text,
  price_unit     text not null default 'unit' check (price_unit in ('unit', 'troy_ounce', 'gram')),
  created_at     timestamptz not null default now()
);

-- close = raw exchange close; adj_close only as reference. Metals rows are
-- market BENCHMARKS (never official values) — see official_balances (M10b).
create table public.instrument_prices (
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  price_date    date not null,
  source        text not null,
  close         numeric(20,8) not null check (close > 0),
  adj_close     numeric(20,8) check (adj_close is null or adj_close > 0),
  currency      text not null check (currency ~ '^[A-Z]{3}$'),
  price_unit    text not null check (price_unit in ('unit', 'troy_ounce', 'gram')),
  fetched_at    timestamptz not null default now(),
  primary key (instrument_id, price_date, source)
);

create table public.fx_rates_daily (
  currency     text not null check (currency ~ '^[A-Z]{3}$'),
  rate_date    date not null,
  source       text not null default 'ecb_frankfurter',
  eur_per_unit numeric(20,10) not null check (eur_per_unit > 0),
  fetched_at   timestamptz not null default now(),
  primary key (currency, rate_date, source)
);

alter table public.instruments       enable row level security;
alter table public.instrument_prices enable row level security;
alter table public.fx_rates_daily    enable row level security;
revoke all on table public.instruments, public.instrument_prices, public.fx_rates_daily from public, anon, authenticated;
grant select on table public.instruments, public.instrument_prices, public.fx_rates_daily to authenticated;
grant all on table public.instruments, public.instrument_prices, public.fx_rates_daily to service_role;

create policy instruments_read       on public.instruments       for select to authenticated using (true);
create policy instrument_prices_read on public.instrument_prices for select to authenticated using (true);
create policy fx_rates_daily_read    on public.fx_rates_daily    for select to authenticated using (true);
