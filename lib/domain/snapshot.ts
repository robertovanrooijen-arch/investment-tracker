export type SnapshotSource = 'manual_refresh' | 'cron'

export function todayLocalIso(): string {
  const d = new Date()
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export type DailyChange = {
  value: number
  percent: number | null  // null when previous value was 0 (would divide by zero)
} | null                  // null = no previous snapshot to compare against

/**
 * Compares today's live-computed portfolio value against the most recent
 * snapshot dated before today. Returns null when there's nothing to compare
 * against yet (e.g. first day of use).
 */
export function computeDailyChange(
  currentValueEur: number,
  previousSnapshot: { total_value_eur: number } | null
): DailyChange {
  if (!previousSnapshot) return null
  const value = currentValueEur - previousSnapshot.total_value_eur
  const percent =
    previousSnapshot.total_value_eur !== 0
      ? (value / previousSnapshot.total_value_eur) * 100
      : null
  return { value, percent }
}

// Snapshots are written ONLY by lib/domain/central-snapshot (central valuation).
