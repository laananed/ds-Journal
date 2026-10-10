/** Stage 3 / S3-T03：AI 设置与计量的前端类型。
 *
 * 这里**没有** `api_key` / `base_url` / `model` 请求字段：Key 只存在于后端进程
 * 环境，浏览器既不能读取也不能提交；`model` 只是后端返回的只读状态值。
 */

/** `GET /api/ai/settings` 的响应；缺设置行时 `revision` 为 0。 */
export interface AISettings {
  custom_prompt: string
  web_enabled: boolean
  revision: number
  /** 固定官方模型名，由后端返回，前端不提交。 */
  model: string
  /** 后端进程是否配置了模型 Key；只表示状态，不返回 Key 本身。 */
  model_configured: boolean
  /** 后端进程是否配置了搜索 Key。 */
  search_configured: boolean
  /** 偏好与实际能力同时成立才为 true（偏好 true + 未配置搜索 => false）。 */
  effective_web_enabled: boolean
}

/** `PATCH /api/ai/settings` 的请求；只允许这三项。 */
export interface AISettingsUpdate {
  /** 0 表示「还没有设置行」，首次写入用它创建唯一一行。 */
  expected_revision: number
  /** 省略表示保持不变；空串表示清除。最多 4,000 个 Unicode 码点。 */
  custom_prompt?: string
  web_enabled?: boolean
}

/** `GET /api/ai/usage`：全软件累计。 */
export interface AIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** 未收到官方 usage 的子调用数；不是 0 Token。 */
  unknown_subcalls: number
  /** 独立搜索请求数，不计入模型 Token。 */
  search_requests: number
}

/** 文件身份：跨表身份是 type + id，不共用 id 空间。 */
export interface AISourceIdentity {
  type: 'journal' | 'inbox'
  id: number
  revision?: number
}

/** 单篇文件下方的调用记录（不含问题、结果与设置快照）。 */
export interface AICallSummary {
  request_id: string
  kind: string
  status: string
  created_at: string
  completed_at?: string
  subcalls: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  unknown_subcalls: number
  search_requests: number
  sources: AISourceIdentity[]
  saved_target?: { type: 'journal'; id: number }
}

/** `GET /api/files/{type}/{id}/ai-calls` 的固定 20 条分页。 */
export interface AICallsPage {
  items: AICallSummary[]
  page: number
  page_size: number
  total: number
  has_next: boolean
}
