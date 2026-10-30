/**
 * Years a year-scoped page can offer, derived from the data instead of a
 * hardcoded list: every calendar year that appears in any of the given ISO
 * dates ('YYYY-MM-DD…'), plus the current year (always selectable, even when
 * still empty). Sorted ascending. Malformed dates are ignored.
 */
export function deriveAvailableYears(
  dates: Iterable<string | null | undefined>,
  today: Date = new Date()
): number[] {
  const years = new Set<number>([today.getFullYear()])
  for (const date of dates) {
    if (!date) continue
    const y = Number(date.slice(0, 4))
    if (Number.isInteger(y) && y >= 1900 && y <= 9999) years.add(y)
  }
  return Array.from(years).sort((a, b) => a - b)
}
