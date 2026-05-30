-- Add contribution-tracking columns to transactions.
--
-- is_contribution: true when this transaction represents new external money
--   entering the portfolio (e.g. salary deposit, cash from bank).
--   false for reinvestments, sells, dividends, and anything else.
--
-- contribution_source: free-text label for the origin of the money.
--   Set to 'external' by the UI when marking a transaction as a contribution.
--   Nullable — not required.
--
-- Safe to run multiple times (IF NOT EXISTS).

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS is_contribution boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS contribution_source text;
