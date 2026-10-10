import type { Insight, InsightCreate, InsightPage, InsightUpdate } from '../types/insight'

/** Insight 请求错误。 */
export class InsightApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'InsightApiError'
    this.status = status
  }
}

/**
 * 解析后端根地址。
 *
 * 与 `api/journals.ts` / `api/inboxes.ts` 保持同一口径：
 * 读取 `VITE_API_BASE_URL`，未配置时回退 `http://127.0.0.1:8000`，
 * 去掉末尾斜杠。这里刻意各自保留一份小函数，避免跨模块改动已验收文件。
 */
function getApiBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured : 'http://127.0.0.1:8000'
  return raw.trim().replace(/\/+$/, '')
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
  } catch { /* 非 JSON 响应使用 HTTP 兜底消息。 */ }
  return fallback
}

/** 筛选、排序与固定 20 条分页全部由后端处理。 */
export async function listInsights(
  folderId?: number,
  page = 1,
  signal?: AbortSignal,
): Promise<InsightPage> {
  const url = new URL(`${getApiBaseUrl()}/api/insights`)
  if (folderId !== undefined) url.searchParams.set('folder_id', String(folderId))
  url.searchParams.set('page', String(page))
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) {
    throw new InsightApiError(response.status, `获取 Insight 列表失败（HTTP ${response.status}）`)
  }
  return await response.json() as InsightPage
}

/** 每次打开都真实读取详情，不拿列表缓存冒充当前内容。 */
export async function getInsight(id: number, signal?: AbortSignal): Promise<Insight> {
  const response = await fetch(`${getApiBaseUrl()}/api/insights/${id}`, { signal })
  if (!response.ok) throw new InsightApiError(response.status, await readErrorMessage(response))
  return await response.json() as Insight
}

export async function createInsight(payload: InsightCreate): Promise<Insight> {
  const response = await fetch(`${getApiBaseUrl()}/api/insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new InsightApiError(response.status, await readErrorMessage(response))
  return await response.json() as Insight
}

export async function updateInsight(id: number, payload: InsightUpdate): Promise<Insight> {
  const response = await fetch(`${getApiBaseUrl()}/api/insights/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new InsightApiError(response.status, await readErrorMessage(response))
  return await response.json() as Insight
}

/** 软删除（移入回收箱）；Stage 3 起必须携带 `If-Match: "<revision>"`。204 没有正文，不能解析 JSON。 */
export async function deleteInsight(id: number, expectedRevision: number): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/insights/${id}`, {
    method: 'DELETE',
    headers: { 'If-Match': `"${expectedRevision}"` },
  })
  if (!response.ok) throw new InsightApiError(response.status, await readErrorMessage(response))
}
