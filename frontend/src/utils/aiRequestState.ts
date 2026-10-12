/**
 * AI 局部调用的**纯逻辑**（Stage 3 / S3-T07）。
 *
 * 本文件不依赖 React、不发请求，因此可以用
 * `node --experimental-strip-types src/utils/aiRequestState.test.ts` 直接测试；
 * React 生命周期、fetch 与轮询定时器在
 * `../components/AiWritingActions.tsx`。
 *
 * 权威来源：
 * - `docs/stage3-api.md` §4：`POST /api/ai/local`、`GET /api/ai/requests/{id}`、
 *   noop 文案、status 取值、web_status 取值、citations 形状、
 *   「客户端仅持久化请求 ID/kind/源身份」「404 移除入口、不自动 POST 重建」；
 * - `docs/stage3.md` §3、§7：点击才调用、独立问题不写成日记事实、
 *   处理中锁定（最长 90 秒）、未知计量不显示成 0、不静默重复付费；
 * - `docs/stage3-architecture.md` §5：恢复索引只存身份、有限轮询、未知状态处理。
 *
 * 这个模块负责四件事：
 *
 * 1. **调用状态机**：把「点击 → flush → 发送 → 应用/失败/未知」的每一步
 *    收敛成一个可比较的纯数据状态，UI 只负责渲染；
 * 2. **恢复索引**：写入 localStorage 的**只有** request_id、kind 与源 typed 身份，
 *    绝不写入正文、问题、提示词、结果或 Key；
 * 3. **有限轮询策略**：只在有在途状态、页面可见且未卸载时继续，90 秒后收敛为
 *    unknown，且**永不自动换新 UUID 重发**；
 * 4. **展示安全**：引用只接受纯 HTTP(S)、usage 未知不显示成 0、搜索次数单列。
 */

/* ------------------------------------------------------------------ 常量 */

/** 无新增、无有效问题时后端返回的固定文案（`docs/stage3-api.md` §4）。 */
export const NOOP_MESSAGE = '要我分析啥啊？'

/** 恢复索引的 localStorage 键；键名固定，便于用户自查与清除。 */
export const RECOVERY_STORAGE_KEY = 'seekjournal.ai.recovery.v1'

/** 问题栏长度上限（`docs/stage3-api.md` §4：最多 2,000 码点）。 */
export const QUESTION_MAX_CODE_POINTS = 2000

/** 有限轮询的间隔；与产品 §3 的「最长 90 秒处理中」一致。 */
export const POLL_INTERVAL_MS = 2000
/** 最多轮询次数：45 × 2 秒 = 90 秒。 */
export const POLL_MAX_ATTEMPTS = 45

/** 恢复索引最多保留的条目数（按源去重，天然远小于该上限）。 */
export const RECOVERY_INDEX_LIMIT = 16

/** 未知状态的固定说明；不承诺服务器未计费。 */
export const CLIENT_TIMEOUT_NOTE = '客户端超时不代表服务器已取消或未计费。'

/* ------------------------------------------------------------------ 类型 */

export type AiCallKind = 'local' | 'review'
export type AiSourceType = 'journal' | 'inbox'
export type AiRequestStatus = 'pending' | 'ready' | 'applied' | 'failed' | 'conflict' | 'unknown'
export type AiWebStatus = 'disabled' | 'not_configured' | 'not_needed' | 'searched' | 'failed' | 'blocked'

/** 跨表身份：type + id（不共用 id 空间）。 */
export interface AiSourceRef {
  type: AiSourceType
  id: number
}

/** 一次功能调用的计量；`null` 表示官方未返回 usage。 */
export interface AiUsageView {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  unknown_subcalls: number
  search_requests: number
}

/** 安全引用：只保留标题文本与纯 HTTP(S) 地址。 */
export interface AiCitation {
  title: string
  url: string
}

/**
 * 调用阶段。`preparing` 与 `sending` / `polling` 一样属于「在途」，
 * 因此从第一次点击起就阻止第二次点击（双击只产生一个功能请求）。
 */
export type AiPhase =
  | 'idle'
  | 'preparing'
  | 'sending'
  | 'polling'
  | 'ready'
  | 'applied'
  | 'noop'
  | 'failed'
  | 'conflict'
  | 'unknown'
  | 'blocked'

