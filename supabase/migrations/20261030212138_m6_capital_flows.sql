-- M6 (+ M10) · External cash flows: import keys, classification, transfer groups.
alter table public.capital_flow_entries
  add column external_id           text,
  add column source_datetime       timestamptz,
  add column account_id            uuid,
  add column flow_kind             text,
  add column linked_transaction_id uuid,
  add column import_run_id         uuid,
  -- M10: two flows sharing a group (1 out, 1 in, different platforms, in ≤ out)
  -- are ONE internal transfer. Set only after human review; never inferred.
  add column transfer_group_id     uuid;

alter table public.capital_flow_entries add constraint cfe_flow_kind_check check (flow_kind is null or flow_kind in (
  'bank_deposit', 'bank_withdrawal', 'savings_plan', 'saveback', 'round_up', 'order_payment',
  'sale_payout', 'internal_transfer', 'other', 'pending_classification',
  -- Personal-contribution view (lib/domain/flow-classification.ts): earlier
  -- sale proceeds deposited again are not new money; platform rewards are
  -- shown separately. Set only after review, never inferred.
  'reused_sale_proceeds', 'external_reward'));
alter table public.capital_flow_entries add constraint cfe_account_owner_fk
  foreign key (account_id, user_id) references public.accounts(id, user_id) on delete restrict;
alter table public.capital_flow_entries add constraint cfe_linked_tx_owner_fk
  foreign key (linked_transaction_id, user_id) references public.transactions(id, user_id)
  on delete set null (linked_transaction_id);
alter table public.capital_flow_entries add constraint cfe_import_run_owner_fk
  foreign key (import_run_id, user_id) references public.import_runs(id, user_id) on delete set null (import_run_id);
alter table public.capital_flow_entries add constraint cfe_source_external_key unique (user_id, source, external_id);
alter table public.capital_flow_entries add constraint cfe_external_requires_source
  check (external_id is null or source is not null);
alter table public.capital_flow_entries add constraint cfe_year_matches_date
  check (year = extract(year from flow_date)::int) not valid;
alter table public.capital_flow_entries validate constraint cfe_year_matches_date;  -- preflight: 0 violations

create unique index cfe_one_flow_per_legacy_tx on public.capital_flow_entries (linked_transaction_id)
  where linked_transaction_id is not null;
create index cfe_account_id_idx on public.capital_flow_entries (account_id);
create index cfe_import_run_id_idx on public.capital_flow_entries (import_run_id);
create index cfe_transfer_group_idx on public.capital_flow_entries (user_id, transfer_group_id)
  where transfer_group_id is not null;
