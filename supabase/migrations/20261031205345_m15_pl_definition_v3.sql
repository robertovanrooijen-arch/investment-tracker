alter table public.portfolio_snapshots
  drop constraint if exists portfolio_snapshots_pl_definition_version_check;
alter table public.portfolio_snapshots
  add constraint portfolio_snapshots_pl_definition_version_check
  check (pl_definition_version is null or pl_definition_version in (1, 2, 3));

alter table public.investment_snapshots
  drop constraint if exists investment_snapshots_pl_definition_version_check;
alter table public.investment_snapshots
  add constraint investment_snapshots_pl_definition_version_check
  check (pl_definition_version is null or pl_definition_version in (1, 2, 3));