export interface AiCallState {
  phase: AiPhase
  requestId: string | null
  source: AiSourceRef | null
  /** 面向用户的一句话说明（成功 / 失败原因 / 下一步）。 */
  message: string
  /** 本次调用的计量（同 request_id 全部模型子调用合计）。 */
  usage: AiUsageView | null
  reply: string | null
  citations: AiCitation[]
  webStatus: AiWebStatus
  /** 是否**可能**已经消耗 Token（不承诺账单精确）。 */
  mayHaveCharged: boolean
  /** 已发起的轮询次数。 */
  attempts: number
  /** 本次状态是否来自关页重开后的恢复查询。 */
  recovered: boolean
}

/** 后端 `GET /api/ai/requests/{id}` 的最小结构（其余字段按需读取）。 */
export interface AiRequestLike {
  request_id?: string | null
  kind?: string | null
  status?: string | null
  reply?: string | null
  usage?: unknown
  web_status?: unknown
  citations?: unknown
  error?: { category?: string | null; message?: string | null } | null
  file?: unknown
}

/** 后端 `POST /api/ai/local` 的 noop 分支。 */
export interface AiNoopLike {
  status: 'noop'
  message?: string | null
}

export interface AiTransportFailure {
  /** HTTP 状态；完全没拿到响应时为 `null`（网络断开 / CORS / 超时）。 */
  status: number | null
  message: string
  /** 后端错误体里可查询的 request_id（502/504 会带）。 */
  requestId?: string | null
}

/** `localStorage` 的最小接口，便于纯逻辑测试注入假实现。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 恢复索引条目：**只有**这三个字段。 */
export interface AiRecoveryEntry {
  requestId: string
  kind: AiCallKind
  source: AiSourceRef
}

/** 关页重开后对一条恢复入口的处理计划。 */
export type RecoveryPlan =
  | { action: 'drop' }
  | { action: 'show' }
  | { action: 'poll' }

/** 后端完整文件详情的最小可用投影（AI 块已由后端附着）。 */
export interface AiFileBlock {
  id: string
  kind: string
  text: string
  request_id?: string
}

export interface AiFileDetail {
  id: number
  revision: number
  content: string
  content_blocks: AiFileBlock[] | null
  title: string | null
  display_title: string
  folder_id: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** 业务日期值（Journal 取 journal_date，Inbox 取 inbox_date）。 */
  date: string
  /** 业务日期来自哪个字段，供页面重建正确的类型。 */
  dateField: 'journal_date' | 'inbox_date'
  isDaily?: boolean
}

/* ------------------------------------------------------------ 小工具 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function countCodePoints(text: string): number {
  return Array.from(text).length
}

/** 真实的 UUID 形态（后端 `request_id` 是 UUID）。 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/** 生成一次新的幂等键；**只有用户显式点击新请求时才调用**。 */
export function newRequestId(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16)
    const value = char === 'x' ? random : ((random & 0x3) | 0x8)
    return value.toString(16)
  })
}

/* ------------------------------------------------------ 问题栏归一化 */

/**
 * 独立问题栏的归一化：纯空白视为「没有提问」（后端同样按无问题处理）。
 * 超过 2,000 码点直接判为无效，**不截断**——截断会把用户的问题改掉。
 */
export function normalizeQuestion(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (countCodePoints(trimmed) > QUESTION_MAX_CODE_POINTS) return null
  return trimmed
}

/* ---------------------------------------------------------- 状态机 */

export function initialAiCallState(): AiCallState {
  return {
    phase: 'idle',
    requestId: null,
    source: null,
    message: '',
    usage: null,
    reply: null,
    citations: [],
    webStatus: 'not_needed',
    mayHaveCharged: false,
    attempts: 0,
    recovered: false,
  }
}

/** 在途阶段：这几个阶段禁止第二次点击，也锁定当前文件的编辑与导航。 */
const IN_FLIGHT: readonly AiPhase[] = ['preparing', 'sending', 'polling']

export function aiCallInFlight(state: AiCallState): boolean {
  return IN_FLIGHT.includes(state.phase)
}

/** 处理中锁：与自动保存的 busy 完全分开（避免误解锁或死锁）。 */
export function aiCallLocksFile(state: AiCallState): boolean {
  return aiCallInFlight(state)
}

