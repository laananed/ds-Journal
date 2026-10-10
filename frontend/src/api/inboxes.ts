import type { DailyInboxState, Inbox, InboxCreate, InboxPage, InboxUpdate } from '../types/inbox'

/** Inbox 请求错误。`status === 409` 表示当天已存在 Daily Inbox。 */
export class InboxApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'InboxApiError'
    this.status = status
  }
}

/**
 * 解析后端根地址。
 *
 * 与 `api/journals.ts` 的 `getApiBaseUrl()` 保持同一口径：
 * 读取 `VITE_API_BASE_URL`，未配置时回退 `http://127.0.0.1:8000`，
 * 去掉末尾斜杠。这里刻意各自保留一份小函数，避免跨模块改动已验收的 Journal 文件。
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
export async function listInboxes(
  inboxDate?: string,
  page = 1,
  signal?: AbortSignal,
): Promise<InboxPage> {
  const url = new URL(`${getApiBaseUrl()}/api/inboxes`)
  if (inboxDate) url.searchParams.set('inbox_date', inboxDate)
  url.searchParams.set('page', String(page))
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) {
    throw new InboxApiError(response.status, `获取 Inbox 列表失败（HTTP ${response.status}）`)
  }
  return await response.json() as InboxPage
}

/** 每次打开都真实读取详情，不拿列表缓存冒充当前内容。 */
export async function getInbox(id: number, signal?: AbortSignal): Promise<Inbox> {
  const response = await fetch(`${getApiBaseUrl()}/api/inboxes/${id}`, { signal })
  if (!response.ok) throw new InboxApiError(response.status, await readErrorMessage(response))
  return await response.json() as Inbox
}

/** 只读查询当日 Daily 身份；missing 不是 404，也不创建任何记录。 */
export async function getDailyInbox(inboxDate: string, signal?: AbortSignal): Promise<DailyInboxState> {
  const url = new URL(`${getApiBaseUrl()}/api/inboxes/daily`)
  url.searchParams.set('inbox_date', inboxDate)
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new InboxApiError(response.status, await readErrorMessage(response))
  return await response.json() as DailyInboxState
}

/** 只有提交有效正文才会创建 Inbox；重复 Daily 由后端返回 409。 */
export async function createInbox(payload: InboxCreate): Promise<Inbox> {
  const response = await fetch(`${getApiBaseUrl()}/api/inboxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new InboxApiError(response.status, await readErrorMessage(response))
  return await response.json() as Inbox
}

export async function updateInbox(id: number, payload: InboxUpdate): Promise<Inbox> {
  const response = await fetch(`${getApiBaseUrl()}/api/inboxes/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new InboxApiError(response.status, await readErrorMessage(response))
  return await response.json() as Inbox
}

/** 所有 Inbox 都是硬删除；Stage 3 起必须携带 `If-Match: "<revision>"`。204 没有正文，不能解析 JSON。 */
export async function deleteInbox(id: number, expectedRevision: number): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/inboxes/${id}`, {
    method: 'DELETE',
    headers: { 'If-Match': `"${expectedRevision}"` },
  })
  if (!response.ok) throw new InboxApiError(response.status, await readErrorMessage(response))
}
