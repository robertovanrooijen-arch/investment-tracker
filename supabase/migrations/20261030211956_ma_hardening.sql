-- MA · Hardening. Safe to run while the current production code is live.
-- Run as one transaction (the Supabase CLI does this per file; in the SQL
-- editor wrap it in begin/commit). Requires the MA-0 preflight output.

-- MA-1. set_updated_at: fixed, empty search_path (its body only uses now()).
do $$
begin
  if to_regprocedure('public.set_updated_at()') is not null then
    alter function public.set_updated_at() set search_path = '';
  end if;
end $$;

-- MA-2. Indexes for FKs and for the user_id column every RLS policy filters on.
create index if not exists capital_flow_entries_user_id_idx on public.capital_flow_entries (user_id);
create index if not exists investment_snapshots_investment_id_idx on public.investment_snapshots (investment_id);
create index if not exists investments_user_id_idx on public.investments (user_id);
create index if not exists transactions_user_id_idx on public.transactions (user_id);
create index if not exists transactions_investment_id_idx on public.transactions (investment_id);
create index if not exists recurring_transactions_user_id_idx on public.recurring_transactions (user_id);

-- MA-4. Security-definer functions in public are never callable by clients.
-- A definer function used inside a policy would break that policy once
-- revoked, so that case stops the migration for a human decision instead.
do $$
declare
  f record;
begin
  for f in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and (coalesce(qual, '') ~ ('\m' || f.proname || '\(') or coalesce(with_check, '') ~ ('\m' || f.proname || '\('))
    ) then
      raise exception 'security definer function public.%(%) is used in a policy; review before revoking', f.proname, f.args;
    end if;
    execute format('revoke execute on function public.%I(%s) from public, anon, authenticated', f.proname, f.args);
    execute format('grant execute on function public.%I(%s) to service_role', f.proname, f.args);
  end loop;
end $$;

-- MA-5. Owner policies: evaluate auth.uid() once per statement and apply to
-- the authenticated role only. Policies for other roles, policies already
-- using (select auth.uid()) and policies without auth.uid() are left alone.
-- Public-role policies on fx_rates are handled after deploy (post-deploy MA-3).
do $$
declare
  p record;
  stmt text;
begin
  for p in
    select schemaname, tablename, policyname, roles, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename <> 'fx_rates'
      and roles <@ array['public', 'authenticated']::name[]
      and (coalesce(qual, '') ~ 'auth\.uid\(\)' or coalesce(with_check, '') ~ 'auth\.uid\(\)')
      and coalesce(qual, '') || coalesce(with_check, '') !~* 'select auth\.uid'
  loop
    stmt := format('alter policy %I on %I.%I to authenticated', p.policyname, p.schemaname, p.tablename);
    if p.qual is not null then
      stmt := stmt || ' using (' || replace(p.qual, 'auth.uid()', '(select auth.uid())') || ')';
    end if;
    if p.with_check is not null then
      stmt := stmt || ' with check (' || replace(p.with_check, 'auth.uid()', '(select auth.uid())') || ')';
    end if;
    raise notice '%', stmt;
    execute stmt;
  end loop;
end $$;