/** 是否允许开始一次新的功能调用（双击 / 连点只产生一个请求）。 */
export function canStartAiCall(state: AiCallState): boolean {
  return !aiCallInFlight(state)
}

/** 从点击到 flush 完成之前的过渡态；已具备在途语义。 */
export function beginAiPreparation(state: AiCallState, source: AiSourceRef): AiCallState {
  return {
    ...initialAiCallState(),
    phase: 'preparing',
    source,
    message: '正在先保存最新草稿……',
    attempts: 0,
    recovered: state.recovered,
  }
}

/** 记录一次调用：UUID 在**发送前**就已创建，并随之写入恢复索引。 */
export function beginAiCall(
  state: AiCallState,
  options: { requestId: string; source: AiSourceRef },
): AiCallState {
  return {
    ...initialAiCallState(),
    phase: 'sending',
    requestId: options.requestId,
    source: { type: options.source.type, id: options.source.id },
    message: 'AI 正在处理……',
    attempts: 0,
    recovered: state.recovered,
  }
}

/** 问题是独立对话信息：不写回日记正文，只在发送后清空输入框。 */
export function clearCallResult(state: AiCallState): AiCallState {
  return { ...initialAiCallState(), source: state.source, recovered: false }
}

export function normalizeUsage(raw: unknown): AiUsageView | null {
  if (!isRecord(raw)) return null
  const prompt = raw.prompt_tokens
  const completion = raw.completion_tokens
  const total = raw.total_tokens
  const unknownSubcalls = raw.unknown_subcalls
  const searchRequests = raw.search_requests
  if (!isNonNegativeInt(prompt) || !isNonNegativeInt(completion) || !isNonNegativeInt(total)
    || !isNonNegativeInt(unknownSubcalls) || !isNonNegativeInt(searchRequests)) return null
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    unknown_subcalls: unknownSubcalls,
    search_requests: searchRequests,
  }
}

function usageIndicatesCharge(usage: AiUsageView | null): boolean {
  if (usage === null) return false
  return usage.total_tokens > 0 || usage.unknown_subcalls > 0
}

export function isNoopResponse(value: unknown): value is AiNoopLike {
  return isRecord(value) && value.status === 'noop'
}

/** 后端 status → 前端阶段；未知取值一律按 unknown 处理，绝不当作成功。 */
function phaseForStatus(status: string | null | undefined): AiPhase {
  switch (status) {
    case 'pending': return 'polling'
    case 'ready': return 'ready'
    case 'applied': return 'applied'
    case 'failed': return 'failed'
    case 'conflict': return 'conflict'
    case 'unknown': return 'unknown'
    default: return 'unknown'
  }
}

function messageForPhase(phase: AiPhase, reply: string | null, category: string | null, fallback: string | null): string {
  switch (phase) {
    case 'applied':
      return reply === null || reply === ''
        ? 'AI 回复已由后端写入正文（蓝块见下方正文）。'
        : 'AI 回复已由后端附着到本次调用的用户正文之后，可在下方继续写。'
    case 'ready':
      return '结果已生成，等待你在预览里确认后保存。'
    case 'polling':
      return '后端仍在处理这次调用，正在等待结果……'
    case 'failed':
      return fallback ?? describeErrorCategory(category)
    case 'conflict':
      return fallback ?? describeErrorCategory(category ?? 'source_changed')
    case 'unknown':
      return fallback ?? `请求状态不明，可能已消耗 Token；请勿自动重发。${CLIENT_TIMEOUT_NOTE}`
    default:
      return fallback ?? ''
  }
}

