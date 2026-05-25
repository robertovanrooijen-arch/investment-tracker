-- =============================================================================
-- Bitvavo 2025 BTC Buy Import  (test account only)
-- user_id    : 177c72a8-ca9b-469a-b48b-f00db89ee632
-- investment : Bitcoin BTC-EUR (108fb5ea-3a13-4a55-a6cb-701b86c40f08)
-- Source     : Bitvavo "Full history" CSV export
-- Scope      : 2025 BTC buy transactions only
--              20 CSV rows → 18 transactions (2 pairs merged at identical timestamps)
--
-- Merge rules applied:
--   • 2025-09-26 12:15:58.354 — 2 rows, same price 93550; merged into 1 row
--   • 2025-10-17 16:06:24.858 — 2 rows, prices 90660/90669; weighted-avg → 90663.43
--
-- Cost basis formula (matches app):
--   cost = quantity × price_per_unit + fee
--   amount = NULL (not used for unit-based cost calculations)
--
-- Safe to rerun: NOT EXISTS guard matches on Bitvavo transaction ID in notes.
--
-- NOT touched: investments, portfolio_snapshots, investment_snapshots,
--              recurring_rules, current_price, current_value.
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 0. PRE-RUN CHECKS  (run first; verify expected values before proceeding)
-- ─────────────────────────────────────────────────────────────────────────────

-- Should return 0 — confirms no prior Bitvavo import exists
SELECT 'bitvavo_imports_already_present' AS check, COUNT(*) AS count
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND notes LIKE '%Bitvavo import%';

-- Should return 2 rows (2026-05-18 recurring rule entries) — confirms baseline
SELECT 'existing_bitcoin_transactions' AS check, COUNT(*) AS count, MIN(date) AS earliest, MAX(date) AS latest
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632';

-- Note these values — import must not change them
SELECT id, current_price, current_value, updated_at
FROM investments
WHERE id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. IMPORT
-- ─────────────────────────────────────────────────────────────────────────────

