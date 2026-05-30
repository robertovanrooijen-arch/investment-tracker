-- Seed capital_flow_entries for a specific user.
-- Replace 'your@email.com' with the actual Supabase user email.
--
-- flow_date is set to the last day of the year as a placeholder.
-- Update individual dates if you want per-transfer granularity.

DO $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = 'your@email.com';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User not found: your@email.com';
  END IF;

  INSERT INTO capital_flow_entries
    (user_id, flow_date, year, platform, direction, amount_eur)
  VALUES
    -- ── 2026 ──────────────────────────────────────────────────────────────
    (v_user_id, '2026-12-31', 2026, 'DEGIRO / Flatex', 'to_portfolio',   3845.00),
    (v_user_id, '2026-12-31', 2026, 'DEGIRO / Flatex', 'from_portfolio', 1173.13),
    (v_user_id, '2026-12-31', 2026, 'Bitvavo',         'to_portfolio',   1135.00),
    (v_user_id, '2026-12-31', 2026, 'Holland Gold',    'to_portfolio',    150.00),
    (v_user_id, '2026-12-31', 2026, 'Holland Gold',    'from_portfolio', 1619.80),
    (v_user_id, '2026-12-31', 2026, 'GoldRepublic',    'to_portfolio',   1375.00),
    (v_user_id, '2026-12-31', 2026, 'Trade Republic',  'to_portfolio',    255.74),
    -- ── 2025 ──────────────────────────────────────────────────────────────
    (v_user_id, '2025-12-31', 2025, 'DEGIRO / Flatex', 'to_portfolio',   4030.00),
    (v_user_id, '2025-12-31', 2025, 'DEGIRO / Flatex', 'from_portfolio', 1850.00),
    (v_user_id, '2025-12-31', 2025, 'Bitvavo',         'to_portfolio',    875.01),
    (v_user_id, '2025-12-31', 2025, 'Holland Gold',    'to_portfolio',   1675.00),
    (v_user_id, '2025-12-31', 2025, 'GoldRepublic',    'to_portfolio',   1200.00),
    (v_user_id, '2025-12-31', 2025, 'GoldRepublic',    'from_portfolio',  753.46);

  RAISE NOTICE 'Inserted capital flow entries for user %', v_user_id;
END $$;

-- ── Expected totals ───────────────────────────────────────────────────────────
-- 2026  gross in: 6760.74   out: 2792.93   net: 3967.81
-- 2025  gross in: 7780.01   out: 2603.46   net: 5176.55