/** 把后端响应（或查询结果）映射成状态机状态。 */
export function applyAiResponse(state: AiCallState, response: AiRequestLike | AiNoopLike): AiCallState {
  if (isNoopResponse(response)) {
    // 无新增、无有效问题：零模型调用、零请求登记、零蓝块。
    const message = typeof response.message === 'string' && response.message.trim() !== ''
      ? response.message : NOOP_MESSAGE
    return {
      ...initialAiCallState(),
      phase: 'noop',
      source: state.source,
      message,
      recovered: state.recovered,
    }
  }
  const body = response as AiRequestLike
  const phase = phaseForStatus(body.status)
  const usage = normalizeUsage(body.usage)
  const category = isRecord(body.error) && typeof body.error.category === 'string' ? body.error.category : null
  const errorMessage = isRecord(body.error) && typeof body.error.message === 'string' && body.error.message.trim() !== ''
    ? body.error.message : null
  const reply = typeof body.reply === 'string' ? body.reply : null
  const requestId = isUuid(body.request_id) ? body.request_id : state.requestId
  return {
    phase,
    requestId,
    source: state.source,
    message: messageForPhase(phase, reply, category, errorMessage),
    usage,
    reply: phase === 'applied' || phase === 'ready' ? reply : null,
    citations: phase === 'applied' || phase === 'ready' ? sanitizeCitations(body.citations) : [],
    webStatus: isWebStatus(body.web_status) ? body.web_status : 'not_needed',
    mayHaveCharged: usageIndicatesCharge(usage)
      || phase === 'unknown'
      || (phase === 'failed' && usage !== null && usage.unknown_subcalls > 0),
    attempts: state.attempts,
    recovered: state.recovered,
  }
}

/** 传输层失败 → 状态；分开「未调用」与「可能已计费」两种情况。 */
export function applyAiTransportError(state: AiCallState, failure: AiTransportFailure): AiCallState {
  const status = failure.status
  const requestId = isUuid(failure.requestId) ? failure.requestId : state.requestId
  if (status === 503) {
    return {
      ...state, phase: 'blocked', requestId: null, reply: null, usage: null, citations: [],
      webStatus: 'not_needed', mayHaveCharged: false,
      message: '后端没有配置模型 Key（HTTP 503），本次未调用模型，不会消耗 Token；手动记录功能不受影响。',
    }
  }
  if (status === 429) {
    return {
      ...state, phase: 'blocked', requestId: null, reply: null, usage: null, citations: [],
      webStatus: 'not_needed', mayHaveCharged: false,
      message: '同时进行的 AI 调用已达上限（HTTP 429），本次未调用模型，请稍后重试。',
    }
  }
  if (status === 409) {
    return {
      ...state, phase: 'conflict', requestId: null, reply: null, usage: null, citations: [],
      webStatus: 'not_needed', mayHaveCharged: false,
      message: '文件版本已变化，或该文件已有在途请求（HTTP 409）；本次未调用模型，请刷新后重试。',
    }
  }
  if (status === 428 || status === 422 || status === 404) {
    return {
      ...state, phase: 'failed', requestId: null, reply: null, usage: null, citations: [],
      webStatus: 'not_needed', mayHaveCharged: false,
      message: `请求被拒绝（HTTP ${status}），本次未调用模型。请刷新详情后重试。`,
    }
  }
  if (status !== null && status >= 500) {
    // 上游失败/超时：后端已经登记过请求，可能已产生计费 → 转入查询，不重发。
    return {
      ...state, phase: 'polling', requestId, reply: null, usage: null, citations: [],
      webStatus: 'not_needed', mayHaveCharged: true,
      message: `调用没有正常返回（HTTP ${status}），可能已消耗 Token；${CLIENT_TIMEOUT_NOTE}正在查询这次请求的状态……`,
    }
  }
  // 完全没拿到响应：不知道请求是否已经登记，保留 request_id 供查询，绝不自动重发。
  return {
    ...state, phase: 'unknown', requestId, reply: null, usage: null, citations: [],
    webStatus: 'not_needed', mayHaveCharged: true,
    message: `没有收到服务器确认，可能已消耗 Token。${CLIENT_TIMEOUT_NOTE}请先点「查询状态」核对，或手动重新发起一次新调用。`,
  }
}

/** 查询结果 → 状态；404 表示请求从未登记，移除失效入口。 */
export function applyAiQuery(state: AiCallState, result: AiRequestLike | 'missing'): AiCallState {
  if (result === 'missing') {
    return {
      ...state, phase: 'failed', requestId: null, reply: null, usage: null, citations: [],
      webStatus: 'not_needed', mayHaveCharged: false,
      message: '没有查到这次调用（可能未成功登记）。已移除失效的恢复入口，不会自动重建（不会重新 POST）；如需继续请手动重新发起。',
    }
  }
  const next = applyAiResponse({ ...state, attempts: state.attempts }, result)
  return { ...next, attempts: state.attempts, recovered: state.recovered }
}

