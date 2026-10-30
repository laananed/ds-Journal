/**
 * 独立日程（C01）的 HTTP 客户端 —— 按 `docs/stage4-api.md` §13 草案实现。
 *
 * 重要前提：**C01 后端尚未交付**。本文件是前端侧契约实现，
 * 没有连过真实后端、没有经过任何真实 HTTP 往返验证；
 * 在 C01 后端交接并通过联调前，不得把它描述成「已打通」。
 *
 * 设计要点：
 * - 只对外暴露一个工厂 `createHttpSchedulesClient()`，返回 `SchedulesClient`；
 *   页面只依赖接口，便于现在用 Mock、后端就绪后原样替换。
 * - `client_create_id` 由调用方（表单）持有并在重试时复用，客户端**不自己换键**。
 * - PATCH/DELETE 显式带版本：缺版本 428、过期 409 由后端判定，前端不猜。
 * - 错误统一成 `ScheduleApiError`（带 `status`/`code`），沿用项目现有 `detail` 解析方式。
 */

import type {
  Schedule,
  ScheduleCreateInput,
  ScheduleId,
  ScheduleListPage,
  ScheduleUpdateInput,
  SchedulesClient,
} from '../types/schedule.ts'

/** 带 HTTP 状态码的日程错误；`code` 对应 §1 的错误码（如 `revision_conflict`）。 */
export class ScheduleApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'ScheduleApiError'
    this.status = status
    this.code = code
  }
}

function apiBase(baseUrl?: string): string {
  if (baseUrl !== undefined && baseUrl.trim() !== '') return baseUrl.trim().replace(/\/+$/, '')
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim()
    : 'http://127.0.0.1:8000'
  return raw.replace(/\/+$/, '')
}

function scheduleUrl(base: string, id: ScheduleId): string {
  // ID 可能是整数或 UUID：统一编码，避免 UUID 里的字符影响路径。
  return `${base}/api/schedules/${encodeURIComponent(String(id))}`
}

async function readError(response: Response): Promise<ScheduleApiError> {
  const fallback = `请求失败（HTTP ${response.status}）`
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('detail' in body)) {
      return new ScheduleApiError(response.status, fallback)
    }
    const code = 'code' in body && typeof body.code === 'string' ? body.code : undefined
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string' && detail.trim() !== '') {
      return new ScheduleApiError(response.status, detail, code)
    }
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0]
      if (typeof first === 'object' && first !== null && 'msg' in first) {
        const message = (first as { msg: unknown }).msg
        if (typeof message === 'string') {
          return new ScheduleApiError(response.status, `请求内容不合法：${message}`, code)
        }
      }
    }
  } catch {
    /* 非 JSON 响应使用 HTTP 兜底消息，不回显供应商原始 body。 */
  }
  return new ScheduleApiError(response.status, fallback)
}

/** 创建 HTTP 客户端；`baseUrl` 仅用于测试/多实例场景，默认读 `VITE_API_BASE_URL`。 */
export function createHttpSchedulesClient(baseUrl?: string): SchedulesClient {
  const base = apiBase(baseUrl)
  return {
    source: 'http',

    async list(page: number, signal?: AbortSignal): Promise<ScheduleListPage> {
      const url = `${base}/api/schedules?page=${encodeURIComponent(String(page))}`
      const response = await fetch(url, { signal })
      if (!response.ok) throw await readError(response)
      return await response.json() as ScheduleListPage
    },

    async get(id: ScheduleId, signal?: AbortSignal): Promise<Schedule> {
      const response = await fetch(scheduleUrl(base, id), { signal })
      if (!response.ok) throw await readError(response)
      return await response.json() as Schedule
    },

    async create(input: ScheduleCreateInput): Promise<Schedule> {
      const response = await fetch(`${base}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw await readError(response)
      return await response.json() as Schedule
    },

    async update(id: ScheduleId, input: ScheduleUpdateInput): Promise<Schedule> {
      const response = await fetch(scheduleUrl(base, id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw await readError(response)
      return await response.json() as Schedule
    },

    async remove(id: ScheduleId, expectedRevision: number): Promise<void> {
      const response = await fetch(scheduleUrl(base, id), {
        method: 'DELETE',
        headers: { 'If-Match': `"${expectedRevision}"` },
      })
      if (!response.ok) throw await readError(response)
      // 204 没有正文，不解析 JSON。
    },
  }
}
