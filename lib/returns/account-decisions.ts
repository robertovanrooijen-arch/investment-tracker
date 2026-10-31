import type { CashPolicy } from '@/lib/domain/current-valuation'

// Owner decision (31-10-2026): free broker cash is NOT presented as an
// investment or as part of the shown portfolio value. It stays inside the
// return ledger (sales and re-investments move through it) and is shown
// apart. Cash within the rounding tolerance is a bookkeeping residue; cash
// above it is never set to zero but flagged as needing a policy decision.
// The general default (lib/domain/current-valuation DEFAULT_CASH_POLICY)
// keeps cash in the shown value.
export const BROKER_CASH_POLICY: CashPolicy = { presentation: 'separate', roundingToleranceEur: 0.1 }
