-- M3 · Import runs (audit trail of every import). Owner reads; only service_role writes.
create table public.import_runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  importer         text not null,
  importer_version text not null,
  status           text not null default 'started' check (status in ('started', 'succeeded', 'failed')),
  input_files      jsonb not null default '[]'::jsonb,  -- [{name, sha256, rows}]
  expected         jsonb,
  actual           jsonb,
  error            text,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  constraint import_runs_id_user_key unique (id, user_id)
);
create index import_runs_user_started_idx on public.import_runs (user_id, started_at desc);

alter table public.import_runs enable row level security;
revoke all on table public.import_runs from public, anon, authenticated;
grant select on table public.import_runs to authenticated;
grant all on table public.import_runs to service_role;

create policy import_runs_select_own on public.import_runs for select to authenticated
  using ((select auth.uid()) = user_id);
