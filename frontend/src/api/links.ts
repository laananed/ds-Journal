import type { FileIdentity } from '../types/file'
import type { LinkPage } from '../types/link'

export class LinkApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
function apiBase(): string {
  const configured = import.meta.env?.VITE_API_BASE_URL
  return (typeof configured === 'string' && configured.trim() ? configured.trim() : 'http://127.0.0.1:8000').replace(/\/+$/, '')
}
export async function resolveLinks(title: string, page = 1, signal?: AbortSignal): Promise<LinkPage> {
  const url = new URL(`${apiBase()}/api/links/resolve`)
  url.searchParams.set('title', title)
  url.searchParams.set('page', String(page))
  const response = await fetch(url, { signal })
  if (!response.ok) throw new LinkApiError(response.status, `链接解析失败（HTTP ${response.status}）`)
  return await response.json() as LinkPage
}
/** Check the ordinary detail, because a candidate may have been deleted meanwhile. */
export async function readLinkTarget(file: FileIdentity, signal?: AbortSignal): Promise<void> {
  const routes = { journal: 'journals', inbox: 'inboxes', insight: 'insights' }
  const response = await fetch(`${apiBase()}/api/${routes[file.type]}/${file.id}`, { signal })
  if (!response.ok) throw new LinkApiError(response.status, `打开目标失败（HTTP ${response.status}）`)
}
