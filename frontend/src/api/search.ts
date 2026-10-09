import type { FileIdentity } from '../types/file'
import type { SearchConditions, SearchItem, SearchPageData } from '../types/search'

export class SearchApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'SearchApiError'
    this.status = status
  }
}

function apiBase(): string {
  const configured: unknown = import.meta.env?.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured : 'http://127.0.0.1:8000'
  return raw.trim().replace(/\/+$/, '')
}

export async function searchFiles(conditions: SearchConditions, signal?: AbortSignal): Promise<SearchPageData> {
  const url = new URL(`${apiBase()}/api/search`)
  url.searchParams.set('q', conditions.q)
  url.searchParams.set('type', conditions.type)
  url.searchParams.set('page', String(conditions.page))
  const response = await fetch(url, { signal })
  if (!response.ok) throw new SearchApiError(response.status, `搜索失败（HTTP ${response.status}）`)
  return await response.json() as SearchPageData
}

/** Read the clicked target from its ordinary endpoint before leaving Search.
 * A stale card returns 404 here so Search can remove it and refresh its page.
 * The destination module still reads its own live detail as usual.
 */
export async function getSearchTarget(file: FileIdentity, signal?: AbortSignal): Promise<SearchItem> {
  const routes = { journal: 'journals', inbox: 'inboxes', insight: 'insights' }
  const response = await fetch(`${apiBase()}/api/${routes[file.type]}/${file.id}`, { signal })
  if (!response.ok) throw new SearchApiError(response.status, `打开记录失败（HTTP ${response.status}）`)
  return await response.json() as SearchItem
}
