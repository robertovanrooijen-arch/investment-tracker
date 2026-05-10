import type { RecurringTransaction, Investment, TransactionType } from '@/types/database'
import type { FxRates } from '@/lib/domain/fx'

// ---------------------------------------------------------------------------
// Date utilities — UTC throughout to avoid timezone drift in cron environments
// ---------------------------------------------------------------------------

function parseDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function addDaysUTC(date: Date, n: number): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + n,
  ))
}

// ---------------------------------------------------------------------------
// Schedule helpers — each returns the first occurrence STRICTLY AFTER `after`
// ---------------------------------------------------------------------------

function nextMonthlyAfter(after: Date, dayOfMonth: number): Date {
  // Try the same calendar month first.
  const sameMonth = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), dayOfMonth))
  if (sameMonth > after) return sameMonth
  // Advance one month. Date.UTC handles month-index overflow (e.g. month 12 → Jan next year).
  return new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth() + 1, dayOfMonth))
}

function nextQuarterlyAfter(after: Date, dayOfMonth: number): Date {
  // Calendar quarter-start months (0-indexed): Jan=0, Apr=3, Jul=6, Oct=9.
  const quarterMonths = new Set([0, 3, 6, 9])
  let year = after.getUTCFullYear()
  let month = after.getUTCMonth()

  // At most 5 iterations: the next quarter month is at most 3 months away,
  // plus one extra pass in case the candidate day already passed this month.
  for (let i = 0; i < 5; i++) {
    if (quarterMonths.has(month)) {
      const candidate = new Date(Date.UTC(year, month, dayOfMonth))
      if (candidate > after) return candidate
    }
    month += 1
    if (month > 11) { month = 0; year += 1 }
  }

  throw new Error(`nextQuarterlyAfter: could not compute date after ${formatDate(after)}`)
}

function nextWeeklyAfter(after: Date, dayOfWeek: number): Date {
  // Our encoding: 0=Monday … 6=Sunday.
  // JS Date.getUTCDay():  0=Sunday, 1=Monday … 6=Saturday.
  // Conversion: jsDay = (dayOfWeek + 1) % 7
  const jsTarget = (dayOfWeek + 1) % 7
  // Check each of the next 7 days — the target weekday is always within that window.
  for (let i = 1; i <= 7; i++) {
    const candidate = addDaysUTC(after, i)
    if (candidate.getUTCDay() === jsTarget) return candidate
  }
  throw new Error('nextWeeklyAfter: target weekday not found')
}

function nextOccurrenceAfter(rule: RecurringTransaction, after: Date): Date {
  if (rule.frequency === 'quarterly') return nextQuarterlyAfter(after, rule.day_of_month!)
  if (rule.frequency === 'monthly')   return nextMonthlyAfter(after, rule.day_of_month!)
  return nextWeeklyAfter(after, rule.day_of_week!)
}

// ---------------------------------------------------------------------------
// Public: next due date
// ---------------------------------------------------------------------------

/**
 * Computes the date this rule should next generate a transaction for.
 *
 * - last_generated_date is null → finds the first schedule occurrence on or
 *   after start_date (achieved by anchoring one day before start_date).
 * - last_generated_date is set  → advances exactly one period from it.
 */
export function computeNextDueDate(rule: RecurringTransaction): Date {
  if (rule.last_generated_date === null) {
    // One day before start_date so nextOccurrenceAfter returns the first
    // occurrence on or after start_date itself.
    const beforeStart = addDaysUTC(parseDate(rule.start_date), -1)
    return nextOccurrenceAfter(rule, beforeStart)
  }
  return nextOccurrenceAfter(rule, parseDate(rule.last_generated_date))
}

// ---------------------------------------------------------------------------
// Public: due check
// ---------------------------------------------------------------------------

/**
 * Returns true when the rule has a pending occurrence on or before `today`.
 * Respects the active flag and end_date.
 */
export function isRuleDue(rule: RecurringTransaction, today: Date): boolean {
  if (!rule.active) return false
  const nextDue = computeNextDueDate(rule)
  if (rule.end_date !== null && nextDue > parseDate(rule.end_date)) return false
  return nextDue <= today
}

// ---------------------------------------------------------------------------
// Fee conversion helper
// ---------------------------------------------------------------------------

/**
 * Convert a fee amount from feeCurrency into priceCurrency (the native
 * currency of the investment) so it can be added to the gross amount.
 *
 * Logic (mirrors txFeeInPriceCurrency in calculations.ts):
 *   1. If currencies match, return as-is.
 *   2. Convert fee → EUR using fxRates[feeCurrency] (eur_per_unit).
 *   3. Convert EUR → priceCurrency by dividing by fxRates[priceCurrency].
 * Falls back to 1 when a rate is missing (best-effort).
 */
