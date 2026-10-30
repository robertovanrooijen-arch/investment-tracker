-- M7 (+ M11) · Snapshot quality, method, P/L definition version and provenance.
-- Run BEFORE deploying the code with SNAPSHOT_QUALITY_COLUMNS=enabled. Column
-- names match lib/domain/snapshot.ts, lib/domain/refresh.ts and
-- lib/valuation/historical-valuation.ts (proposeSnapshotRows).
alter table public.investment_snapshots
  add column price_status          text check (price_status is null or price_status in ('fresh', 'stale', 'missing', 'not_applicable')),
  add column price_as_of           timestamptz,
  add column fx_eur_per_unit       numeric(20,10),
  add column method                text check (method is null or method in ('live', 'reconstructed', 'statement', 'import')),
  add column pl_definition_version smallint check (pl_definition_version is null or pl_definition_version in (1, 2)),
  -- M11: provenance of reconstructed / statement rows.
  add column price_date            date,
  add column fx_date               date,
  add column unit                  text check (unit is null or unit in ('unit', 'gram', 'troy_ounce')),
  add column quality               text check (quality is null or quality in (
    'official', 'official_quantity_mismatch', 'exact', 'benchmark_only', 'closed',
    'missing_price', 'stale_price', 'missing_fx', 'unit_unknown', 'not_reconstructable')),
  add column fetched_at            timestamptz;

alter table public.portfolio_snapshots
  add column stale_positions         integer,
  add column fx_incomplete_positions integer,
  add column method                  text check (method is null or method in ('live', 'reconstructed', 'statement', 'import')),
  add column pl_definition_version   smallint check (pl_definition_version is null or pl_definition_version in (1, 2)),
  -- M11: implied (derived) cash is AUDIT information only, never part of the total.
  add column implied_cash_eur        numeric(14,2),
  add column positions_incomplete    integer;

-- Existing rows: definition v1, method from the ACTUAL source (not 'live' by default).
-- Deliberately no column default: a row without a version stays recognisable as v1/unknown.
update public.portfolio_snapshots set pl_definition_version = 1,
  method = case
    when snapshot_source in ('cron', 'manual_refresh') then 'live'
    when snapshot_source like 'source_backed%' or snapshot_source like '%corrected%' then 'statement'
    else 'import' end;
update public.investment_snapshots set pl_definition_version = 1,
  method = case
    when snapshot_source in ('cron', 'manual_refresh') then 'live'
    when snapshot_source like 'source_backed%' or snapshot_source like '%corrected%' then 'statement'
    else 'import' end;
