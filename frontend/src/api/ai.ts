/** Stage 3 / S3-T03：AI 设置与计量 API 客户端。
 *
 * 只调用后端已有的三个只读/设置接口。这里**不发送** Key、模型名或 base_url：
 * 官方地址与模型固定在后端，浏览器无法参与选择。
 */
import type { AICallsPage, AISettings, AISettingsUpdate, AIUsage } from '../types/ai'

export class AiApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AiApiError'
    this.status = status
  }
}

function apiBase(): string {
  const configured: unknown = import.meta.env?.VITE_API_BASE_URL
  const raw = typeof configured === 'string' && configured.trim() !== ''
    ? configured : 'http://127.0.0.1:8000'
  return raw.trim().replace(/\/+$/, '')
}

/** 后端错误体是简单的 `{"detail": ...}`；422 的 detail 是数组。 */
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
        if (typeof message === 'string') return message
      }
    }
  } catch { /* 非 JSON 响应使用 HTTP 兜底消息。 */ }
  return fallback
}

/** 缺设置行时后端返回默认值与 `revision=0`，且不创建任何行。 */
export async function getAISettings(signal?: AbortSignal): Promise<AISettings> {
  const response = await fetch(`${apiBase()}/api/ai/settings`, { signal })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AISettings
}

/**
 * 首次写入用 `expected_revision: 0` 创建设置行，之后必须带当前版本：
 * 版本过期返回 409，缺少版本返回 428，都由调用方显示并重新读取。
 */
export async function updateAISettings(payload: AISettingsUpdate): Promise<AISettings> {
  const response = await fetch(`${apiBase()}/api/ai/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AISettings
}

/** 全软件累计：仅已知子调用求和，未知子调用与搜索次数分别统计。 */
export async function getAIUsage(signal?: AbortSignal): Promise<AIUsage> {
  const response = await fetch(`${apiBase()}/api/ai/usage`, { signal })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AIUsage
}

/** 单个文件的调用记录；源普通入口失效（不存在/已软删）返回 404。 */
export async function listFileAICalls(
  type: 'journal' | 'inbox',
  id: number,
  page = 1,
  signal?: AbortSignal,
): Promise<AICallsPage> {
  const url = new URL(`${apiBase()}/api/files/${type}/${id}/ai-calls`)
  url.searchParams.set('page', String(page))
  const response = await fetch(url, { signal })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AICallsPage
}