/* ---------------------------------------------------------- 轮询策略 */

export function tickAiPolling(state: AiCallState): AiCallState {
  return { ...state, attempts: state.attempts + 1 }
}

/**
 * 是否应该再发一次查询：
 * 只有在途、页面可见、组件未卸载且未达有限轮询上限时才继续。
 */
export function shouldPoll(state: AiCallState, context: { visible: boolean; mounted: boolean }): boolean {
  if (state.phase !== 'polling') return false
  if (!context.visible || !context.mounted) return false
  return state.attempts < POLL_MAX_ATTEMPTS
}

/** 轮询窗口耗尽：收敛为 unknown，并明确「可能已消耗 Token」。 */
export function expirePolling(state: AiCallState): AiCallState {
  if (state.phase !== 'polling') return state
  return {
    ...state,
    phase: 'unknown',
    mayHaveCharged: true,
    message: `等待超过 ${Math.round(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS / 1000)} 秒仍未拿到结果，状态不明，可能已消耗 Token；`
      + `${CLIENT_TIMEOUT_NOTE}不会自动重发，请手动核对或重新发起。`,
  }
}

/**
 * 一次查询之后再等多久发下一次查询；`null` 表示**停止**。
 *
 * 这是「pending 继续轮询、终态立即停止」这条规则的全部依据，所以放在纯逻辑里
 * 由 `aiRequestState.test.ts` 直接测试，而不是埋在组件的定时器里。
 *
 * 只有后端仍报 `pending` 才继续：一次查询返回 pending 后必须自己重排下一次，
 * 否则「有限轮询」实际上只会查询一次，页面会一直停在等待结果。
 */
export function nextPollDelay(result: AiRequestLike | 'missing'): number | null {
  if (result === 'missing') return null
  return result.status === 'pending' ? POLL_INTERVAL_MS : null
}

/* ------------------------------------------------------- 计量与文案 */

/**
 * 本次调用的计量文案。
 *
 * 三条硬规则：官方没有返回 usage 时显示「未知」而不是 0；未知子调用单独列出、
 * 不与已确认 Token 混算；独立搜索请求数与模型 Token 分开显示。
 */
export function formatCallUsage(usage: AiUsageView | null): string {
  if (usage === null) return '计量未知：官方未返回 usage，可能已消耗 Token。'
  if (usage.total_tokens === 0 && usage.unknown_subcalls > 0) {
    return `本次没有已确认 Token，未知子调用 ${usage.unknown_subcalls} 次；不能当作未消耗。`
  }
  const parts = [`已确认 Token ${usage.total_tokens}`]
  if (usage.unknown_subcalls > 0) parts.push(`未知子调用 ${usage.unknown_subcalls} 次`)
  if (usage.search_requests > 0) parts.push(`搜索请求 ${usage.search_requests} 次`)
  return parts.join(' + ').replace(' + 搜索请求', '，搜索请求')
}

/** 引用安全性：只接受能解析出 http/https 主机名的地址。 */
export function isSafeHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.trim() === '') return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return parsed.hostname !== ''
}

/**
 * 引用归一化：只保留 `title` 是字符串、`url` 是纯 HTTP(S) 的条目。
 * 标题**不做 HTML 解析**，由 React 当作文本渲染，因此脚本标签只是字面文字。
 */
export function sanitizeCitations(raw: unknown): AiCitation[] {
  if (!Array.isArray(raw)) return []
  const citations: AiCitation[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const title = item.title
    if (typeof title !== 'string' || title.trim() === '') continue
    if (!isSafeHttpUrl(item.url)) continue
    citations.push({ title, url: item.url as string })
  }
  return citations
}

function isWebStatus(value: unknown): value is AiWebStatus {
  return value === 'disabled' || value === 'not_configured' || value === 'not_needed'
    || value === 'searched' || value === 'failed' || value === 'blocked'
}

