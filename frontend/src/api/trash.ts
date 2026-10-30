import type { TrashFilter, TrashItem, TrashPageData, TrashType } from '../types/trash'

/**
 * Trash 请求错误。`status === 404` 表示目标不存在或已不在回收箱中。
 *
 * Stage 4 / T11：后端错误体统一为 `{detail, code}`（`docs/stage4-api.md` §1），
 * 因此这里额外保留 `code`，让调用方能区分「普通版本冲突」与
 * `ritual_slot_conflict` / `related_files_changed` 这类**语义不同**的 409，
 * 而不是把所有 409 都当成「记录已变化，重读再试」。
 * `code` 缺失时保持 Stage 3 行为（按 `status` 判断），不视为错误。
 */
export class TrashApiError extends Error {
  readonly status: number
  /** 机器可读错误码（`revision_conflict` / `ritual_slot_conflict` 等）；旧响应可能没有。 */
  readonly code?: string
  /** `ritual_slot_conflict` 附带的占位文件身份与版本；无该码时为 undefined。 */
  readonly conflict?: { current_id: number | null; revision: number | null }
  constructor(
    status: number,
    message: string,
    code?: string,
    conflict?: { current_id: number | null; revision: number | null },
  ) {
    super(message)
    this.name = 'TrashApiError'
    this.status = status
    this.code = code
    this.conflict = conflict
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

/** 后端错误体：`{detail, code?, conflict?}`；`detail` 可能是字符串或 422 校验列表。 */
interface TrashErrorBody {
  message: string
  code?: string
  conflict?: { current_id: number | null; revision: number | null }
}

function readConflict(value: unknown): TrashErrorBody['conflict'] {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as { current_id?: unknown; revision?: unknown }
  const id = typeof raw.current_id === 'number' ? raw.current_id : null
  const revision = typeof raw.revision === 'number' ? raw.revision : null
  if (id === null && revision === null) return undefined
  return { current_id: id, revision }
}

/**
 * 解析错误体：消息用于展示，`code` / `conflict` 用于分支判断。
 * 不回显请求体内容；非 JSON 响应退化为 HTTP 状态兜底消息。
 */
async function readErrorBody(response: Response): Promise<TrashErrorBody> {
  const fallback = `请求失败（HTTP ${response.status}）`
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return { message: fallback }
    const record = body as { detail?: unknown; code?: unknown; conflict?: unknown }
    const code = typeof record.code === 'string' && record.code !== '' ? record.code : undefined
    const conflict = readConflict(record.conflict)
    const detail = record.detail
    if (typeof detail === 'string') return { message: detail, code, conflict }
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0]
      if (typeof first === 'object' && first !== null && 'msg' in first) {
        const message = (first as { msg: unknown }).msg
        if (typeof message === 'string') return { message: `请求内容不合法：${message}`, code, conflict }
      }
    }
    return { message: fallback, code, conflict }
  } catch { /* 非 JSON 响应使用 HTTP 兜底消息。 */ }
  return { message: fallback }
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
    const body = await readErrorBody(response)
    throw new TrashApiError(response.status, body.message, body.code, body.conflict)
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
    const body = await readErrorBody(response)
    throw new TrashApiError(response.status, body.message, body.code, body.conflict)
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
    const body = await readErrorBody(response)
    throw new TrashApiError(response.status, body.message, body.code, body.conflict)
  }
}
