-- Capital flow ledger: tracks money moving between the user's bank/income
-- and their portfolio platforms.  Intentionally separate from the
-- investments / transactions system.
--
-- Safe to run multiple times (IF NOT EXISTS / DROP POLICY IF EXISTS).

CREATE TABLE IF NOT EXISTS capital_flow_entries (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_date   date          NOT NULL,
  year        integer       NOT NULL,
  platform    text          NOT NULL,
  direction   text          NOT NULL CHECK (direction IN ('to_portfolio', 'from_portfolio')),
  amount_eur  numeric(14,2) NOT NULL,
  source      text,
  notes       text,
  created_at  timestamptz   DEFAULT now()
);

-- ── Row-level security ────────────────────────────────────────────────────────

ALTER TABLE capital_flow_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cfe_select" ON capital_flow_entries;
DROP POLICY IF EXISTS "cfe_insert" ON capital_flow_entries;
DROP POLICY IF EXISTS "cfe_update" ON capital_flow_entries;
DROP POLICY IF EXISTS "cfe_delete" ON capital_flow_entries;

CREATE POLICY "cfe_select" ON capital_flow_entries
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "cfe_insert" ON capital_flow_entries
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "cfe_update" ON capital_flow_entries
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "cfe_delete" ON capital_flow_entries
  FOR DELETE USING (auth.uid() = user_id);
