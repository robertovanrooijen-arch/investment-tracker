-- Adds minimal idempotency support for CSV-based transaction imports:
-- `source` (which importer/provider produced the row), `external_id` (the
-- provider's own transaction id), and `source_datetime` (the full UTC
-- instant, since `transactions.date` is a plain `date` column with no time
-- component and a CSV import must not lose precision it was given).
--
-- All three columns are nullable and additive — existing rows are
-- untouched. The unique index only applies where external_id IS NOT NULL,
-- so manually entered transactions (which never set these columns) are
-- unaffected. A second import run with the same (user_id, source,
-- external_id) triple will violate the index and fail the insert, which is
-- the whole point: it turns "don't double-import" into a DB-enforced
-- guarantee instead of an app-level convention.
--
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_datetime timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_user_source_external_id_key
  ON transactions(user_id, source, external_id)
  WHERE external_id IS NOT NULL;
