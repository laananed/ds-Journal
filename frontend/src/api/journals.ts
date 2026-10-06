/**
 * Journal 列表 API 调用（Stage 1 / Task 8.1）。
 *
 * 只实现当前阶段需要的两个读取请求：
 *
 * - `GET /api/journals`
 * - `GET /api/journals?journal_date=YYYY-MM-DD`
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

import type { Journal } from '../types/journal'

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
