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
  auto_go_deeper: boolean
  auto_minds_comments: boolean
  mind_preset_ids: MindPresetId[]
}

/** `PATCH /api/ai/settings` 的请求；只允许这三项。 */
export interface AISettingsUpdate {
  /** 0 表示「还没有设置行」，首次写入用它创建唯一一行。 */
  expected_revision: number
  /** 省略表示保持不变；空串表示清除。最多 4,000 个 Unicode 码点。 */
  custom_prompt?: string
  web_enabled?: boolean
  auto_go_deeper?: boolean
  auto_minds_comments?: boolean
  mind_preset_ids?: MindPresetId[]
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
export type AIRequestStatus = 'prepared' | 'pending' | 'ready' | 'applied' | 'failed' | 'conflict' | 'unknown'

export type MindPresetId = 'gentle_reflection' | 'alternative_perspectives' | 'thinking_traps'
export interface AIWritingRange { node_id: string; start: number; end: number }
export type AIWritingScope = 'all' | AIWritingRange | { ranges: AIWritingRange[] }
export type AIWritingPrepare = {
  request_id: string
  trigger: 'manual' | 'automatic'
  source: { type: 'journal'; id: number; expected_revision: number }
} & (
  | { kind: 'go_deeper'; question?: string }
  | { kind: 'minds_comments'; scope?: AIWritingScope; mind_preset_ids?: MindPresetId[] }
)

export interface AICommentAnchor extends AIWritingRange { quote: string; quote_sha256: string }
export interface AIComment {
  id: string
  request_id: string | null
  mind_preset_id: MindPresetId
  text: string
  quote: string
  anchor: AICommentAnchor
  anchor_state: 'available' | 'unavailable'
  created_at: string
}
export interface AICommentsPage {
  items: AIComment[]
  page: number
  page_size: number
  total: number
  has_next: boolean
}
export interface AIWritingMutation {
  request_id: string
  status: AIRequestStatus
  files: import('./journal').Journal[]
  effects: import('../state/editSessions').FileEffect[]
  comments?: Array<{ id: string; anchor_state: 'available' | 'unavailable' }>
}

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
  kind: 'local' | 'review' | 'go_deeper' | 'minds_comments'
  status: AIRequestStatus
  sources: AISourceIdentity[]
  reply: string | null
  file: Record<string, unknown> | null
  /** 完整复盘的私有结果；形状由 `AIReviewObject` 描述，调用方仍应严格解析。 */
  review: AIReviewObject | null
  saved_target: { type: 'journal'; id: number } | null
  usage: AIUsage
  web_status: AIWebStatus
  citations: AICitation[]
  error: AIRequestErrorInfo | null
  comments?: Array<AIComment | { mind_preset_id: MindPresetId; text: string; anchor: AICommentAnchor }> | null
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

/* -------------------------------------------------------------------------
 * Stage 3 / S3-T09：完整复盘（生成 / 可编辑预览 / 一次确认保存）
 *
 * 这些形状与后端 `backend/app/ai/schemas.py`（`ReviewRequest`、`StructuredReview`、
 * `ReviewSave`）以及 `docs/stage3-api.md` §5～§6 一一对应，是 T09 与 T10 的**公共契约**：
 *
 * - 生成只提交 `request_id` + typed `sources`（含 `expected_revision`），
 *   不自报日期/全文，也不伪造 AI 块；
 * - `AIReviewObject` / `AIInsightDraft` 由 T09 冻结；T10 只消费草稿形状
 *   （`draft_id/title/viewpoint/evidence/content`），**不**修改本文件。
 * ---------------------------------------------------------------------- */

/** `POST /api/ai/reviews` 的 source：与局部调用同一形状（typed + 版本）。 */
export interface AIReviewSource extends AILocalSource {}

/** `POST /api/ai/reviews` 请求体：1～15 个**唯一** typed sources。 */
export interface AIReviewRequest {
  request_id: string
  sources: AILocalSource[]
}

/** 证据来源：固定 `{type,id}`，不含版本（快照由服务端在生成时冻结）。 */
export interface AIReviewEvidenceSource {
  type: 'journal' | 'inbox'
  id: number
}

/** 引用：`quote` 必须是所选中用户正文的子串（服务端校验，AI 回复不能作依据）。 */
export interface AIReviewEvidence {
  source: AIReviewEvidenceSource
  quote: string
}

/** 事实 / 推测条目；推测额外带 `uncertainty` 不确定性说明。 */
export interface AIReviewPoint {
  text: string
  evidence: AIReviewEvidence[]
  uncertainty?: string
}

/** 固定三个角度之一（事件与情绪 / 选择与行为 / 认知与关系）。 */
export interface AIReviewAngle {
  title: string
  content: string
}

/**
 * Insight 草稿：一个 viewpoint 对应一份草稿，`draft_id` 由后端稳定生成。
 * T10 从 `draft_id` 派生稳定 `client_create_id` 后才创建 Insight 文件。
 */
export interface AIInsightDraft {
  draft_id: string
  title: string
  viewpoint: string
  evidence: AIReviewEvidence[]
  content: string
}

/** 完整的私有复盘结果（`GET /api/ai/requests/{id}` 与 `POST /api/ai/reviews` 的 `review`）。 */
export interface AIReviewObject {
  facts: AIReviewPoint[]
  emotion_hypotheses: AIReviewPoint[]
  possible_explanations: AIReviewPoint[]
  angles: AIReviewAngle[]
  logic_chain: string[]
  follow_up_questions: string[]
  insight_drafts: AIInsightDraft[]
  markdown: string
}

/** 单篇 Journal 的默认保存方式：在原文底部以 `---` 追加 AI 总结。 */
export interface AIReviewAppendTarget {
  mode: 'append_source'
}

/** Inbox 单篇 / 多篇：新建 Journal（默认日期由前端发起时捕获，Folder 默认 null）。 */
export interface AIReviewNewJournalTarget {
  mode: 'new_journal'
  title: string | null
  journal_date: string
  folder_id: number | null
}

export type AIReviewTarget = AIReviewAppendTarget | AIReviewNewJournalTarget

/** `POST /api/ai/reviews/{request_id}/save` 请求体：唯一一次确认。 */
export interface AIReviewSaveRequest {
  markdown: string
  target: AIReviewTarget
}

/**
 * save 成功的响应：`status` 固定 `applied`，`target` 是新建/追加后的完整 Journal 详情。
 * 前端据此导航到 `target.id`，**不**自己猜目标。
 */
export interface AIReviewSaveResult {
  request_id: string
  status: 'applied'
  target: Record<string, unknown>
}