/** `web_status` 的中文展示；关闭 / 缺配置 / 未需要 / 成功 / 失败 / 拦截。 */
export function webStatusLabel(status: AiWebStatus): { label: string; hint: string } {
  switch (status) {
    case 'disabled':
      return { label: '未联网（联网开关关闭）', hint: '你在设置里关闭了联网，本次没有使用搜索工具。' }
    case 'not_configured':
      return { label: '未联网（缺少搜索配置）', hint: '后端没有配置搜索 Key，本次没有联网，也没有伪造资料。' }
    case 'not_needed':
      return { label: '未联网（本次不需要）', hint: '这次问题不需要外部资料，模型直接回答。' }
    case 'searched':
      return { label: '已联网搜索', hint: '本次使用了搜索工具，来源见下方引用。' }
    case 'failed':
      return { label: '联网失败', hint: '搜索没有成功，回答基于已有内容，不伪造资料。' }
    case 'blocked':
      return { label: '检索词被拦截', hint: '检索词可能包含隐私或不适内容，已跳过联网。' }
    default:
      return { label: '联网状态未知', hint: '没有拿到联网状态。' }
  }
}

/** 安全分类 → 中文说明；不透传上游原文或正文。 */
export function describeErrorCategory(category: string | null): string {
  switch (category) {
    case 'source_changed': return '源文件已修改或删除，结果没有写入正文。'
    case 'expired': return '请求状态不明，可能已消耗 Token；请勿自动重发。'
    case 'restart': return '应用重启，先前请求状态不明，可能已消耗 Token。'
    case 'timeout': return '上游超时，可能已消耗 Token，结果没有附着。'
    case 'truncated': return '回复不完整，未附着正文。'
    case 'content_limit': return '追加回复会超过正文长度限制，结果已保留未附着。'
    case 'storage': return '正文保存失败，结果已保留，检查点未推进。'
    case 'not_configured': return '后端没有配置模型 Key，本次未调用模型。'
    case 'auth': return '模型凭据被拒绝，本次未产生有效结果。'
    case 'rate_limited': return '上游限流，请稍后重试。'
    case 'unavailable': return '模型服务不可用，请稍后重试。'
    case 'bad_response': return '模型返回无法解析，未附着正文。'
    default: return '调用失败，结果没有附着；可手动重新发起。'
  }
}

/* ------------------------------------------------------- 恢复索引 */

function toEntry(requestId: string, kind: AiCallKind, source: AiSourceRef): AiRecoveryEntry {
  return { requestId, kind, source: { type: source.type, id: source.id } }
}

export function serializeRecoveryIndex(entries: AiRecoveryEntry[]): string {
  return JSON.stringify({
    version: 1,
    entries: entries.map((entry) => toEntry(entry.requestId, entry.kind, entry.source)),
  })
}

/**
 * 解析恢复索引：任何非法的 request_id / kind / 源类型都会被丢弃，
 * 多余字段（哪怕是正文或问题）一律不保留在返回值里。
 */
export function parseRecoveryIndex(raw: string | null): AiRecoveryEntry[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return []
  const entries: AiRecoveryEntry[] = []
  for (const item of parsed.entries) {
    if (!isRecord(item)) continue
    if (!isUuid(item.requestId)) continue
    const kind = item.kind
    if (kind !== 'local' && kind !== 'review') continue
    if (!isRecord(item.source)) continue
    const type = item.source.type
    const id = item.source.id
    if (type !== 'journal' && type !== 'inbox') continue
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) continue
    entries.push(toEntry(item.requestId, kind, { type, id }))
  }
  return entries
}

export function readRecoveryIndex(storage: StorageLike | null | undefined): AiRecoveryEntry[] {
  if (storage === null || storage === undefined) return []
  try {
    return parseRecoveryIndex(storage.getItem(RECOVERY_STORAGE_KEY))
  } catch {
    return []
  }
}

export function writeRecoveryIndex(
  storage: StorageLike | null | undefined,
  entries: AiRecoveryEntry[],
): void {
  if (storage === null || storage === undefined) return
  try {
    storage.setItem(RECOVERY_STORAGE_KEY, serializeRecoveryIndex(entries))
  } catch { /* 隐私模式 / 配额满：恢复索引失败不影响本次调用。 */ }
}

/**
 * 登记一条入口：同一 request_id 不重复；同一源只保留**最近一次**。
 * 这样重开页面时每篇文件最多提示一个待恢复的调用。
 */
export function addRecoveryEntry(
  entries: AiRecoveryEntry[],
  entry: AiRecoveryEntry,
): AiRecoveryEntry[] {
  const kept = entries.filter(
    (item) => item.requestId !== entry.requestId
      && !(item.source.type === entry.source.type && item.source.id === entry.source.id),
  )
  return [...kept, toEntry(entry.requestId, entry.kind, entry.source)].slice(-RECOVERY_INDEX_LIMIT)
}

