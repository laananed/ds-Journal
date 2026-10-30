import type { SearchConditions } from '../types/search'

export function journalSearchConditions(input: string, page: number): SearchConditions | null {
  const q = input.trim()
  return q ? { q, type: 'journal', page } : null
}
