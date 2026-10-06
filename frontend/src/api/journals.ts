/**
 * Journal API 调用。
 *
 * Stage 1 / Task 8.1：列表读取
 *
 * - `GET /api/journals`
 * - `GET /api/journals?journal_date=YYYY-MM-DD`
 *
 * Stage 1 / Task 8.2：创建
 *
 * - `POST /api/journals`
 *
 * 使用浏览器原生 `fetch`，不引入 Axios、React Query 等依赖，也不建通用 HTTP 客户端。
 *
 * ## 后端地址
 *
 * `VITE_API_BASE_URL` 表示后端根地址，**不含** `/api`
 * （例如 `http://127.0.0.1:8000`）。
 *
 * 注意：`VITE_*` 会被编译进浏览器产物，只能放非敏感配置，
 * 绝不放入数据库凭据或其它秘密。
 */

import type { Journal, JournalCreate } from '../types/journal'

/** 未配置 `VITE_API_BASE_URL` 时使用的本地默认地址（见 frontend/.env.example）。 */
const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000'

/**
 * 读取后端根地址：优先 `VITE_API_BASE_URL`，否则用本地默认值。
 *
 * 先落到 `unknown` 再判断类型，避免让 `any` 逃过类型检查；
 * 同时规范掉结尾的斜杠，避免拼出 `//api` 或重复 `/api`。
 */
function getApiBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : DEFAULT_API_BASE_URL
  return raw.trim().replace(/\/+$/, '')
}

/**
 * 获取 Journal 列表。
 *
 * @param journalDate 可选；传 `YYYY-MM-DD` 时按该日期精确筛选，
 *   省略（或传空字符串）时不带任何筛选参数，返回全部记录。
 * @param signal 可选的 `AbortSignal`，用于在筛选快速切换时取消过期请求。
 *
 * 说明：
 *
 * - 筛选在后端执行，前端不拿全量再过滤；
 * - 日期为空时**不发送** `journal_date` 参数（而不是发送空值）；
 * - 只有 `response.ok` 才解析，非 2xx 与网络错误都抛异常，
 *   不会被伪装成「空列表」。
 */
export async function listJournals(
  journalDate?: string,
  signal?: AbortSignal,
): Promise<Journal[]> {
  const url = new URL(`${getApiBaseUrl()}/api/journals`)

  if (journalDate) {
    url.searchParams.set('journal_date', journalDate)
  }

  const response = await fetch(url.toString(), { signal })

  if (!response.ok) {
    throw new Error(`获取 Journal 列表失败（HTTP ${response.status}）`)
  }

  return (await response.json()) as Journal[]
}

/**
 * 从失败响应里取一条尽量简洁可读的消息。
 *
 * FastAPI 的校验失败（422）会把说明放在 `detail` 里；
 * 这里只做「字符串直接用，数组取第一条的 msg」这点最小解析，
 * 不引入通用错误处理框架，也保持原有 8.1 列表请求的行为不变。
 */
async function readErrorMessage(response: Response): Promise<string> {
  const fallback = `请求失败（HTTP ${response.status}）`
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('detail' in body)) {
      return fallback
    }
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') {
      return detail
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0]
      if (typeof first === 'object' && first !== null && 'msg' in first) {
        const message = (first as { msg: unknown }).msg
        if (typeof message === 'string') {
          return `请求内容不合法：${message}`
        }
      }
    }
  } catch {
    // 响应体不是 JSON 时保持兜底消息，不额外处理。
  }
  return fallback
}

/**
 * 创建一篇 Journal。
 *
 * @param payload 只包含 `title` / `content` / `journal_date`，
 *   `id` / `created_at` / `updated_at` 由后端生成，前端不发送。
 * @returns 后端返回的完整 Journal（六字段，201 成功时）。
 *
 * 说明：
 *
 * - 只有 `201` 会被当作成功：其它状态码与网络错误都抛异常，
 *   调用方据此区分「保存失败」，不会误认为已保存；
 * - 不做自动重试，是否重试由用户决定（失败时保留输入）。
 */
export async function createJournal(payload: JournalCreate): Promise<Journal> {
  const response = await fetch(`${getApiBaseUrl()}/api/journals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  return (await response.json()) as Journal
}