WITH rows_to_insert (qty, price, fee_eur, dt, notes, anchor_tx_id) AS (
  VALUES

    -- 1. 2025-05-30
    (
      0.00021306::numeric,
      93635::numeric,
      0.0501269::numeric,
      '2025-05-30'::date,
      'Bitvavo import | tx: 321b3781-e0d0-4587-9241-f45cdc77e9d6 | ts: 2025-05-30T07:12:42.471Z',
      '321b3781-e0d0-4587-9241-f45cdc77e9d6'
    ),

    -- 2. 2025-06-13
    (
      0.00021833::numeric,
      91373::numeric,
      0.05053291::numeric,
      '2025-06-13'::date,
      'Bitvavo import | tx: 6c9ee801-211b-470d-807f-319c17bcd292 | ts: 2025-06-13T17:13:07.907Z',
      '6c9ee801-211b-470d-807f-319c17bcd292'
    ),

    -- 3. 2025-06-27
    (
      0.00021858::numeric,
      91267::numeric,
      0.05085914::numeric,
      '2025-06-27'::date,
      'Bitvavo import | tx: bd988e1f-7e25-4976-9033-8c31b74b1085 | ts: 2025-06-27T21:32:06.385Z',
      'bd988e1f-7e25-4976-9033-8c31b74b1085'
    ),

    -- 4. 2025-07-11
    (
      0.00019850::numeric,
      100500::numeric,
      0.05075::numeric,
      '2025-07-11'::date,
      'Bitvavo import | tx: c1c35f43-7913-4dbc-8988-83aaf7bf77ce | ts: 2025-07-11T14:28:03.744Z',
      'c1c35f43-7913-4dbc-8988-83aaf7bf77ce'
    ),

    -- 5. 2025-07-25
    (
      0.00020146::numeric,
      99025::numeric,
      0.0504235::numeric,
      '2025-07-25'::date,
      'Bitvavo import | tx: 94ffd364-3099-4134-9134-7c5af3eacef0 | ts: 2025-07-25T20:06:28.628Z',
      '94ffd364-3099-4134-9134-7c5af3eacef0'
    ),

    -- 6. 2025-08-08
    (
      0.00029842::numeric,
      100260::numeric,
      0.0804108::numeric,
      '2025-08-08'::date,
      'Bitvavo import | tx: 20c8e77a-d55e-4317-afe3-76fffb0c941b | ts: 2025-08-08T09:51:16.606Z',
      '20c8e77a-d55e-4317-afe3-76fffb0c941b'
    ),

    -- 7. 2025-08-22
    (
      0.00030902::numeric,
      96822::numeric,
      0.08006556::numeric,
      '2025-08-22'::date,
      'Bitvavo import | tx: 3126f401-a2ce-48e5-b7bb-624c6da1a17f | ts: 2025-08-22T13:22:26.653Z',
      '3126f401-a2ce-48e5-b7bb-624c6da1a17f'
    ),

    -- 8. 2025-09-05
    (
      0.00031508::numeric,
      94958::numeric,
      0.08063336::numeric,
      '2025-09-05'::date,
      'Bitvavo import | tx: 51f761db-b44e-4349-a041-9ffa8a74dca0 | ts: 2025-09-05T16:20:22.990Z',
      '51f761db-b44e-4349-a041-9ffa8a74dca0'
    ),

    -- 9. 2025-09-19
    (
      0.00030127::numeric,
      99312::numeric,
      0.08027376::numeric,
      '2025-09-19'::date,
      'Bitvavo import | tx: e7e6e622-e5ca-437c-baf9-7f08ad99be5f | ts: 2025-09-19T11:28:37.118Z',
      'e7e6e622-e5ca-437c-baf9-7f08ad99be5f'
    ),

    -- 10. 2025-09-26  MERGED (2 CSV rows: same timestamp, same price 93550)
    --     qty   = 0.00073609 + 0.00214270 = 0.00287879
    --     paid  = 69.04 + 200.95 = 269.99 EUR (incl fee)
    --     fee   = 0.17878050 + 0.50041500 = 0.67919550 EUR
    (
      0.00287879::numeric,
      93550::numeric,
      0.6791955::numeric,
      '2025-09-26'::date,
      'Bitvavo import (merged 2) | tx: c2f32583-f5e1-4843-a542-5dfbde956aa4, e52367c1-4570-4f8b-a1e8-d6edb661856c | ts: 2025-09-26T12:15:58.354Z',
      'c2f32583-f5e1-4843-a542-5dfbde956aa4'
    ),

    -- 11. 2025-10-03
    (
      0.00029182::numeric,
      102526::numeric,
      0.08086268::numeric,
      '2025-10-03'::date,
      'Bitvavo import | tx: dd5854e7-b355-40e1-8f7e-aff1d23e6bbd | ts: 2025-10-03T11:50:58.987Z',
      'dd5854e7-b355-40e1-8f7e-aff1d23e6bbd'
    ),

    -- 12. 2025-10-17  MERGED (2 CSV rows: same timestamp, prices 90660/90669)
    --     qty   = 0.00020000 + 0.00012992 = 0.00032992
    --     price = weighted avg = (0.0002×90660 + 0.00012992×90669) / 0.00032992 = 90663.43
    --     paid  = 18.18 + 11.81 = 29.99 EUR (incl fee)
    --     fee   = 0.04800000 + 0.03028352 = 0.07828352 EUR
    (
      0.00032992::numeric,
      90663.43::numeric,
      0.07828352::numeric,
      '2025-10-17'::date,
      'Bitvavo import (merged 2) | tx: ff09a206-bc2f-4781-b111-6cbb2c605fa5, 8cb6a220-4612-4b07-80e5-03c797eb798b | ts: 2025-10-17T16:06:24.858Z',
      'ff09a206-bc2f-4781-b111-6cbb2c605fa5'
    ),

    -- 13. 2025-10-31
    (
      0.00048004::numeric,
      93491::numeric,
      0.12058036::numeric,
      '2025-10-31'::date,
      'Bitvavo import | tx: f9c385dc-eaf7-41fd-9018-7a8e35f3308a | ts: 2025-10-31T00:39:51.790Z',
      'f9c385dc-eaf7-41fd-9018-7a8e35f3308a'
    ),

    -- 14. 2025-11-14
    (
      0.00053742::numeric,
      83510::numeric,
      0.1200558::numeric,
      '2025-11-14'::date,
      'Bitvavo import | tx: 5dbc2476-4f7d-4b98-bfac-1dfaf7736d5d | ts: 2025-11-14T16:52:37.808Z',
      '5dbc2476-4f7d-4b98-bfac-1dfaf7736d5d'
    ),

    -- 15. 2025-11-25
    (
      0.00145607::numeric,
      75415::numeric,
      0.28048095::numeric,
      '2025-11-25'::date,
      'Bitvavo import | tx: edb265e5-c5ba-46ad-8c3a-0c91857afe23 | ts: 2025-11-25T22:50:42.531Z',
      'edb265e5-c5ba-46ad-8c3a-0c91857afe23'
    ),

    -- 16. 2025-11-28
    (
      0.00057190::numeric,
      78474::numeric,
      0.1207194::numeric,
      '2025-11-28'::date,
      'Bitvavo import | tx: d166b530-62b3-46b7-bf34-5bf34fbbfa55 | ts: 2025-11-28T03:02:43.602Z',
      'd166b530-62b3-46b7-bf34-5bf34fbbfa55'
    ),

    -- 17. 2025-12-12
    (
      0.00056897::numeric,
      78879::numeric,
      0.12021537::numeric,
      '2025-12-12'::date,
      'Bitvavo import | tx: 2b2115cf-eef0-4ee4-9084-950606965135 | ts: 2025-12-12T11:16:59.101Z',
      '2b2115cf-eef0-4ee4-9084-950606965135'
    ),

    -- 18. 2025-12-26
    (
      0.00059423::numeric,
      75526::numeric,
      0.12018502::numeric,
      '2025-12-26'::date,
      'Bitvavo import | tx: 4181085d-6a09-4c3d-adfe-dd37cf7c8df6 | ts: 2025-12-26T03:27:21.145Z',
      '4181085d-6a09-4c3d-adfe-dd37cf7c8df6'
    )
)
INSERT INTO transactions (
  id,
  user_id,
  investment_id,
  type,
  quantity,
  price_per_unit,
  amount,         -- NULL: cost basis uses quantity × price_per_unit for crypto
  fee,
  fee_currency,
  currency,
  price_currency,
  date,
  notes
)
SELECT
  gen_random_uuid(),
  '177c72a8-ca9b-469a-b48b-f00db89ee632',
  '108fb5ea-3a13-4a55-a6cb-701b86c40f08',
  'buy',
  r.qty,
  r.price,
  NULL,
  r.fee_eur,
  'EUR',
  'EUR',
  'EUR',
  r.dt,
  r.notes
