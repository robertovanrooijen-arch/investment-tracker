// Generates a subset of date strings for Recharts XAxis `ticks` prop.
// Snaps calendar boundaries (1st of month / quarter / half-year / year) to
// the nearest actual data point. Points too far from a boundary are dropped.
//
// Usage:
//   const ticks  = getChartTicks(displayDates)
//   const fmtTick = getTickFormatter(displayDates)
//   <XAxis ticks={ticks} tickFormatter={fmtTick} interval={0} />

const DAY_MS = 86_400_000

function isoToMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime()
}

type IntervalKind = 'year' | 'half-year' | 'quarter' | 'month' | 'bimonth'

function intervalDays(kind: IntervalKind): number {
  const map: Record<IntervalKind, number> = {
    year: 365, 'half-year': 182, quarter: 91, month: 30, bimonth: 14,
  }
  return map[kind]
}

function nextBoundary(y: number, m: number, kind: IntervalKind): [number, number] {
  switch (kind) {
    case 'year':      return [y + 1, 0]
    case 'half-year': return m < 6 ? [y, 6] : [y + 1, 0]
    case 'quarter': {
      const nq = [0, 3, 6, 9].find((q) => q > m)
      return nq !== undefined ? [y, nq] : [y + 1, 0]
    }
    case 'month':   return m < 11 ? [y, m + 1] : [y + 1, 0]
    case 'bimonth': {
      const nb = [0, 2, 4, 6, 8, 10].find((b) => b > m)
      return nb !== undefined ? [y, nb] : [y + 1, 0]
    }
  }
}

function generateBoundaryDates(startMs: number, endMs: number, kind: IntervalKind): string[] {
  const start = new Date(startMs)
  let [y, m]: [number, number] = [start.getUTCFullYear(), start.getUTCMonth()]
  ;[y, m] = nextBoundary(y, m, kind)

  const result: string[] = []
  while (true) {
    const ms = Date.UTC(y, m, 1)
    if (ms > endMs) break
    result.push(new Date(ms).toISOString().slice(0, 10))
    ;[y, m] = nextBoundary(y, m, kind)
  }
  return result
}

export function getChartTicks(dates: string[]): string[] {
  if (dates.length <= 4) return dates

  const msArr   = dates.map(isoToMs)
  const startMs = msArr[0]
  const endMs   = msArr[msArr.length - 1]
  const spanDays = (endMs - startMs) / DAY_MS

  let kind: IntervalKind
  if      (spanDays > 547) kind = 'half-year'
  else if (spanDays > 180) kind = 'quarter'
  else if (spanDays > 60)  kind = 'month'
  else if (spanDays > 14)  kind = 'bimonth'
  else return dates

  const ideal     = generateBoundaryDates(startMs, endMs, kind)
  const threshold = intervalDays(kind) * DAY_MS * 0.75

  const result: string[] = []
  const seen = new Set<string>()

  for (const isoIdeal of ideal) {
    const tMs = isoToMs(isoIdeal)
    let nearestIdx  = 0
    let nearestDist = Math.abs(msArr[0] - tMs)
    for (let i = 1; i < msArr.length; i++) {
      const dist = Math.abs(msArr[i] - tMs)
      if (dist < nearestDist) { nearestDist = dist; nearestIdx = i }
    }
    const nearest = dates[nearestIdx]
    if (nearestDist <= threshold && !seen.has(nearest)) {
      seen.add(nearest)
      result.push(nearest)
    }
  }

  return result
}

export function getTickFormatter(dates: string[]): (date: string) => string {
  const spanDays =
    dates.length >= 2
      ? (isoToMs(dates[dates.length - 1]) - isoToMs(dates[0])) / DAY_MS
      : 0

  if (spanDays > 180) {
    return (d) =>
      new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
        month: 'short', year: 'numeric',
      })
  }
  return (d) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
    })
}
