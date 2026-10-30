/** Stage 3 / S3-T03：AI 设置与计量 API 客户端。
 *
 * 只调用后端已有的三个只读/设置接口。这里**不发送** Key、模型名或 base_url：
 * 官方地址与模型固定在后端，浏览器无法参与选择。
 *
 * Stage 3 / S3-T07 追加两个接口：局部互动 `POST /api/ai/local` 与请求查询
 * `GET /api/ai/requests/{request_id}`。两者同样不发送 Key / 模型 / base_url；
 * 正文、增量与检查点都由后端计算，前端只提交 `request_id` + 源身份 + 问题。
 */
import type {
  AICallsPage,
  AILocalRequest,
  AILocalResult,
  AIRequestDetail,
  AIReviewRequest,
  AIReviewSaveRequest,
  AIReviewSaveResult,
  AISettings,
  AISettingsUpdate,
  AIUsage,
  AIWritingPrepare,
  AIWritingMutation,
  AICommentsPage,
  AINoopResponse,
} from '../types/ai'

export class AiApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'AiApiError'
    this.status = status
  }
}

/**
 * 调用失败但后端给了可查询的 `request_id`（502/504）。
 * 客户端据此提示「可能已消耗 Token」，并且**不**自动换新 UUID 重发。
 */
export class AiCallError extends AiApiError {
  readonly requestId: string | null
  constructor(status: number, message: string, requestId: string | null) {
    super(status, message)
    this.name = 'AiCallError'
    this.requestId = requestId
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

/** 502/504 的错误体里带可查询的 request_id；只读取，不写日志、不回显。 */
async function readErrorRequestId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('request_id' in body)) return null
    const requestId = (body as { request_id: unknown }).request_id
    return typeof requestId === 'string' && requestId !== '' ? requestId : null
  } catch {
    return null
  }
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

/* -------------------------------------------------------------------------
 * S3-T07：局部互动与请求恢复
 * ---------------------------------------------------------------------- */

/**
 * `POST /api/ai/local`：一次局部陪伴写作调用。
 *
 * 调用前必须先 `flush()` 最新有效草稿并完成块转换/封口——后端按**文件当前
 * 版本**比对 `expected_revision`，源版本过期返回 409，且这个 409 发生在模型
 * 调用之前（不产生 Token）。
 *
 * 后端只在**完全没有任何上游请求**时返回 503/429，因此这两种失败不会计费；
 * 502/504 会带可查询的 `request_id`，抛出的 `AiCallError` 里保留它，
 * 由界面提示「可能已消耗 Token」并转入查询而不是重发。
 */
export async function postAILocal(
  payload: AILocalRequest,
  signal?: AbortSignal,
): Promise<AILocalResult> {
  const response = await fetch(`${apiBase()}/api/ai/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) {
    const message = await readErrorMessage(response.clone())
    const requestId = await readErrorRequestId(response)
    throw new AiCallError(response.status, message, requestId)
  }
  return { status: response.status, body: await response.json() as AILocalResult['body'] }
}

/**
 * `GET /api/ai/requests/{request_id}`：纯读取，不重发、不产生计费。
 *
 * 未知 ID 返回 404（调用方据此移除失效的恢复入口，**不**自动 POST 重建）。
 */
export async function getAIRequest(
  requestId: string,
  signal?: AbortSignal,
): Promise<AIRequestDetail> {
  const response = await fetch(`${apiBase()}/api/ai/requests/${encodeURIComponent(requestId)}`, { signal })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AIRequestDetail
}

/** S04-T08: prepare freezes the saved source; never submits local text or a checkpoint. */
export async function prepareAIWriting(payload: AIWritingPrepare, signal?: AbortSignal): Promise<AIWritingMutation | AINoopResponse> {
  const response = await fetch(`${apiBase()}/api/ai/writing/prepare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal,
  })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AIWritingMutation | AINoopResponse
}

/** Execute only the existing ID. A failed or uncertain call must not be retried with a new key automatically. */
export async function executeAIWriting(requestId: string, signal?: AbortSignal): Promise<{ status: number; body: AIRequestDetail }> {
  const response = await fetch(`${apiBase()}/api/ai/writing/${encodeURIComponent(requestId)}/execute`, { method: 'POST', signal })
  if (!response.ok) {
    const message = await readErrorMessage(response.clone())
    const id = await readErrorRequestId(response)
    throw new AiCallError(response.status, message, id)
  }
  return { status: response.status, body: await response.json() as AIRequestDetail }
}

export async function applyAIWriting(requestId: string, expectedRevision: number, signal?: AbortSignal): Promise<AIWritingMutation> {
  const response = await fetch(`${apiBase()}/api/ai/writing/${encodeURIComponent(requestId)}/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: expectedRevision }), signal,
  })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AIWritingMutation
}

export async function listAIComments(journalId: number, page = 1, signal?: AbortSignal): Promise<AICommentsPage> {
  const response = await fetch(`${apiBase()}/api/journals/${journalId}/comments?page=${page}`, { signal })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AICommentsPage
}

export async function deleteAIComment(journalId: number, commentId: string, revision: number, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${apiBase()}/api/journals/${journalId}/comments/${encodeURIComponent(commentId)}`, {
    method: 'DELETE', headers: { 'If-Match': `"${revision}"` }, signal,
  })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
}

/* -------------------------------------------------------------------------
 * S3-T09：完整复盘生成与一次确认保存
 * ---------------------------------------------------------------------- */

/**
 * `POST /api/ai/reviews`：一次完整复盘生成（1～15 个唯一 typed sources）。
 *
 * 只发送 `request_id` + typed sources（含 `expected_revision`）；正文/日期由后端
 * 从源文件算出，前端**不自报全文或日期**。所有校验（0/16 源、重复源、8 个日期、
 * 版本过期）都在付费调用之前完成，因此 409/422/404 不会消耗 Token。
 *
 * 返回 200（`status=ready`，含完整 `review`）或 202（同键重放且仍在处理）；
 * 502/504 会带可查询的 `request_id`，抛出的 `AiCallError` 里保留它，
 * 由界面转入「查询状态」而**不**自动换新 UUID 重发。
 */
export async function postAIReview(
  payload: AIReviewRequest,
  signal?: AbortSignal,
): Promise<{ status: number; body: AIRequestDetail }> {
  const response = await fetch(`${apiBase()}/api/ai/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) {
    const message = await readErrorMessage(response.clone())
    const requestId = await readErrorRequestId(response)
    throw new AiCallError(response.status, message, requestId)
  }
  return { status: response.status, body: await response.json() as AIRequestDetail }
}

/**
 * `POST /api/ai/reviews/{request_id}/save`：**唯一一次确认**。
 *
 * `expected_revision` 不在这里发送：后端按生成时冻结的源快照核对，源变化返回 409
 * 并保留预览（不能把过期分析当最新总结）。同一请求同体重放回同一 target；
 * 不同 body 409。
 */
export async function saveAIReview(
  requestId: string,
  payload: AIReviewSaveRequest,
  signal?: AbortSignal,
): Promise<AIReviewSaveResult> {
  const response = await fetch(`${apiBase()}/api/ai/reviews/${encodeURIComponent(requestId)}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) throw new AiApiError(response.status, await readErrorMessage(response))
  return await response.json() as AIReviewSaveResult
}