function feeInNativeCurrency(
  feeAmount: number,
  feeCurrency: string,
  priceCurrency: string,
  fxRates: FxRates,
): number {
  if (feeAmount === 0) return 0
  if (feeCurrency === priceCurrency) return feeAmount

  // Step 1: fee → EUR
  const feeEur =
    feeCurrency === 'EUR'
      ? feeAmount
      : feeAmount * (fxRates[feeCurrency] ?? 1)

  // Step 2: EUR → priceCurrency
  if (priceCurrency === 'EUR') return feeEur
  const priceToEur = fxRates[priceCurrency] ?? 1
  if (priceToEur === 0) return 0
  return feeEur / priceToEur
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type GeneratedTransactionPayload = {
  investment_id: string
  user_id: string
  type: TransactionType
  /** The due date of the occurrence, NOT the date the cron ran. 'YYYY-MM-DD'. */
  date: string
  quantity: number | null
  price_per_unit: number | null
  amount: number | null
  fee: number
  currency: string
  price_currency: string
  fee_currency: string
  fx_rate_to_eur: number | null
  notes: string | null
  recurring_rule_id: string
}

export type SkipReason =
  | 'inactive'
  | 'past_end_date'
  | 'not_due'
  | 'unsupported_type'
  | 'missing_current_price'
  | 'invalid_fixed_amount'
  | 'currency_mismatch'
  | 'invalid_quantity'

export type GenerationResult =
  | { ok: true; payload: GeneratedTransactionPayload; dueDate: string }
  | { ok: false; reason: SkipReason; detail?: string }

// ---------------------------------------------------------------------------
// Public: build generated transaction
// ---------------------------------------------------------------------------

/**
 * Pure function — no Supabase calls.
 *
 * Decides whether `rule` is due on `today` and returns either a ready-to-insert
 * transaction payload or a structured skip reason.
 *
 * Caller responsibilities after receiving ok: true:
 *   1. Insert payload into the transactions table.
 *   2. Set recurring_transactions.last_generated_date = dueDate.
 * Both steps must succeed atomically; if step 2 is skipped, the same period
 * will be generated again on the next cron run.
 */
export function buildGeneratedTransaction(
  rule: RecurringTransaction,
  investment: Investment,
  fxRates: FxRates,
  today: Date,
): GenerationResult {
  if (!rule.active) return { ok: false, reason: 'inactive' }

  const nextDue = computeNextDueDate(rule)

  if (rule.end_date !== null && nextDue > parseDate(rule.end_date)) {
    return { ok: false, reason: 'past_end_date' }
  }

  if (nextDue > today) {
    return { ok: false, reason: 'not_due' }
  }

  const dueDateStr    = formatDate(nextDue)
  const priceCurrency = investment.currency
  const fxRateToEur   = fxRates[priceCurrency] ?? null

  const base = {
    investment_id:   investment.id,
    user_id:         investment.user_id,
    currency:        priceCurrency,
    price_currency:  priceCurrency,
    fee_currency:    rule.fee_currency,
    fx_rate_to_eur:  fxRateToEur,
    notes:           rule.notes,
    recurring_rule_id: rule.id,
    date:            dueDateStr,
  }

  // ── buy ───────────────────────────────────────────────────────────────────
  if (rule.type === 'buy') {
    if (rule.fixed_amount === null || rule.fixed_amount <= 0) {
      return { ok: false, reason: 'invalid_fixed_amount' }
    }

    // MVP: fixed_amount_currency must match investment.currency.
    // Cross-currency fixed-cash buys (e.g. €100/month into a USD ETF) are
    // deferred to a later phase because they require FX conversion for quantity.
    if (rule.fixed_amount_currency !== investment.currency) {
      return {
        ok: false,
        reason: 'currency_mismatch',
        detail: `rule.fixed_amount_currency (${rule.fixed_amount_currency ?? 'null'}) ≠ investment.currency (${investment.currency})`,
      }
    }

    if (investment.current_price === null || investment.current_price <= 0) {
      return { ok: false, reason: 'missing_current_price' }
    }

    const quantity = rule.fixed_amount / investment.current_price
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, reason: 'invalid_quantity' }
    }

    // amount is in priceCurrency (native). Convert broker fee to native before
    // adding so mixed-currency fees (e.g. EUR fee on a USD investment) are
    // correctly represented. The fee column still stores the original amount
    // in fee_currency — only amount needs the converted value.
    const gross      = quantity * investment.current_price  // ≈ rule.fixed_amount
    const feeNative  = feeInNativeCurrency(rule.fee, rule.fee_currency, priceCurrency, fxRates)
    const amount     = gross + feeNative

    return {
      ok: true,
      dueDate: dueDateStr,
      payload: {
        ...base,
        type:          'buy',
        quantity,
        price_per_unit: investment.current_price,
        amount,
        fee:           rule.fee,
      },
    }
  }

  // ── fee ───────────────────────────────────────────────────────────────────
  if (rule.type === 'fee') {
    if (rule.fixed_amount === null || rule.fixed_amount <= 0) {
      return { ok: false, reason: 'invalid_fixed_amount' }
    }

    return {
      ok: true,
      dueDate: dueDateStr,
      payload: {
        ...base,
        type:          'fee',
        quantity:      null,
        price_per_unit: null,
        amount:        rule.fixed_amount,
        // Broker fee is always 0 inside a standalone fee transaction;
        // the amount itself is the fee. Matches the transaction form behaviour.
        fee:           0,
      },
    }
  }

  // ── unsupported type (future-proofing) ────────────────────────────────────
  return {
    ok: false,
    reason: 'unsupported_type',
    detail: `type '${rule.type}' not yet handled`,
  }
}
