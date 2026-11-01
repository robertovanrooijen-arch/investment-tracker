/** Small RFC-4180 parser for broker exports (BOM, quoted commas and newlines). */
export function parseCsv(text: string): Record<string, string>[] {
  const input = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''))
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''))
    rows.push(row)
  }
  if (quoted) throw new Error('CSV ends inside a quoted field.')
  if (rows.length === 0) return []

  const seen = new Map<string, number>()
  const headers = rows[0].map((rawHeader, index) => {
    const base = rawHeader.trim() || `__column_${index}`
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return occurrence === 1 ? base : `${base}__${occurrence}`
  })
  return rows.slice(1)
    .filter((values) => values.some((value) => value.trim() !== ''))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}
