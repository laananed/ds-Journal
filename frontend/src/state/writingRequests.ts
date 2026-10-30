/**
 * 写作 AI 请求的**应用级**登记与恢复（Stage 4 / S04-T09）。
 *
 * 权威依据：`docs/stage4-api.md` §7（prepare/execute/apply 三段、pending 重放 202、
 * 其余状态 200、prepared 可继续同一 ID、pending/unknown 先查询不自动换键）、
 * §10（恢复索引只存 ID/kind/源身份）、`docs/stage4-architecture.md` §4
 * （`state/aiRequests.ts` 持有在途 Promise；页面卸载不取消执行）。
 *
 * 与 `state/aiRequests.ts` 的分工：那一套是 Stage 3 `local` / `review` 的请求生命期，
 * 其 `AiCallKind` 是公共类型、由 Codex 维护；本文件只为 T09 的
 * `go_deeper` / `minds_comments` 增加应用级登记，**不复制第二套保存队列**，
 * 也不改写公共类型的取值。
 *
 * 三条硬约束：
 * 1. 恢复索引只存 `request_id` / `kind` / `file_id`，绝不写正文、问题、提示词或结果；
 * 2. 任何失败/冲突/unknown 都**不自动换键重发**，只提供查询与显式重做入口；
 * 3. 页面切走不取消执行；结果在回来时按 ID 查询取回，迟到结果不跳转到源页面。
 */

/* --------------------------------------------------------------- 类型 */

export type WritingRequestKind = 'go_deeper' | 'minds_comments'

/** 恢复索引的存储键；与 Stage 3 的 `seekjournal.ai.recovery.v1` 分开。 */
export const WRITING_RECOVERY_KEY = 'seekjournal.ai.writing.v1'

/** 索引上限：按文件去重后天然很小，仍设一个上限避免无限增长。 */
export const WRITING_RECOVERY_LIMIT = 16

export interface WritingRecoveryEntry {
  requestId: string
  kind: WritingRequestKind
  fileId: number
}

/** 后端 `AiRequest.status` 的写作子集（另有 prepared，前端统一表示）。 */
export type WritingStatus =
  | 'prepared'
  | 'pending'
  | 'ready'
  | 'applied'
  | 'failed'
  | 'conflict'
  | 'unknown'

export type WritingPhase =
  /** 正在执行（prepare 已登记、execute 未返回）。 */
  | 'running'
  /** 结果已生成，等待 apply（必须等保存屏障）。 */
  | 'ready'
  | 'applied'
  | 'failed'
  | 'conflict'
  | 'unknown'
  /** 无增量/无有效问题：零请求零费用。 */
  | 'noop'

export interface WritingRequestRecord {
  requestId: string
  kind: WritingRequestKind
  fileId: number
  phase: WritingPhase
  /** 面向用户的一句话状态，不含正文或提示词。 */
  message: string
  /** 是否**可能**已经消耗 Token（不承诺账单精确）。 */
  mayHaveCharged: boolean
  startedAt: number
  updatedAt: number
  /** 结果是否已附着到正文（applied）。 */
  applied: boolean
}

/* --------------------------------------------------------------- 工具 */

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function isKind(value: unknown): value is WritingRequestKind {
  return value === 'go_deeper' || value === 'minds_comments'
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/* --------------------------------------------------------- 恢复索引 */

export function serializeWritingIndex(entries: WritingRecoveryEntry[]): string {
  return JSON.stringify({
    version: 1,
    entries: entries.map((entry) => ({
      requestId: entry.requestId,
      kind: entry.kind,
      fileId: entry.fileId,
    })),
  })
}

/** 解析：任何非法条目丢弃，多余字段（哪怕夹杂正文）一律不保留。 */
export function parseWritingIndex(raw: string | null): WritingRecoveryEntry[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const entries = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return []
  const output: WritingRecoveryEntry[] = []
  for (const item of entries) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (!isUuid(record.requestId)) continue
    if (!isKind(record.kind)) continue
    const fileId = record.fileId
    if (typeof fileId !== 'number' || !Number.isInteger(fileId) || fileId < 1) continue
    output.push({ requestId: record.requestId, kind: record.kind, fileId })
  }
  return output
}

