-- M16 · Write the portfolio row and all position rows in one database
-- transaction. The function is intentionally service-role only: refresh and
-- cron routes authenticate the caller first, then use the server-side key.

create or replace function public.write_central_snapshots_atomic(
  p_portfolio jsonb,
  p_positions jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_date date;
  v_position_count integer := 0;
  v_portfolio public.portfolio_snapshots%rowtype;
begin
  if jsonb_typeof(p_portfolio) is distinct from 'object' then
    raise exception 'portfolio snapshot must be a JSON object';
  end if;
  if jsonb_typeof(p_positions) is distinct from 'array' then
    raise exception 'position snapshots must be a JSON array';
  end if;

  v_user_id := nullif(p_portfolio ->> 'user_id', '')::uuid;
  v_date := nullif(p_portfolio ->> 'date', '')::date;
  if v_user_id is null or v_date is null then
    raise exception 'portfolio snapshot needs user_id and date';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_positions) as item
    where nullif(item ->> 'user_id', '')::uuid is distinct from v_user_id
       or nullif(item ->> 'date', '')::date is distinct from v_date
  ) then
    raise exception 'all position snapshots must have the portfolio user_id and date';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_positions) as item
    left join public.investments investment
      on investment.id = nullif(item ->> 'investment_id', '')::uuid
     and investment.user_id = v_user_id
    where investment.id is null
  ) then
    raise exception 'a position snapshot references an investment outside this account';
  end if;

  if p_portfolio ? 'method' then
    insert into public.portfolio_snapshots (
      user_id, date, total_value_eur, total_invested_eur,
      total_realized_eur, total_unrealized_eur, total_ever_invested_eur,
      snapshot_source, updated_at, stale_positions, fx_incomplete_positions,
      method, pl_definition_version, implied_cash_eur, positions_incomplete
    )
    select
      v_user_id, v_date, r.total_value_eur, r.total_invested_eur,
      r.total_realized_eur, r.total_unrealized_eur, r.total_ever_invested_eur,
      r.snapshot_source, r.updated_at, r.stale_positions, r.fx_incomplete_positions,
      r.method, r.pl_definition_version, r.implied_cash_eur, r.positions_incomplete
    from jsonb_to_record(p_portfolio) as r(
      total_value_eur numeric, total_invested_eur numeric,
      total_realized_eur numeric, total_unrealized_eur numeric,
      total_ever_invested_eur numeric, snapshot_source text, updated_at timestamptz,
      stale_positions integer, fx_incomplete_positions integer, method text,
      pl_definition_version smallint, implied_cash_eur numeric,
      positions_incomplete integer
    )
    on conflict (user_id, date) do update set
      total_value_eur = excluded.total_value_eur,
      total_invested_eur = excluded.total_invested_eur,
      total_realized_eur = excluded.total_realized_eur,
      total_unrealized_eur = excluded.total_unrealized_eur,
      total_ever_invested_eur = excluded.total_ever_invested_eur,
      snapshot_source = excluded.snapshot_source,
      updated_at = excluded.updated_at,
      stale_positions = excluded.stale_positions,
      fx_incomplete_positions = excluded.fx_incomplete_positions,
      method = excluded.method,
      pl_definition_version = excluded.pl_definition_version,
      implied_cash_eur = excluded.implied_cash_eur,
      positions_incomplete = excluded.positions_incomplete;
  else
    insert into public.portfolio_snapshots (
      user_id, date, total_value_eur, total_invested_eur,
      total_realized_eur, total_unrealized_eur, total_ever_invested_eur,
      snapshot_source, updated_at
    )
    select
      v_user_id, v_date, r.total_value_eur, r.total_invested_eur,
      r.total_realized_eur, r.total_unrealized_eur, r.total_ever_invested_eur,
      r.snapshot_source, r.updated_at
    from jsonb_to_record(p_portfolio) as r(
      total_value_eur numeric, total_invested_eur numeric,
      total_realized_eur numeric, total_unrealized_eur numeric,
      total_ever_invested_eur numeric, snapshot_source text, updated_at timestamptz
    )
    on conflict (user_id, date) do update set
      total_value_eur = excluded.total_value_eur,
      total_invested_eur = excluded.total_invested_eur,
      total_realized_eur = excluded.total_realized_eur,
      total_unrealized_eur = excluded.total_unrealized_eur,
      total_ever_invested_eur = excluded.total_ever_invested_eur,
      snapshot_source = excluded.snapshot_source,
      updated_at = excluded.updated_at;
  end if;

  if jsonb_array_length(p_positions) > 0 then
    if (p_positions -> 0) ? 'method' then
      insert into public.investment_snapshots (
        user_id, investment_id, date, value_eur, remaining_cost_basis_eur,
        realized_profit_eur, unrealized_profit_eur, quantity,
        current_price_native, currency, snapshot_source, updated_at,
        price_status, price_as_of, fx_eur_per_unit, method,
        pl_definition_version, unit, quality, fetched_at
      )
      select
        v_user_id, r.investment_id, v_date, r.value_eur, r.remaining_cost_basis_eur,
        r.realized_profit_eur, r.unrealized_profit_eur, r.quantity,
        r.current_price_native, r.currency, r.snapshot_source, r.updated_at,
        r.price_status, r.price_as_of, r.fx_eur_per_unit, r.method,
        r.pl_definition_version, r.unit, r.quality, r.fetched_at
      from jsonb_to_recordset(p_positions) as r(
        investment_id uuid, value_eur numeric, remaining_cost_basis_eur numeric,
        realized_profit_eur numeric, unrealized_profit_eur numeric,
        quantity numeric, current_price_native numeric, currency text,
        snapshot_source text, updated_at timestamptz, price_status text,
        price_as_of timestamptz, fx_eur_per_unit numeric, method text,
        pl_definition_version smallint, unit text, quality text, fetched_at timestamptz
      )
      on conflict (user_id, investment_id, date) do update set
        value_eur = excluded.value_eur,
        remaining_cost_basis_eur = excluded.remaining_cost_basis_eur,
        realized_profit_eur = excluded.realized_profit_eur,
        unrealized_profit_eur = excluded.unrealized_profit_eur,
        quantity = excluded.quantity,
        current_price_native = excluded.current_price_native,
        currency = excluded.currency,
        snapshot_source = excluded.snapshot_source,
        updated_at = excluded.updated_at,
        price_status = excluded.price_status,
        price_as_of = excluded.price_as_of,
        fx_eur_per_unit = excluded.fx_eur_per_unit,
        method = excluded.method,
        pl_definition_version = excluded.pl_definition_version,
        unit = excluded.unit,
        quality = excluded.quality,
        fetched_at = excluded.fetched_at;
    else
      insert into public.investment_snapshots (
        user_id, investment_id, date, value_eur, remaining_cost_basis_eur,
        realized_profit_eur, unrealized_profit_eur, quantity,
        current_price_native, currency, snapshot_source, updated_at
      )
      select
        v_user_id, r.investment_id, v_date, r.value_eur, r.remaining_cost_basis_eur,
        r.realized_profit_eur, r.unrealized_profit_eur, r.quantity,
        r.current_price_native, r.currency, r.snapshot_source, r.updated_at
      from jsonb_to_recordset(p_positions) as r(
        investment_id uuid, value_eur numeric, remaining_cost_basis_eur numeric,
        realized_profit_eur numeric, unrealized_profit_eur numeric,
        quantity numeric, current_price_native numeric, currency text,
        snapshot_source text, updated_at timestamptz
      )
      on conflict (user_id, investment_id, date) do update set
        value_eur = excluded.value_eur,
        remaining_cost_basis_eur = excluded.remaining_cost_basis_eur,
        realized_profit_eur = excluded.realized_profit_eur,
        unrealized_profit_eur = excluded.unrealized_profit_eur,
        quantity = excluded.quantity,
        current_price_native = excluded.current_price_native,
        currency = excluded.currency,
        snapshot_source = excluded.snapshot_source,
        updated_at = excluded.updated_at;
    end if;
  end if;

  v_position_count := jsonb_array_length(p_positions);
  select * into strict v_portfolio
  from public.portfolio_snapshots
  where user_id = v_user_id and date = v_date;

  return jsonb_build_object(
    'portfolio', to_jsonb(v_portfolio),
    'position_count', v_position_count
  );
end;
$$;

revoke all on function public.write_central_snapshots_atomic(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.write_central_snapshots_atomic(jsonb, jsonb)
  to service_role;