FROM rows_to_insert r
WHERE NOT EXISTS (
  SELECT 1
  FROM   transactions t
  WHERE  t.investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
    AND  t.user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
    AND  t.notes         LIKE '%' || r.anchor_tx_id || '%'
);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. VERIFICATION
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Row count — expected: 18
SELECT 'imported_bitvavo_rows' AS check, COUNT(*) AS count
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND notes LIKE '%Bitvavo import%';

-- 2. BTC quantity sum — expected: 0.00998288
SELECT 'sum_btc_quantity' AS check, SUM(quantity) AS total_btc
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND notes LIKE '%Bitvavo import%';

-- 3. EUR cost sum (quantity × price, ex-fee) — expected: ~882.78
SELECT 'sum_eur_cost_ex_fee' AS check, SUM(quantity * price_per_unit) AS total_eur_cost
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND notes LIKE '%Bitvavo import%';

-- 4. EUR fee sum — expected: ~2.295
SELECT 'sum_eur_fees' AS check, SUM(fee) AS total_fees
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
  AND notes LIKE '%Bitvavo import%';

-- 5. Latest 10 Bitcoin transactions (confirms 2025 rows landed + 2026 rows untouched)
SELECT type, date, quantity, price_per_unit, fee, notes
FROM transactions
WHERE investment_id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08'
  AND user_id       = '177c72a8-ca9b-469a-b48b-f00db89ee632'
ORDER BY date DESC, created_at DESC
LIMIT 10;

-- 6. Confirm investments.current_price and current_value unchanged
SELECT id, current_price, current_value, updated_at
FROM investments
WHERE id = '108fb5ea-3a13-4a55-a6cb-701b86c40f08';
-- Must match values from pre-run check above — import must not have changed them