export function readWritingIndex(storage: StorageLike | null | undefined): WritingRecoveryEntry[] {
  if (storage === null || storage === undefined) return []
  try {
    return parseWritingIndex(storage.getItem(WRITING_RECOVERY_KEY))
  } catch {
    return []
  }
}

export function writeWritingIndex(
  storage: StorageLike | null | undefined,
  entries: WritingRecoveryEntry[],
): void {
  if (storage === null || storage === undefined) return
  try {
    storage.setItem(WRITING_RECOVERY_KEY, serializeWritingIndex(entries))
  } catch { /* 隐私模式 / 配额满：索引写失败不影响本次请求本身。 */ }
}

/** 登记一条：同 request_id 不重复；同文件同 kind 只保留最近一条。 */
export function addWritingEntry(
  entries: WritingRecoveryEntry[],
  entry: WritingRecoveryEntry,
): WritingRecoveryEntry[] {
  const kept = entries.filter((item) => item.requestId !== entry.requestId
    && !(item.fileId === entry.fileId && item.kind === entry.kind))
  return [...kept, { requestId: entry.requestId, kind: entry.kind, fileId: entry.fileId }]
    .slice(-WRITING_RECOVERY_LIMIT)
}

export function removeWritingEntry(
  entries: WritingRecoveryEntry[],
  requestId: string,
): WritingRecoveryEntry[] {
  return entries.filter((entry) => entry.requestId !== requestId)
}

export function findWritingEntry(
  entries: WritingRecoveryEntry[],
  fileId: number,
  kind?: WritingRequestKind,
): WritingRecoveryEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.fileId !== fileId) continue
    if (kind !== undefined && entry.kind !== kind) continue
    return entry
  }
  return null
}

/* --------------------------------------------------------- 状态推进 */

function isWritingStatus(value: unknown): value is WritingStatus {
  return value === 'prepared' || value === 'pending' || value === 'ready' || value === 'applied'
    || value === 'failed' || value === 'conflict' || value === 'unknown'
}

/** 后端 status → 前端阶段；未知取值一律按 unknown（绝不当作成功）。 */
export function phaseForWritingStatus(status: unknown): WritingPhase {
  if (!isWritingStatus(status)) return 'unknown'
  switch (status) {
    case 'prepared': return 'running'
    case 'pending': return 'running'
    case 'ready': return 'ready'
    case 'applied': return 'applied'
    case 'failed': return 'failed'
    case 'conflict': return 'conflict'
    default: return 'unknown'
  }
}

/** 是否终态（可以停止轮询/不再等待）。 */
export function isTerminal(phase: WritingPhase): boolean {
  return phase !== 'running'
}

/** 是否可能已经产生费用：只有明确的「未调用」类失败才算没花钱。 */
export function mayHaveCharged(phase: WritingPhase, usage: unknown): boolean {
  if (phase === 'noop') return false
  if (phase === 'applied' || phase === 'ready') return true
  if (typeof usage === 'object' && usage !== null) {
    const total = (usage as { total_tokens?: unknown }).total_tokens
    const unknownSubcalls = (usage as { unknown_subcalls?: unknown }).unknown_subcalls
    if (typeof total === 'number' && total > 0) return true
    if (typeof unknownSubcalls === 'number' && unknownSubcalls > 0) return true
  }
  return phase === 'unknown'
}

export interface WritingRequestLike {
  request_id?: unknown
  status?: unknown
  usage?: unknown
  error?: { category?: unknown; message?: unknown } | null
}

function errorMessageOf(detail: WritingRequestLike): string | null {
  if (typeof detail.error !== 'object' || detail.error === null) return null
  const message = detail.error.message
  return typeof message === 'string' && message.trim() !== '' ? message : null
}

/**
 * 把一次 prepare / execute / 查询的响应并进记录。
 *
 * `prepare` 只回 `{request_id,status:'prepared',files,effects}`，没有 `usage`；
 * 这时不能声称「已计费」（模型还没调用），也不能当作 ready。
 */
