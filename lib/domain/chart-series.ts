// Period-based downsampling for chart display.
//
// Problem: mixing annual imported snapshots (2024-12-31, 2025-12-31) with
// 25+ daily May 2026 cron snapshots causes Recharts to allocate equal width
// to each point, making the recent daily period look explosively large.
//
// Solution: before rendering, reduce data to one representative point per
// calendar bucket. Always use the LAST available snapshot in each bucket so
// the displayed value is the most current reading for that period.

export type Preset = '7d' | '30d' | '90d' | '1y' | 'all'

type Granularity = 'day' | 'week' | 'month' | 'quarter'

const DAY_MS = 86_400_000

function isoToEpochDays(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / DAY_MS)
}

function bucketKey(iso: string, g: Granularity): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()

  switch (g) {
    case 'day':     return iso
    case 'week':    return String(Math.floor(isoToEpochDays(iso) / 7))
    case 'month':   return `${y}-${String(m + 1).padStart(2, '0')}`
    case 'quarter': return `${y}-Q${Math.floor(m / 3) + 1}`
  }
}

function chooseGranularity(snaps: { date: string }[], preset: Preset): Granularity {
  if (preset === '7d')  return 'day'
  if (preset === '30d') return 'day'   // ≤ 30 daily points is fine at this zoom
  if (preset === '90d') return 'week'
  if (preset === '1y')  return 'month'

  // 'all': adapt to actual data span
  if (snaps.length < 2) return 'month'
  const spanDays = isoToEpochDays(snaps[snaps.length - 1].date) - isoToEpochDays(snaps[0].date)
  return spanDays > 4 * 365 ? 'quarter' : 'month'
}

// Returns one representative snapshot per calendar bucket (last in bucket).
// Preserves chronological order. Skips empty buckets — never invents data.
export function downsampleForPreset<T extends { date: string }>(snaps: T[], preset: Preset): T[] {
  if (snaps.length === 0) return snaps
  const g       = chooseGranularity(snaps, preset)
  const buckets = new Map<string, T>()
  for (const s of snaps) {
    buckets.set(bucketKey(s.date, g), s)
  }
  return [...buckets.values()]
}

// ISO date string for the cutoff of a non-'all' preset.
export function cutoffDateIso(preset: Exclude<Preset, 'all'>): string {
  const days: Record<Exclude<Preset, 'all'>, number> = {
    '7d': 7, '30d': 30, '90d': 90, '1y': 365,
  }
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - days[preset])
  return d.toISOString().slice(0, 10)
}
