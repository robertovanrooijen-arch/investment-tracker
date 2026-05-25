-- =============================================================================
-- Bitvavo 2025 Snapshot Import  (test account only)
-- user_id    : 177c72a8-ca9b-469a-b48b-f00db89ee632
-- investment : Bitcoin BTC-EUR (108fb5ea-3a13-4a55-a6cb-701b86c40f08)
-- Source     : Bitvavo balance statement 2025
--
-- What this inserts:
--   1. investment_snapshots — Bitcoin on 2025-12-31 (Bitvavo reported value)
--   2. portfolio_snapshots  — 2025-12-31 updated to DEGIRO + Bitvavo combined
--
-- Why we update portfolio_snapshots:
--   The chart reads total_value_eur from portfolio_snapshots.
--   If we leave the DEGIRO-only value (3552.31), the Total value line will not
--   include the Bitvavo Bitcoin value (743.29). The combined row (4295.60)
--   is the correct portfolio total for that date.
--
-- Known limitation (chart behaviour on 2025-12-31):
--   Once an investment_snapshot exists for a date, the chart uses
--   investment_snapshots aggregates for cost_basis_eur and total_profit_eur
--   (hasInvSnaps = true, see portfolio-history-chart.tsx:302).
--   We have no per-investment DEGIRO snapshot data for this date, so:
--     cost_basis_eur      = 885.08  (Bitvavo BTC only, not DEGIRO 3070.00)
--     total_profit_eur    = -141.79 (Bitvavo unrealized only)
--     invested_assets_eur = 743.29  (Bitvavo BTC only)
--   total_value_eur (from portfolio_snapshots) = 4295.60 is correct.
--   This is the best achievable without a per-investment DEGIRO breakdown.
--
-- Why we do NOT add a 2025-01-01 Bitcoin snapshot:
--   Bitvavo held 0 BTC on 2025-01-01 (first buy was 2025-05-30).
--   Adding a zero-value snapshot would flip hasInvSnaps=true for that date,
--   replacing the DEGIRO cost_basis fallback (3070 → 0). This would break the
--   existing DEGIRO annual data for that date.
--
-- NOT touched: transactions, investments, recurring_rules.
-- Safe to rerun: all writes use ON CONFLICT … DO UPDATE.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0. PRE-RUN CHECKS  (run first; verify before proceeding)
-- ─────────────────────────────────────────────────────────────────────────────

-- Check current portfolio_snapshot for 2025-12-31
-- Expected: 1 row, total_value_eur = 3552.31, source = degiro_annual_import
SELECT date, total_value_eur, total_invested_eur, total_unrealized_eur, snapshot_source
FROM portfolio_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND date    = '2025-12-31';

-- Check for any existing Bitcoin snapshot on 2025-12-31
-- Expected: 0 rows
SELECT date, value_eur, remaining_cost_basis_eur, quantity, snapshot_source
FROM investment_snapshots
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND date          = '2025-12-31';

