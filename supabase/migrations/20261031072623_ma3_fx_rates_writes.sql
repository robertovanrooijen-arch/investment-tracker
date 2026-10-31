-- MA-3 · POST-DEPLOY ONLY. fx_rates becomes writable by trusted server code
-- only. Run after the deploy whose FX routes write with the service role;
-- before that, the current production code still writes fx_rates as the user.
revoke insert, update, delete, truncate on public.fx_rates from public, anon, authenticated;
revoke select on public.fx_rates from public, anon;
grant select on public.fx_rates to authenticated;
grant all on public.fx_rates to service_role;

-- Replace whatever policies exist (names unknown until MA-0) by exactly one read policy.
do $$
declare
  p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'fx_rates' loop
    raise notice 'dropping policy % on public.fx_rates', p.policyname;
    execute format('drop policy %I on public.fx_rates', p.policyname);
  end loop;
end $$;
create policy fx_rates_select_authenticated on public.fx_rates for select to authenticated using (true);
