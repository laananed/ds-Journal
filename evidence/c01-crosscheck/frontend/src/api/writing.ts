/**
 * 结构化写作 API（Stage 3 / S3-T04）。
 *
 * 目前只有一个专用接口：删除指定 AI 段。
 * 其余结构化写入口复用既有 `api/journals.ts` / `api/inboxes.ts`
 * （POST/PATCH 提交 `content_blocks`）。
 */

export class WritingApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'WritingApiError'
    this.status = status
  }
}

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
 * 删除指定 AI 段（`DELETE /api/files/{type}/{id}/ai-blocks/{block_id}`）。
 *
 * - `type` 仅 `journal` / `inbox`（Insight 没有 blocks）；
 * - 必须携带 `If-Match: "<revision>"`：缺版本 428、旧版本 409；
 * - user 段返回 422、文件或段不存在返回 404；
 * - 成功 204 空体，**不能**解析 JSON；
 * - 只删指定 AI 段，不会回退检查点、也不会减少已发生的 Token。
 */
export async function deleteAiBlock(
  type: 'journal' | 'inbox',
  id: number,
  blockId: string,
  expectedRevision: number,
): Promise<void> {
  const response = await fetch(
    `${getApiBaseUrl()}/api/files/${type}/${id}/ai-blocks/${encodeURIComponent(blockId)}`,
    { method: 'DELETE', headers: { 'If-Match': `"${expectedRevision}"` } },
  )
  if (!response.ok) throw new WritingApiError(response.status, await readErrorMessage(response))
}