-- Confirm investments.current_price and current_value unchanged after import
SELECT id, current_price, current_value, updated_at
FROM investments
WHERE id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. INVESTMENT SNAPSHOT — Bitcoin 2025-12-31
--    Source: Bitvavo balance statement
--      value_eur              = 743.29 (digital assets balance on 31-12-2025)
--      remaining_cost_basis   = 885.08 (total BTC cost incl. fees, 18 buys)
--      unrealized_profit      = 743.29 − 885.08 = −141.79
--      quantity               = 0.00998288 BTC
--      current_price_native   = 743.29 / 0.00998288 ≈ 74456 EUR/BTC
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO investment_snapshots (
  user_id,
  investment_id,
  date,
  value_eur,
  remaining_cost_basis_eur,
  realized_profit_eur,
  unrealized_profit_eur,
  quantity,
  current_price_native,
  currency,
  snapshot_source,
  updated_at
) VALUES (
  '177c72a8-ca9b-469a-b48b-f00db89ee632',
  '108fb5ea-3a13-4a55-a6cb-701b86c40f08',
  '2025-12-31',
    743.29,   -- value_eur
    885.08,   -- remaining_cost_basis_eur  (cost ex-fee 882.78 + fees 2.29 = 885.08)
      0.00,   -- realized_profit_eur       (no sells in 2025)
   -141.79,   -- unrealized_profit_eur     (743.29 − 885.08)
  0.00998288, -- quantity BTC
  74456.00,   -- current_price_native EUR/BTC  (743.29 / 0.00998288)
  'EUR',
  'bitvavo_2025_import',
  NOW()
)
ON CONFLICT (user_id, investment_id, date) DO UPDATE SET
  value_eur              = EXCLUDED.value_eur,
  remaining_cost_basis_eur = EXCLUDED.remaining_cost_basis_eur,
  realized_profit_eur    = EXCLUDED.realized_profit_eur,
  unrealized_profit_eur  = EXCLUDED.unrealized_profit_eur,
  quantity               = EXCLUDED.quantity,
  current_price_native   = EXCLUDED.current_price_native,
  currency               = EXCLUDED.currency,
  snapshot_source        = EXCLUDED.snapshot_source,
  updated_at             = EXCLUDED.updated_at;


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. PORTFOLIO SNAPSHOT — 2025-12-31 combined (DEGIRO + Bitvavo)
--
--    DEGIRO annual values (from degiro_annual_import):
--      total_value_eur    = 3552.31
--      total_invested_eur = 3070.00
--      total_unrealized   =  482.31
--
--    Bitvavo values (from Bitvavo balance statement + transaction cost):
--      total_value_eur    =  743.29
--      total_invested_eur =  885.08
--      total_unrealized   = -141.79
--
--    Combined:
--      total_value_eur         = 3552.31 + 743.29 = 4295.60
--      total_invested_eur      = 3070.00 + 885.08 = 3955.08
--      total_ever_invested_eur = 3955.08  (no withdrawals on either platform)
--      total_unrealized_eur    =  482.31 + (−141.79) = 340.52
--      total_realized_eur      = 0.00
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
) VALUES (
  '177c72a8-ca9b-469a-b48b-f00db89ee632',
  '2025-12-31',
  4295.60,   -- total_value_eur         (3552.31 DEGIRO + 743.29 Bitvavo)
  3955.08,   -- total_invested_eur      (3070.00 DEGIRO + 885.08 Bitvavo)
  3955.08,   -- total_ever_invested_eur
   340.52,   -- total_unrealized_eur    (482.31 DEGIRO + (−141.79) Bitvavo)
     0.00,   -- total_realized_eur
  'degiro_annual_import+bitvavo_2025_import',
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
-- 3. VERIFICATION
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Bitcoin snapshot exists with correct values
-- Expected: 1 row, value_eur=743.29, remaining_cost_basis_eur=885.08,
--           unrealized_profit_eur=-141.79, quantity=0.00998288
SELECT
  date,
  value_eur,
  remaining_cost_basis_eur,
  unrealized_profit_eur,
  realized_profit_eur,
  quantity,
  snapshot_source
FROM investment_snapshots
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND date          = '2025-12-31';

-- 2. Portfolio snapshot updated to combined values
-- Expected: total_value=4295.60, invested=3955.08, unrealized=340.52
SELECT
  date,
  total_value_eur,
  total_invested_eur,
  total_unrealized_eur,
  snapshot_source
FROM portfolio_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND date    = '2025-12-31';

-- 3. All 2025-12-31 snapshots across both tables for this user
SELECT 'portfolio' AS table_name, date::text, total_value_eur AS value_eur, snapshot_source
FROM portfolio_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632' AND date = '2025-12-31'
UNION ALL
SELECT 'investment_snapshot', date::text, value_eur, snapshot_source
FROM investment_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632' AND date = '2025-12-31'
ORDER BY table_name;

-- 4. Full snapshot timeline for this user (confirm DEGIRO rows untouched)
SELECT date, total_value_eur, total_invested_eur, total_unrealized_eur, snapshot_source
FROM portfolio_snapshots
WHERE user_id = '177c72a8-ca9b-469a-b48b-f00db89ee632'
ORDER BY date;

-- 5. Confirm investments.current_price and current_value unchanged
SELECT id, current_price, current_value, updated_at
FROM investments
WHERE id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08';
-- Must match values from pre-run check above
