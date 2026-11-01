-- M17 · One atomic, idempotent batch for source-backed broker trades.
-- Parsing and investment matching happen in the application. PostgreSQL
-- validates ownership and duplicate identity again before any row is written.

create or replace function public.apply_trade_import_atomic(
  p_user_id uuid,
  p_importer text,
  p_input_files jsonb,
  p_rows jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_input_count integer;
  v_inserted integer;
begin
  if p_user_id is null then raise exception 'user_id is required'; end if;
  if nullif(btrim(p_importer), '') is null then raise exception 'importer is required'; end if;
  if jsonb_typeof(p_input_files) is distinct from 'array' then raise exception 'input_files must be an array'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'rows must be an array'; end if;

  v_input_count := jsonb_array_length(p_rows);

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(source text, external_id text)
    where nullif(btrim(r.source), '') is null or nullif(btrim(r.external_id), '') is null
  ) then
    raise exception 'every imported trade needs source and external_id';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(source text, external_id text)
    group by r.source, r.external_id
    having count(*) > 1
  ) then
    raise exception 'duplicate source/external_id inside the import file';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(investment_id uuid)
    left join public.investments investment
      on investment.id = r.investment_id and investment.user_id = p_user_id
    where investment.id is null
  ) then
    raise exception 'an imported trade references an investment outside this account';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(type text, quantity numeric, price_per_unit numeric)
    where r.type not in ('buy', 'sell', 'dividend', 'interest', 'fee')
       or (r.type in ('buy', 'sell') and (r.quantity is null or r.quantity <= 0 or r.price_per_unit is null or r.price_per_unit <= 0))
  ) then
    raise exception 'invalid imported trade type, quantity or price';
  end if;

  -- Same source key with different economics is a conflict, never an update.
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      investment_id uuid, type text, quantity numeric, price_per_unit numeric,
      amount numeric, fee numeric, date date, price_currency text,
      fee_currency text, fx_rate_to_eur numeric, source text, external_id text
    )
    join public.transactions existing
      on existing.user_id = p_user_id
     and existing.source = r.source
     and existing.external_id = r.external_id
    where row(
      existing.investment_id, existing.type, existing.quantity,
      existing.price_per_unit, existing.amount, existing.fee, existing.date,
      existing.price_currency, existing.fee_currency, existing.fx_rate_to_eur
    ) is distinct from row(
      r.investment_id, r.type, r.quantity, r.price_per_unit, r.amount,
      coalesce(r.fee, 0), r.date, r.price_currency, r.fee_currency, r.fx_rate_to_eur
    )
  ) then
    raise exception 'an existing source key has different content';
  end if;

  -- A hand-entered/PDF order and the later CSV row may have different keys.
  -- Match the economic execution and refuse the CSV until the keys are linked.
  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(
      investment_id uuid, type text, date date, quantity numeric,
      price_per_unit numeric, amount numeric, gross_amount numeric,
      source text, external_id text
    )
    join public.transactions existing
      on existing.user_id = p_user_id
     and existing.investment_id = r.investment_id
     and existing.type = r.type
     and existing.date = r.date
     and round(coalesce(existing.quantity, 0), 6) = round(coalesce(r.quantity, 0), 6)
     and round(coalesce(existing.gross_amount, existing.quantity * existing.price_per_unit, existing.amount, 0), 2)
         = round(coalesce(r.gross_amount, r.quantity * r.price_per_unit, r.amount, 0), 2)
     and (existing.source, existing.external_id) is distinct from (r.source, r.external_id)
    where r.type in ('buy', 'sell')
  ) then
    raise exception 'the same economic order already exists under another source key';
  end if;

  insert into public.import_runs (
    user_id, importer, importer_version, status, input_files, expected
  ) values (
    p_user_id, p_importer, '1', 'started', p_input_files,
    jsonb_build_object('trades', v_input_count)
  ) returning id into v_run_id;

  insert into public.transactions (
    user_id, investment_id, type, quantity, price_per_unit, amount, fee, date,
    notes, price_currency, fee_currency, fx_rate_to_eur, recurring_rule_id,
    is_contribution, contribution_source, source, external_id, source_datetime,
    import_run_id, order_group_id, amount_semantics, gross_amount,
    net_cash_amount, fx_rate_date, amount_quality, calc_method, value_date
  )
  select
    p_user_id, r.investment_id, r.type, r.quantity, r.price_per_unit,
    r.amount, coalesce(r.fee, 0), r.date, r.notes, r.price_currency,
    r.fee_currency, r.fx_rate_to_eur, null, false, null, r.source,
    r.external_id, r.source_datetime, v_run_id, r.order_group_id,
    r.amount_semantics, r.gross_amount, r.net_cash_amount, r.fx_rate_date,
    r.amount_quality, r.calc_method, r.value_date
  from jsonb_to_recordset(p_rows) as r(
    investment_id uuid, type text, quantity numeric, price_per_unit numeric,
    amount numeric, fee numeric, date date, notes text, price_currency text,
    fee_currency text, fx_rate_to_eur numeric, source text, external_id text,
    source_datetime timestamptz, order_group_id text, amount_semantics text,
    gross_amount numeric, net_cash_amount numeric, fx_rate_date date,
    amount_quality text, calc_method text, value_date date
  )
  on conflict (user_id, source, external_id) do nothing;

  get diagnostics v_inserted = row_count;

  update public.import_runs
  set status = 'succeeded',
      actual = jsonb_build_object(
        'input_trades', v_input_count,
        'inserted_trades', v_inserted,
        'already_present', v_input_count - v_inserted
      ),
      finished_at = now()
  where id = v_run_id;

  return jsonb_build_object(
    'run_id', v_run_id,
    'input', v_input_count,
    'inserted', v_inserted,
    'already_present', v_input_count - v_inserted
  );
end;
$$;

revoke all on function public.apply_trade_import_atomic(uuid, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_trade_import_atomic(uuid, text, jsonb, jsonb)
  to service_role;
