export const SUPABASE_PAGE_SIZE = 1000

type PageResult<T> = {
  data: T[] | null
  error: unknown | null
}

/**
 * Fetches every row from a Supabase/PostgREST query without silently stopping
 * at the server's per-request row limit.
 *
 * Callers must apply a deterministic, unique ordering before `.range()` so
 * rows cannot move between pages or be returned twice.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = SUPABASE_PAGE_SIZE
): Promise<PageResult<T>> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('pageSize must be a positive integer')
  }

  const rows: T[] = []

  for (let from = 0; ; from += pageSize) {
    const result = await fetchPage(from, from + pageSize - 1)

    if (result.error) {
      return { data: null, error: result.error }
    }

    const page = result.data ?? []
    rows.push(...page)

    if (page.length < pageSize) {
      return { data: rows, error: null }
    }
  }
}
