-- M4 · Positions: account/instrument links, import keys, owner-safe FKs.
alter table public.investments
  add column account_id    uuid,
  add column instrument_id uuid references public.instruments(id),
  add column source        text,
  add column external_id   text,
  add column import_run_id uuid;

alter table public.investments add constraint investments_id_user_key unique (id, user_id);
alter table public.investments add constraint investments_account_owner_fk
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete restrict;
alter table public.investments add constraint investments_import_run_owner_fk
  foreign key (import_run_id, user_id) references public.import_runs(id, user_id) on delete set null (import_run_id);
alter table public.investments add constraint investments_position_key unique (user_id, account_id, instrument_id);
alter table public.investments add constraint investments_source_external_key unique (user_id, source, external_id);
alter table public.investments add constraint investments_external_requires_source
  check (external_id is null or source is not null);

-- NOT VALID on purpose: one existing (U2) row violates it; validate only after
-- a decision about that row. New and updated rows are checked immediately.
alter table public.investments add constraint investments_commodity_fields_not_null
  check (type <> 'commodity' or (commodity_kind is not null and quantity_unit is not null
         and commodity_kind in ('gold', 'silver') and quantity_unit in ('gram', 'troy_ounce'))) not valid;

create index investments_account_id_idx    on public.investments (account_id);
create index investments_instrument_id_idx on public.investments (instrument_id);
create index investments_import_run_id_idx on public.investments (import_run_id);
