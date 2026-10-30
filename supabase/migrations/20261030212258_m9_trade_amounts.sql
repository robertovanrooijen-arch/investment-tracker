-- M9 · Normalised trade amounts per row (filled by the importer; the code
-- prefers these over the per-source map in lib/domain/trade-amounts.ts).
alter table public.transactions
  add column amount_semantics text check (amount_semantics is null or amount_semantics in ('gross', 'net_cash')),
  add column gross_amount     numeric(20,8),  -- gross, price currency
  add column net_cash_amount  numeric(20,8),  -- paid (buy) / received (sell), price currency
  add column fx_rate_date     date,           -- date of fx_rate_to_eur
  add column amount_quality   text check (amount_quality is null or amount_quality in ('exact', 'derived')),
  add column calc_method      text check (calc_method is null or calc_method in
    ('source_gross_amount', 'source_net_cash_amount', 'quantity_x_price')),
  -- Value date of an income row when it differs from the booking date
  -- (income/year analysis use it; cash and TWR keep the booking date).
  add column value_date       date;