export function removeRecoveryEntry(entries: AiRecoveryEntry[], requestId: string): AiRecoveryEntry[] {
  return entries.filter((entry) => entry.requestId !== requestId)
}

export function findRecoveryEntry(
  entries: AiRecoveryEntry[],
  source: AiSourceRef | null,
): AiRecoveryEntry | null {
  if (source === null) return null
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.source.type === source.type && entry.source.id === source.id) return entry
  }
  return null
}

/**
 * 关页重开后的处理计划：
 * - 404 → 移除失效入口，**不**重建；
 * - pending → 继续有限轮询；
 * - 其他（applied/ready/failed/conflict/unknown）→ 显示已有结果，不重新发送。
 */
export function planRecovery(entry: AiRecoveryEntry, detail: AiRequestLike | 'missing'): RecoveryPlan {
  if (entry.requestId === '') return { action: 'drop' }
  if (detail === 'missing') return { action: 'drop' }
  if (detail.status === 'pending') return { action: 'poll' }
  return { action: 'show' }
}

/* ------------------------------------------------- 后端文件详情解析 */

function isFileBlock(value: unknown): value is AiFileBlock {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || value.id === '') return false
  if (typeof value.kind !== 'string' || value.kind === '') return false
  if (typeof value.text !== 'string') return false
  if (value.request_id !== undefined && typeof value.request_id !== 'string') return false
  return true
}

/**
 * 解析后端返回的完整文件详情。
 *
 * AI 块由**后端**附着，前端只用这份权威结果刷新保存基线
 * （`docs/stage3-architecture.md` §4：不允许前端自行插入或伪造 AI 段）。
 * 形状不符合预期时返回 `null`，调用方应改为只读重读详情。
 */
export function parseAiFileDetail(raw: unknown): AiFileDetail | null {
  if (!isRecord(raw)) return null
  const id = raw.id
  const revision = raw.revision
  const content = raw.content
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1) return null
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (typeof content !== 'string') return null

  const hasJournalDate = typeof raw.journal_date === 'string'
  const hasInboxDate = typeof raw.inbox_date === 'string'
  if (!hasJournalDate && !hasInboxDate) return null
  const dateField: AiFileDetail['dateField'] = hasJournalDate ? 'journal_date' : 'inbox_date'
  const date = raw[dateField] as string

  let blocks: AiFileBlock[] | null = null
  if (raw.content_blocks !== null && raw.content_blocks !== undefined) {
    if (!Array.isArray(raw.content_blocks)) return null
    const parsed: AiFileBlock[] = []
    for (const item of raw.content_blocks) {
      if (!isFileBlock(item)) return null
      parsed.push({
        id: item.id, kind: item.kind, text: item.text,
        ...(item.request_id === undefined ? {} : { request_id: item.request_id }),
      })
    }
    blocks = parsed
  }

  const title = typeof raw.title === 'string' ? raw.title : null
  const folderId = typeof raw.folder_id === 'number' ? raw.folder_id : null
  const detail: AiFileDetail = {
    id,
    revision,
    content,
    content_blocks: blocks,
    title,
    display_title: typeof raw.display_title === 'string' ? raw.display_title : '',
    folder_id: folderId,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
    deleted_at: typeof raw.deleted_at === 'string' ? raw.deleted_at : null,
    date,
    dateField,
  }
  if (dateField === 'inbox_date' && typeof raw.is_daily === 'boolean') detail.isDaily = raw.is_daily
  return detail
}

/** 阶段的中文标签，用于状态行。 */
export function aiPhaseLabel(phase: AiPhase): string {
  switch (phase) {
    case 'idle': return '未调用'
    case 'preparing': return '正在保存草稿'
    case 'sending': return 'AI 处理中'
    case 'polling': return '等待结果'
    case 'ready': return '待确认'
    case 'applied': return '已完成'
    case 'noop': return '没有可分析的内容'
    case 'failed': return '调用失败'
    case 'conflict': return '源已变化'
    case 'unknown': return '状态未知'
    case 'blocked': return '未调用'
    default: return ''
  }
}
