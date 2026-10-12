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

/* -------------------------------------------------------------------------
 * Stage 3 / S3-T07：局部互动与请求恢复（`docs/stage3-api.md` §4）
 *
 * 这些形状与后端 `backend/app/ai/schemas.py` 一一对应。前端**只提交**
 * `request_id` / `source` / `question`：正文、增量、检查点、AI 回复一律由
 * 后端从文件与检查点算出来，前端不自报 delta，也不伪造蓝块。
 * ---------------------------------------------------------------------- */

/** `web_status`：关闭 / 缺配置 / 未需要 / 成功 / 失败 / 拦截。 */
export type AIWebStatus =
  | 'disabled'
  | 'not_configured'
  | 'not_needed'
  | 'searched'
  | 'failed'
  | 'blocked'

/** 引用：只有标题与纯 HTTP(S) 地址。 */
export interface AICitation {
  title: string
  url: string
}

/** `AiRequest.status` 的固定取值。 */
export type AIRequestStatus = 'pending' | 'ready' | 'applied' | 'failed' | 'conflict' | 'unknown'

/** `POST /api/ai/local` 的 source 参数：必须带 `expected_revision`。 */
export interface AILocalSource {
  type: 'journal' | 'inbox'
  id: number
  expected_revision: number
}

/** `POST /api/ai/local` 请求体；`question` 是独立对话信息，不写回正文。 */
export interface AILocalRequest {
  request_id: string
  source: AILocalSource
  question?: string
}

/** 后端安全分类的错误说明（不透传上游原文）。 */
export interface AIRequestErrorInfo {
  category?: string | null
  message?: string | null
}

/**
 * `AiRequest`：`POST /api/ai/local` 的 200/202 响应，
 * 以及 `GET /api/ai/requests/{request_id}` 的响应。
 *
 * `file` 在 applied local 时是**完整文件详情**（AI 段已由后端附着）；
 * 前端只用它刷新保存基线，绝不自己插入蓝块。
 */
export interface AIRequestDetail {
  request_id: string
  kind: 'local' | 'review'
  status: AIRequestStatus
  sources: AISourceIdentity[]
  reply: string | null
  file: Record<string, unknown> | null
  review: Record<string, unknown> | null
  saved_target: { type: 'journal'; id: number } | null
  usage: AIUsage
  web_status: AIWebStatus
  citations: AICitation[]
  error: AIRequestErrorInfo | null
}

/**
 * 无有效增量、也无有效问题时的固定响应：
 * 零模型调用、零请求登记、零蓝块（`docs/stage3-api.md` §4）。
 */
export interface AINoopResponse {
  status: 'noop'
  message: string
  request_id: null
  usage: null
}

/** `POST /api/ai/local` 的两种 200 结果。 */
export type AILocalResponse = AIRequestDetail | AINoopResponse

/** 带上 HTTP 状态码的调用结果：202 表示同键重放且仍在处理。 */
export interface AILocalResult {
  status: number
  body: AILocalResponse
}
