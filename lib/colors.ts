import type { InvestmentType } from '@/types/database'

export const CATEGORY_COLORS: Record<InvestmentType, string> = {
  stock: 'bg-sky-500',
  ETF: 'bg-indigo-500',
  crypto: 'bg-amber-500',
  cash: 'bg-emerald-500',
  'real estate': 'bg-rose-500',
  custom: 'bg-slate-500',
  commodity: 'bg-yellow-500',
}

export const PLATFORM_COLORS: Record<string, string> = {
  DEGIRO:           'bg-blue-600',
  'Trade Republic': 'bg-slate-800',
  'Gold Republic':  'bg-yellow-600',
  Bitvavo:          'bg-indigo-500',
  Binance:          'bg-yellow-500',
  ING:              'bg-orange-500',
  'Real Estate':    'bg-rose-500',
  Custom:           'bg-slate-500',
}

export function categoryColor(type: InvestmentType | string): string {
  return (CATEGORY_COLORS as Record<string, string>)[type] ?? 'bg-slate-400'
}

export function platformColor(platform: string): string {
  return PLATFORM_COLORS[platform] ?? 'bg-slate-400'
}

// ---------------------------------------------------------------------------
// Hex variants — used by Recharts (SVG fill/stroke need real color values,
// Tailwind classes don't work there). Kept in step with CATEGORY_COLORS /
// PLATFORM_COLORS above so the dashboard donut and the allocation detail
// page always agree on category colors.
// ---------------------------------------------------------------------------

export const CATEGORY_HEX: Record<InvestmentType, string> = {
  stock: '#0ea5e9', // sky-500
  ETF: '#6366f1', // indigo-500
  crypto: '#f59e0b', // amber-500
  cash: '#10b981', // emerald-500
  'real estate': '#ef4444', // rose-500
  custom: '#6b7280', // slate-500
  commodity: '#eab308', // yellow-500
}

export const PLATFORM_HEX: Record<string, string> = {
  DEGIRO: '#2563eb', // blue-600
  'Trade Republic': '#1e293b', // slate-800
  'Gold Republic': '#d97706', // amber-600
  Bitvavo: '#6366f1', // indigo-500
  Binance: '#eab308', // yellow-500
  ING: '#f97316', // orange-500
  'Real Estate': '#ef4444', // rose-500
  Custom: '#6b7280', // slate-500
}

export const FALLBACK_HEX = '#9ca3af'

export function categoryColorHex(type: InvestmentType | string): string {
  return (CATEGORY_HEX as Record<string, string>)[type] ?? FALLBACK_HEX
}

export function platformColorHex(platform: string): string {
  return PLATFORM_HEX[platform] ?? FALLBACK_HEX
}

// Per-category tint families used to color individual holdings within a
// category donut, so e.g. every ETF gets its own shade of the same base
// indigo used for "ETF" everywhere else. First entry in each family always
// equals the category's base hex above, so a single-holding category still
// reads as "the" category color.
const CATEGORY_SHADES: Record<InvestmentType, string[]> = {
  ETF: ['#6366f1', '#818cf8', '#4f46e5', '#a5b4fc', '#4338ca', '#c7d2fe'],
  crypto: ['#f59e0b', '#fb923c', '#ea580c', '#fbbf24', '#c2410c', '#fcd34d'],
  stock: ['#0ea5e9', '#38bdf8', '#0284c7', '#7dd3fc', '#0369a1', '#bae6fd'],
  commodity: ['#eab308', '#94a3b8', '#ca8a04', '#64748b', '#facc15', '#cbd5e1'],
  cash: ['#10b981', '#34d399', '#059669'],
  'real estate': ['#ef4444', '#f87171', '#dc2626'],
  custom: ['#6b7280', '#9ca3af', '#4b5563'],
}

export function categoryShade(type: InvestmentType, index: number): string {
  const shades = CATEGORY_SHADES[type]
  if (!shades || shades.length === 0) return categoryColorHex(type)
  return shades[index % shades.length]
}

// Gold/silver get recognizable, logical colors (golden yellow / silvery
// grey) rather than an arbitrary cycle through the commodity family.
export function commodityKindShade(kind: 'gold' | 'silver' | null, index: number): string {
  if (kind === 'gold') return '#eab308' // yellow-500
  if (kind === 'silver') return '#94a3b8' // slate-400
  return categoryShade('commodity', index)
}