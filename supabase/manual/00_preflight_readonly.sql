-- MA-0 · READ-ONLY preflight. Run on the target (branch first) and keep the
-- output with the change record. Changes nothing.

-- Indexes, policies, grants, functions, triggers as they are now.
select tablename, indexname, indexdef
from pg_indexes where schemaname = 'public' order by 1, 2;

select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' order by 1, 2;

select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated', 'public')
group by 1, 2 order by 1, 2;

select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer,
       p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1;

select event_object_schema, event_object_table, trigger_name, action_timing, event_manipulation, action_statement
from information_schema.triggers where event_object_schema in ('public', 'auth') order by 1, 2, 3;

-- Data checks the migrations rely on (each expected result in the comment).
select count(*) as dup_source_keys from (                                     -- expect 0 (M5)
  select user_id, source, external_id from public.transactions
  where external_id is not null group by 1, 2, 3 having count(*) > 1) d;
select count(*) as tx_owner_mismatch from public.transactions t                -- expect 0 (M5)
join public.investments i on i.id = t.investment_id where i.user_id <> t.user_id;
select count(*) as cfe_year_mismatch from public.capital_flow_entries          -- expect 0 (M6)
where year <> extract(year from flow_date)::int;
select count(*) as commodity_fields_missing from public.investments            -- known: 1 (U2), M4 adds NOT VALID
where type = 'commodity' and (commodity_kind is null or quantity_unit is null);
