create index if not exists broker_value_observations_investment_owner_idx
  on public.broker_value_observations (investment_id, user_id);
