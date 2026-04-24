export function money(n: number | null | undefined, currency = 'EUR'): string {
    if (n === null || n === undefined || Number.isNaN(n)) return '—'
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n)
  }
  
  export function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('en-IE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  }