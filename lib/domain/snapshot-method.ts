// P/L definition versions of stored snapshots.
//
//   1 — realized P/L excluded dividend/interest on unit-based holdings
//       (every snapshot written before the income change, i.e. every row
//       that has no pl_definition_version yet).
//   2 — dividend/interest (net of withheld tax) is realized P/L everywhere.
//   3 — the central investment result (lib/domain/central-snapshot): realised
//       = trade result + dividends/interest − separate costs − taxes; platform
//       rewards are contributions, not profit; values from the central
//       valuation (dealer basis for metals, broker cash per the cash policy).
//
// Figures computed under different versions are NOT comparable: a chart must
// never draw one continuous line across a version change, and a P/L bridge
// between them must be labelled approximate.

export const CURRENT_PL_DEFINITION_VERSION = 3
export const LEGACY_PL_DEFINITION_VERSION = 1

export const PL_DEFINITION_LABELS: Record<number, string> = {
  1: 'v1 — dividend/interest on holdings not counted as realized P/L',
  2: 'v2 — dividend/interest (net of tax) counted as realized P/L',
  3: 'v3 — central investment result (platform rewards are contributions)',
}

/** A stored row without an explicit version predates versioning → v1. */
export function plDefinitionVersionOf(row: { pl_definition_version?: number | null }): number {
  return row.pl_definition_version ?? LEGACY_PL_DEFINITION_VERSION
}

/**
 * Dates (ascending input) where the P/L definition changes: the first date of
 * each new version. Empty when all rows share one version.
 */
export function findPlDefinitionBreaks(rows: { date: string; version: number }[]): { date: string; from: number; to: number }[] {
  const breaks: { date: string; from: number; to: number }[] = []
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].version !== rows[i - 1].version) {
      breaks.push({ date: rows[i].date, from: rows[i - 1].version, to: rows[i].version })
    }
  }
  return breaks
}

/**
 * Splits one P/L value into the series key for its definition, so different
 * versions end up in different chart series and are never connected.
 * Only the CURRENT version uses the plain key.
 */
export function plSeriesKey(baseKey: string, version: number): string {
  return version === CURRENT_PL_DEFINITION_VERSION ? baseKey : `${baseKey}__v${version}`
}