export function mergeWritingDetail(
  record: WritingRequestRecord,
  detail: WritingRequestLike,
  now: number,
): WritingRequestRecord {
  const phase = phaseForWritingStatus(detail.status)
  const message = errorMessageOf(detail) ?? defaultMessage(phase, record.kind)
  return {
    ...record,
    phase,
    message,
    applied: phase === 'applied',
    mayHaveCharged: mayHaveCharged(phase, detail.usage),
    updatedAt: now,
  }
}

export function defaultMessage(phase: WritingPhase, kind: WritingRequestKind): string {
  const label = kind === 'minds_comments' ? 'Minds 评论' : 'Go Deeper'
  switch (phase) {
    case 'running': return `${label} 正在处理：可以继续写、可以切页，结果回来后会原位附着。`
    case 'ready': return `${label} 结果已生成，等待写入正文（会先保存你的最新输入）。`
    case 'applied': return `${label} 已写入正文。`
    case 'failed': return `${label} 失败：结果没有附着。可手动重试，不会自动重新计费。`
    case 'conflict': return `${label} 没有附着：源文件或占位已变化，结果已保留但不再写入。`
    case 'unknown': return `${label} 状态不明，可能已消耗 Token；请先查询，不要自动重发。`
    case 'noop': return '没有可分析的新内容，也没有有效问题：本次零调用、零费用。'
    default: return ''
  }
}

/* --------------------------------------------------------- 恢复决策 */

export type RecoveryAction =
  /** 服务端没有这个请求：移除入口，不重建。 */
  | 'drop'
  /** 仍在处理：继续查询（有限次数）。 */
  | 'poll'
  /** 已就绪：可以应用（先保存屏障）。 */
  | 'apply'
  /** 已有结果/终态：显示，不强求动作。 */
  | 'show'
  /** 源已失效：保留结果说明，不再附着。 */
  | 'readonly'

export interface RecoveryDecision {
  action: RecoveryAction
  phase: WritingPhase
  message: string
}

/**
 * 关页重开 / 切页回来后怎么处理一条入口。
 *
 * 关键：**任何分支都不会重新 POST**。`prepared` 可以显式继续同一 ID（服务端保证
 * 只执行一次），`pending` 只查询，`failed` / `conflict` / `unknown` 只显示。
 */
export function decideRecovery(
  entry: WritingRecoveryEntry,
  detail: WritingRequestLike | 'missing',
): RecoveryDecision {
  if (detail === 'missing') {
    return { action: 'drop', phase: 'unknown', message: '服务端没有这次请求的记录，已移除失效入口（不会自动重建）。' }
  }
  const status = detail.status
  if (status === 'pending') {
    return { action: 'poll', phase: 'running', message: defaultMessage('running', entry.kind) }
  }
  if (status === 'prepared') {
    return {
      action: 'show',
      phase: 'running',
      message: `${entry.kind === 'minds_comments' ? 'Minds 评论' : 'Go Deeper'} 已登记但还没执行：可以按同一个 request_id 继续，不会重复登记。`,
    }
  }
  const phase = phaseForWritingStatus(status)
  if (phase === 'ready') return { action: 'apply', phase, message: defaultMessage(phase, entry.kind) }
  if (phase === 'applied') return { action: 'show', phase, message: defaultMessage(phase, entry.kind) }
  if (phase === 'conflict') return { action: 'readonly', phase, message: defaultMessage(phase, entry.kind) }
  if (phase === 'unknown') return { action: 'show', phase, message: defaultMessage(phase, entry.kind) }
  return { action: 'show', phase, message: defaultMessage(phase, entry.kind) }
}

/* ----------------------------------------------------------- 展示 */

export function phaseLabel(phase: WritingPhase): string {
  switch (phase) {
    case 'running': return 'AI 处理中'
    case 'ready': return '待写入'
    case 'applied': return '已写入'
    case 'failed': return '失败'
    case 'conflict': return '未附着'
    case 'unknown': return '状态未知'
    case 'noop': return '无需调用'
    default: return ''
  }
}

/** 是否需要用户在界面上看到「可能已计费」的提醒。 */
export function needsChargeWarning(record: WritingRequestRecord): boolean {
  return record.mayHaveCharged && (record.phase === 'failed' || record.phase === 'unknown')
}
