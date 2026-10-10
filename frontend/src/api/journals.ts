import type { Journal, JournalCreate, JournalUpdate, JournalPage } from '../types/journal'

export class JournalApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'JournalApiError'
    this.status = status
  }
}
function getApiBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured : 'http://127.0.0.1:8000'
  return raw.trim().replace(/\/+$/, '')
}
/** 筛选、排序、编号与固定20条分页全部由后端处理。 */
export async function listJournals(
  journalDate?: string,
  page = 1,
  signal?: AbortSignal,
): Promise<JournalPage> {
  const url = new URL(`${getApiBaseUrl()}/api/journals`)
  if (journalDate) url.searchParams.set('journal_date', journalDate)
  url.searchParams.set('page', String(page))
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) {
    throw new JournalApiError(response.status, `获取 Journal 列表失败（HTTP ${response.status}）`)
  }
  return await response.json() as JournalPage
}
async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `请求失败（HTTP ${response.status}）`
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('detail' in body)) return fallback
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0]
      if (typeof first === 'object' && first !== null && 'msg' in first) {
        const message = (first as { msg: unknown }).msg
        if (typeof message === 'string') return `请求内容不合法：${message}`
      }
    }
  } catch { /* 非JSON响应使用HTTP兜底消息。 */ }
  return fallback
}
export async function createJournal(payload: JournalCreate): Promise<Journal> {
  const response = await fetch(`${getApiBaseUrl()}/api/journals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new JournalApiError(response.status, await readErrorMessage(response))
  return await response.json() as Journal
}
/** 每次打开真实读取详情，不拿列表缓存冒充当前内容。 */
export async function getJournal(id: number, signal?: AbortSignal): Promise<Journal> {
  const response = await fetch(`${getApiBaseUrl()}/api/journals/${id}`, { signal })
  if (!response.ok) throw new JournalApiError(response.status, await readErrorMessage(response))
  return await response.json() as Journal
}
export async function updateJournal(id: number, payload: JournalUpdate): Promise<Journal> {
  const response = await fetch(`${getApiBaseUrl()}/api/journals/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new JournalApiError(response.status, await readErrorMessage(response))
  return await response.json() as Journal
}
/**
 * Journal 普通删除是软删除；Stage 3 起必须携带 `If-Match: "<revision>"`。
 * 缺版本后端返回 428、版本过期返回 409；204 没有正文，不能解析 JSON。
 */
export async function deleteJournal(id: number, expectedRevision: number): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/journals/${id}`, {
    method: 'DELETE',
    headers: { 'If-Match': `"${expectedRevision}"` },
  })
  if (!response.ok) throw new JournalApiError(response.status, await readErrorMessage(response))
}
