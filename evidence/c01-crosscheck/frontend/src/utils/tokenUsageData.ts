/** Stage 3 / S3-T03：Token 计量响应的纯投影逻辑。
 *
 * 组件一次性面向两个真实契约：
 *
 * - 全局：`GET /api/ai/usage` → `AIUsage`（五项数字）；
 * - 文件：`GET /api/files/{type}/{id}/ai-calls` → `AICallsPage`
 *   （`items` + `page/page_size/total/has_next`）。
 *
 * 这里只做「响应 → 视图需要的字段」的纯投影，没有任何 IO 或 React 依赖，
 * 因此可以用 Node 直接测：既覆盖分页边界，也把「文件分页对象被误当累计用量」
 * 这类缺陷挡在组件之外。
 *
 * 分页事实只有一个来源：服务端 `has_next`。**不**用「本页返回了几条」推断，
 * 否则 `total` 恰好是 20 的整数倍时最后一页仍会被判为还有下一页。
 */

import type { AICallSummary, AICallsPage, AISourceIdentity, AIUsage } from '../types/ai.ts'

export type UsageSection = {
  kind: 'usage'
  usage: AIUsage
  calls: null
  pagination: null
}

export type CallsPagination = {
  page: number
  pageSize: number
  total: number
  hasNext: boolean
}

export type CallsSection = {
  kind: 'calls'
  usage: null
  calls: AICallSummary[]
  pagination: CallsPagination
}

export type TokenUsageSection = UsageSection | CallsSection

/** 非负整数兜底：后端字段缺失/异常时退回给定默认值，不用 NaN 渲染。 */
function safeCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function safeSources(value: unknown): AISourceIdentity[] {
  return Array.isArray(value) ? value as AISourceIdentity[] : []
}

function safeCall(value: unknown): AICallSummary {
  const call = (typeof value === 'object' && value !== null ? value : {}) as Partial<AICallSummary>
  return {
    request_id: typeof call.request_id === 'string' ? call.request_id : '',
    kind: typeof call.kind === 'string' ? call.kind : '',
    status: typeof call.status === 'string' ? call.status : '',
    created_at: typeof call.created_at === 'string' ? call.created_at : '',
    completed_at: typeof call.completed_at === 'string' ? call.completed_at : undefined,
    subcalls: safeCount(call.subcalls, 0),
    prompt_tokens: safeCount(call.prompt_tokens, 0),
    completion_tokens: safeCount(call.completion_tokens, 0),
    total_tokens: safeCount(call.total_tokens, 0),
    unknown_subcalls: safeCount(call.unknown_subcalls, 0),
    search_requests: safeCount(call.search_requests, 0),
    sources: safeSources(call.sources),
    saved_target: call.saved_target ?? undefined,
  }
}

/** `GET /api/ai/usage`：全软件累计（五项数字，未知子调用单独计数）。 */
export function shapeUsageResponse(response: AIUsage): UsageSection {
  return {
    kind: 'usage',
    usage: {
      prompt_tokens: safeCount(response?.prompt_tokens, 0),
      completion_tokens: safeCount(response?.completion_tokens, 0),
      total_tokens: safeCount(response?.total_tokens, 0),
      unknown_subcalls: safeCount(response?.unknown_subcalls, 0),
      search_requests: safeCount(response?.search_requests, 0),
    },
    calls: null,
    pagination: null,
  }
}

/** `GET /api/files/{type}/{id}/ai-calls`：固定页大小的调用记录。 */
export function shapeFileCallsResponse(response: AICallsPage): CallsSection {
  const items = Array.isArray(response?.items) ? response.items : []
  return {
    kind: 'calls',
    usage: null,
    calls: items.map(safeCall),
    pagination: {
      page: safeCount(response?.page, 1),
      pageSize: safeCount(response?.page_size, items.length),
      total: safeCount(response?.total, items.length),
      // 唯一权威来源：服务端 has_next。
      hasNext: response?.has_next === true,
    },
  }
}
