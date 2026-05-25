-- =============================================================================
-- DEGIRO Annual Snapshot Import  (portfolio-level only, no investment rows)
-- user_id : 177c72a8-ca9b-469a-b48b-f00db89ee632
-- Source  : DEGIRO annual statements + flatex deposit/withdrawal reports
-- Safe to rerun: all inserts use ON CONFLICT … DO UPDATE.
--
-- Cost-basis approach (intentional estimate):
--   total_invested_eur  = cumulative net contributions (deposits − withdrawals)
--   This is NOT per-asset cost basis; it is portfolio-level invested capital.
--   The /history chart uses it as a fallback for dates with no investment_snapshots.
--
-- Δ% mode note:
--   The 2024-01-01 anchor has total_value_eur = 0.
--   When the "All" range is selected the chart anchors Δ% at this zero baseline,
--   which makes the Δ% mode degenerate (all subsequent points ÷ 0 → 0%).
--   Use € or Δ€ mode when viewing the full "All" range.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0. CLEANUP VERIFICATION  (run first; all counts should be 0)
-- ─────────────────────────────────────────────────────────────────────────────
SELECT 'portfolio_snapshots (historical_import)' AS check_target, COUNT(*) AS remaining
FROM portfolio_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND snapshot_source = 'historical_import'
UNION ALL
SELECT 'investment_snapshots (historical_import)', COUNT(*)
FROM investment_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND snapshot_source = 'historical_import'
UNION ALL
SELECT 'trump_media_investment', COUNT(*)
FROM investments
WHERE id = 'a1b2c3d4-e5f6-7890-abcd-000000000001';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ANNUAL IMPORT
--    Columns stored:
--      total_value_eur         = annual portfolio value (from DEGIRO annual statement)
--      total_invested_eur      = cumulative net contributions (deposits − withdrawals)
--      total_ever_invested_eur = same as total_invested_eur (gross deposits, approx)
--      total_unrealized_eur    = total_value_eur − total_invested_eur
--      total_realized_eur      = 0  (not available from statements)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO portfolio_snapshots (
  user_id,
  date,
  total_value_eur,
  total_invested_eur,
  total_ever_invested_eur,
  total_unrealized_eur,
  total_realized_eur,
  snapshot_source,
  updated_at
) VALUES
  -- 2024-01-01: portfolio start — nothing invested yet
  (
    '177c72a8-ca9b-469a-b48b-f00db89ee632',
    '2024-01-01',
       0.00,   -- total_value_eur       (DEGIRO 2024 annual statement)
       0.00,   -- total_invested_eur    (0 net contributions at start)
       0.00,   -- total_ever_invested_eur
       0.00,   -- total_unrealized_eur  (0 - 0)
       0.00,   -- total_realized_eur
    'degiro_annual_import',
    NOW()
  ),

  -- 2024-12-31: end of 2024
  -- Deposits 2024: 890.00 | Withdrawals 2024: 0.00 | Cumulative net: 890.00
  (
    '177c72a8-ca9b-469a-b48b-f00db89ee632',
    '2024-12-31',
     971.65,   -- total_value_eur       (DEGIRO 2024 annual statement)
     890.00,   -- total_invested_eur    (cumulative net contributions)
     890.00,   -- total_ever_invested_eur
      81.65,   -- total_unrealized_eur  (971.65 − 890.00)
       0.00,   -- total_realized_eur
    'degiro_annual_import',
    NOW()
  ),

  -- 2025-01-01: mirror of 2024-12-31 (continuity bridge, same value)
  (
    '177c72a8-ca9b-469a-b48b-f00db89ee632',
    '2025-01-01',
     971.65,   -- total_value_eur       (DEGIRO 2025 annual statement opening balance)
     890.00,   -- total_invested_eur    (same cumulative net as 2024-12-31)
     890.00,   -- total_ever_invested_eur
      81.65,   -- total_unrealized_eur  (971.65 − 890.00)
       0.00,   -- total_realized_eur
    'degiro_annual_import',
    NOW()
  ),

  -- 2025-12-31: end of 2025
  -- 2025 deposits: 4030.00 | 2025 withdrawals: 1850.00 | 2025 net: +2180.00
  -- Cumulative net contributions: 890.00 + 2180.00 = 3070.00
  (
    '177c72a8-ca9b-469a-b48b-f00db89ee632',
    '2025-12-31',
    3552.31,   -- total_value_eur       (DEGIRO 2025 annual statement)
    3070.00,   -- total_invested_eur    (cumulative net contributions)
    3070.00,   -- total_ever_invested_eur
     482.31,   -- total_unrealized_eur  (3552.31 − 3070.00)
       0.00,   -- total_realized_eur
    'degiro_annual_import',
    NOW()
  )

ON CONFLICT (user_id, date) DO UPDATE SET
  total_value_eur         = EXCLUDED.total_value_eur,
  total_invested_eur      = EXCLUDED.total_invested_eur,
  total_ever_invested_eur = EXCLUDED.total_ever_invested_eur,
  total_unrealized_eur    = EXCLUDED.total_unrealized_eur,
  total_realized_eur      = EXCLUDED.total_realized_eur,
  snapshot_source         = EXCLUDED.snapshot_source,
  updated_at              = EXCLUDED.updated_at;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. VERIFICATION
-- ─────────────────────────────────────────────────────────────────────────────

-- Confirm all 4 rows landed correctly
SELECT
  date,
  total_value_eur,
  total_invested_eur,
  total_unrealized_eur,
  snapshot_source
FROM portfolio_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND snapshot_source = 'degiro_annual_import'
ORDER BY date;

-- Expected:
-- 2024-01-01  |    0.00 |    0.00 |   0.00 | degiro_annual_import
-- 2024-12-31  |  971.65 |  890.00 |  81.65 | degiro_annual_import
-- 2025-01-01  |  971.65 |  890.00 |  81.65 | degiro_annual_import
-- 2025-12-31  | 3552.31 | 3070.00 | 482.31 | degiro_annual_import

-- Confirm live investments are untouched
SELECT name, ticker, current_price, current_value, updated_at
FROM investments
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
ORDER BY name;
