import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js'
import type { Investment, Transaction } from '@/types/database'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'

// Paginated reads of the two tables that grow without bound. PostgREST
// returns at most 1000 rows per request; every list read of investments or
// transactions goes through these helpers so no page or job ever silently
// works on a truncated set. Ordering is deterministic (a unique key last) so
// rows can never move between pages.

// The page callbacks only ever yield PostgREST errors.
type Rows<T> = Promise<{ data: T[] | null; error: PostgrestError | null }>

type InvestmentFilters = { userId?: string; ids?: string[]; order?: 'id' | 'name' }

export function fetchAllInvestments<T = Investment>(
  supabase: SupabaseClient,
  columns = '*',
  filters: InvestmentFilters = {}
): Rows<T> {
  return fetchAllRows<T>((from, to) => {
    let q = supabase.from('investments').select(columns)
    if (filters.userId) q = q.eq('user_id', filters.userId)
    if (filters.ids) q = q.in('id', filters.ids)
    if (filters.order === 'name') q = q.order('name', { ascending: true })
    return q.order('id', { ascending: true }).range(from, to).returns<T[]>()
  }) as Rows<T>
}

type TransactionFilters = {
  userId?: string
  investmentId?: string
  isContribution?: boolean
  // 'id' (default) or newest first: date desc, created_at desc, id desc.
  order?: 'id' | 'date_desc' | 'date_asc'
}

export function fetchAllTransactions<T = Transaction>(
  supabase: SupabaseClient,
  columns = '*',
  filters: TransactionFilters = {}
): Rows<T> {
  return fetchAllRows<T>((from, to) => {
    let q = supabase.from('transactions').select(columns)
    if (filters.userId) q = q.eq('user_id', filters.userId)
    if (filters.investmentId) q = q.eq('investment_id', filters.investmentId)
    if (filters.isContribution !== undefined) q = q.eq('is_contribution', filters.isContribution)
    if (filters.order === 'date_desc') {
      q = q.order('date', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false })
    } else if (filters.order === 'date_asc') {
      q = q.order('date', { ascending: true }).order('created_at', { ascending: true }).order('id', { ascending: true })
    } else {
      q = q.order('id', { ascending: true })
    }
    return q.range(from, to).returns<T[]>()
  }) as Rows<T>
}
