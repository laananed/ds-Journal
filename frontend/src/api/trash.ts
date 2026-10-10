import type { TrashFilter, TrashItem, TrashPageData, TrashType } from '../types/trash'

/** Trash 请求错误。`status === 404` 表示目标不存在或已不在回收箱中。 */
export class TrashApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'TrashApiError'
    this.status = status
  }
}

/**
 * 解析后端根地址。
 *
 * 与 `api/journals.ts`、`api/folders.ts` 保持同一口径：
 * 读取 `VITE_API_BASE_URL`，未配置时回退 `http://127.0.0.1:8000`，
 * 去掉末尾斜杠。刻意保留一份小函数，避免为复用而重构已验收文件。
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

/**
 * 回收箱列表：仅 Journal / Insight，后端全局分页（20 条/页，deleted_at DESC）。
 * `filter` 为 'all' 时不发送 type 参数，与后端默认值保持一致。
 */
export async function listTrash(
  filter: TrashFilter,
  page = 1,
  signal?: AbortSignal,
): Promise<TrashPageData> {
  const url = new URL(`${getApiBaseUrl()}/api/trash`)
  if (filter !== 'all') url.searchParams.set('type', filter)
  url.searchParams.set('page', String(page))
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) {
    throw new TrashApiError(response.status, `获取回收箱列表失败（HTTP ${response.status}）`)
  }
  return await response.json() as TrashPageData
}

/** 每次打开真实读取已删除详情，不拿列表缓存冒充当前内容。 */
export async function getTrashItem(
  type: TrashType,
  id: number,
  signal?: AbortSignal,
): Promise<TrashItem> {
  const response = await fetch(`${getApiBaseUrl()}/api/trash/${type}/${id}`, { signal })
  if (!response.ok) {
    throw new TrashApiError(response.status, await readErrorMessage(response))
  }
  return await response.json() as TrashItem
}

/** 恢复：200 返回恢复后的完整有效文件（原 ID / 日期 / Folder 关系保留）。Stage 3 起必须携带 If-Match。 */
export async function restoreTrashItem(type: TrashType, id: number, expectedRevision: number): Promise<TrashItem> {
  const response = await fetch(`${getApiBaseUrl()}/api/trash/${type}/${id}/restore`, {
    method: 'POST',
    headers: { 'If-Match': `"${expectedRevision}"` },
  })
  if (!response.ok) {
    throw new TrashApiError(response.status, await readErrorMessage(response))
  }
  return await response.json() as TrashItem
}

/** 永久删除：204 空体，不能解析 JSON；404 = 记录已不在回收箱。Stage 3 起必须携带 If-Match。 */
export async function purgeTrashItem(type: TrashType, id: number, expectedRevision: number): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}/api/trash/${type}/${id}`, {
    method: 'DELETE',
    headers: { 'If-Match': `"${expectedRevision}"` },
  })
  if (!response.ok) {
    throw new TrashApiError(response.status, await readErrorMessage(response))
  }
}
