/**
 * 完整复盘的选择 / 预览 / 一次确认**纯逻辑**（Stage 3 / S3-T09）。
 *
 * 本文件不依赖 React、不发请求，因此可以用
 * `node --experimental-strip-types src/utils/reviewSelection.test.ts` 直接测试；
 * React 生命周期、fetch 与跨分页列表在 `../pages/ReviewPage.tsx`
 * 与 `../components/ReviewPreview.tsx`。
 *
 * 权威来源：
 * - `docs/stage3-api.md` §5：`POST /api/ai/reviews` 收 1～15 个**唯一** typed
 *   sources、服务端按各自业务日期计算 distinct <= 7；不接收用户自报日期/全文；
 *   review 对象含 facts/emotion_hypotheses/possible_explanations/angles（固定三个
 *   标题）/logic_chain/follow_up_questions/insight_drafts/markdown，evidence 固定
 *   `{source,quote}`，Insight 每项 `draft_id/title/viewpoint/evidence/content`；
 * - `docs/stage3-api.md` §6：save target 为 `{mode:"append_source"}` 或
 *   `{mode:"new_journal",title,journal_date,folder_id}`；默认日期由前端在**发起复盘时**
 *   捕获并显式发送；标题可编辑；默认 Folder null；
 * - `docs/stage3.md` §5：单篇 Journal 默认底部 `---` 追加，Inbox 单篇/多篇新建
 *   Journal；最多 7 个**不同**业务日期、15 个去重文件，**非连续**七天合法，
 *   **同日多篇不误限**；只读用户正文，排除既有 AI 局部回复与 AI 总结；
 * - 后端 `backend/app/ai/incremental.py::user_text`：`content_blocks` 非 NULL 时
 *   只取 `kind == 'user'` 的文本拼起来，否则退回旧 `content`（人工旧总结视为用户正文）。
 *
 * 这个模块负责五件事：
 *
 * 1. **选择集合**：用 `type + id` 去重（Journal 1 与 Inbox 1 不是同一篇），
 *    跨分页/跨 Journal 与 Inbox 切换只是同一份纯数组，不需要额外“保留”逻辑；
 * 2. **限额**：15 文件 / 7 个不同业务日期，同日多篇不额外占日期名额；
 * 3. **文本量**：按后端同一口径提取用户正文并计 Unicode 码点，**不**把截断的
 *    卡片摘要当全文字数，**不**计入 `ai_reply` / `ai_summary`；
 * 4. **目标默认值**：单篇 Journal → 追加；Inbox/多篇 → 新建 Journal，并且日期取
 *    发起本轮的本地 04:00 业务日期、Folder 默认 null，可改标题/日期/Folder；
 * 5. **请求/响应纯变换**：把选中项冻结成可重放的 request payload、把 save target
 *    拼成后端形状，并把后端 review 对象严格解析成前端结构（任何字段不符就返回
 *    `null`，调用方改为报错，而不是展示半截结果）。
 */

import type { AiRecoveryEntry } from './aiRequestState.ts'
import type { AIInsightDraft, AIReviewAngle, AIReviewEvidence, AIReviewObject, AIReviewPoint } from '../types/ai.ts'
import { countCodePoints } from './contentValidation.ts'
import { defaultJournalDate } from './journalDate.ts'

/* ------------------------------------------------------------ 源身份与限额 */

export type ReviewSourceType = 'journal' | 'inbox'

/** 跨表身份：`type + id`，不共用 id 空间（与 `types/ai.ts` 的源身份同形）。 */
export interface ReviewSource {
  type: ReviewSourceType
  id: number
}

/** 最多 15 个去重文件（`docs/stage3.md` §5：不是单类各 15 篇）。 */
export const REVIEW_MAX_SOURCES = 15
/** 最多 7 个**不同**业务日期（非连续合法，同日多篇不重复计）。 */
export const REVIEW_MAX_DATES = 7

export function sourceKey(source: ReviewSource): string {
  return `${source.type}:${source.id}`
}

export function sameSource(
  a: ReviewSource | null | undefined,
  b: ReviewSource | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false
  return a.type === b.type && a.id === b.id
}

function compareSources(a: ReviewSource, b: ReviewSource): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1
  return a.id - b.id
}

/** 确定性排序：request payload 与恢复索引锚点都必须能逐字重放。 */
export function sortSources(sources: ReviewSource[]): ReviewSource[] {
  return [...sources].sort(compareSources)
}

export type ReviewLimitReason = 'too_many_sources' | 'too_many_dates'

export interface ReviewLimitResult {
  ok: boolean
  reason: ReviewLimitReason | null
}

/** 选中条目：业务日期来自列表项（Journal `journal_date` / Inbox `inbox_date`）。 */
export interface ReviewEntry {
  source: ReviewSource
  date: string
  /** 用户正文码点数；`undefined` 表示详情尚未读取（不计入总字数）。 */
  userCodePoints?: number
}

export function hasEntry(entries: ReviewEntry[], source: ReviewSource): boolean {
  return entries.some((entry) => sameSource(entry.source, source))
}

export function findEntry(entries: ReviewEntry[], source: ReviewSource): ReviewEntry | null {
  for (const entry of entries) {
    if (sameSource(entry.source, source)) return entry
  }
  return null
}

/** 追加一个条目（调用方应先用 `canAddEntry` 检查限额）。已存在则不重复添加。 */
export function addEntry(entries: ReviewEntry[], candidate: ReviewEntry): ReviewEntry[] {
  if (hasEntry(entries, candidate.source)) return entries
  return [...entries, candidate]
}

export function removeEntry(entries: ReviewEntry[], source: ReviewSource): ReviewEntry[] {
  return entries.filter((entry) => !sameSource(entry.source, source))
}

/** 勾选/取消勾选（跨分页保留靠的是同一份数组，不是每页局部状态）。 */
export function toggleEntry(entries: ReviewEntry[], candidate: ReviewEntry): ReviewEntry[] {
  return hasEntry(entries, candidate.source)
    ? removeEntry(entries, candidate.source)
    : addEntry(entries, candidate)
}

/** 选中项涉及的不同业务日期（已排序去重）。空日期表示「还未读到详情」，不占名额。 */
export function distinctDates(entries: ReviewEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.date).filter((date) => date !== ''))].sort()
}

/** 当前选中集合是否越界（越界时禁止发起复盘）。 */
export function limitFor(entries: ReviewEntry[]): ReviewLimitResult {
  if (entries.length > REVIEW_MAX_SOURCES) return { ok: false, reason: 'too_many_sources' }
  if (distinctDates(entries).length > REVIEW_MAX_DATES) return { ok: false, reason: 'too_many_dates' }
  return { ok: true, reason: null }
}

/**
 * 能否把 candidate 加入选择。
 *
 * 关键点：**同日多篇不误限**——只有当候选日期是一个**新的**业务日期、
 * 且加入后不同日期会超过 7 时才拒绝；已存在的日期重复选不占新名额。
 */
export function canAddEntry(entries: ReviewEntry[], candidate: ReviewEntry): ReviewLimitResult {
  if (hasEntry(entries, candidate.source)) return { ok: true, reason: null }
  if (entries.length + 1 > REVIEW_MAX_SOURCES) return { ok: false, reason: 'too_many_sources' }
  const dates = distinctDates(entries)
  // candidate.date === '' 表示业务日期尚未读到（例如从详情页预选的单篇源）：
  // 无法判断日期名额时先放行，由服务端最终裁定，避免误报「超过 7 个日期」。
  if (candidate.date === '') return { ok: true, reason: null }
  if (!dates.includes(candidate.date) && dates.length + 1 > REVIEW_MAX_DATES) {
    return { ok: false, reason: 'too_many_dates' }
  }
  return { ok: true, reason: null }
}

export function limitMessage(reason: ReviewLimitReason): string {
  switch (reason) {
    case 'too_many_sources':
      return `最多复盘 ${REVIEW_MAX_SOURCES} 篇（去重文件）。`
    case 'too_many_dates':
      return `最多覆盖 ${REVIEW_MAX_DATES} 个不同业务日期；同日多篇不重复占名额。`
    default:
      return ''
  }
}

/* ------------------------------------------------------------- 选择摘要 */

export interface ReviewSelectionSummary {
  count: number
  dateCount: number
  dates: string[]
  totalCodePoints: number
  /** 还没读到详情、字数暂未计入的源数量。 */
  pendingTextCount: number
  limits: ReviewLimitResult
}

/** 汇总当前选择：篇数、不同日期数、已载入的用户正文字数。 */
export function summarizeSelection(entries: ReviewEntry[]): ReviewSelectionSummary {
  let total = 0
  let pending = 0
  for (const entry of entries) {
    if (typeof entry.userCodePoints === 'number') total += entry.userCodePoints
    else pending += 1
  }
  const dates = distinctDates(entries)
  return {
    count: entries.length,
    dateCount: dates.length,
    dates,
    totalCodePoints: total,
    pendingTextCount: pending,
    limits: limitFor(entries),
  }
}

/** 「复盘所选 N 篇（X 字）」——发起前必须让用户看到这个数字。 */
export function selectionLabel(summary: ReviewSelectionSummary): string {
  const pending = summary.pendingTextCount > 0 ? `，${summary.pendingTextCount} 篇字数待载入` : ''
  return `复盘所选 ${summary.count} 篇（${summary.totalCodePoints} 字${pending}）`
}

/* ------------------------------------------------------------- 用户正文 */

export interface ReviewFileLike {
  content: string
  content_blocks?: { kind: string; text: string }[] | null
}

/**
 * 与后端 `incremental.user_text` **逐字一致**：结构化文件只取 user 段文本，
 * 旧正文（`content_blocks` 为 NULL）整体当作用户正文。
 *
 * 因此这里天然排除 `ai_reply` / `ai_summary`；旧文件里人工写入的旧总结无法识别，
 * 按产品 §5 视为旧用户正文。
 */
export function userTextOf(file: ReviewFileLike): string {
  const blocks = file.content_blocks ?? null
  if (blocks === null) return file.content
  return blocks.filter((block) => block.kind === 'user').map((block) => block.text).join('')
}

/** 用户正文的 Unicode 码点数（emoji 按 1 个算，与后端 `len()` 同口径）。 */
export function userCodePointsOf(file: ReviewFileLike): number {
  return countCodePoints(userTextOf(file))
}

/* --------------------------------------------------------- 保存目标默认值 */

export type ReviewTargetMode = 'append_source' | 'new_journal'

export interface ReviewTargetDraft {
  mode: ReviewTargetMode
  title: string
  journal_date: string
  folder_id: number | null
}

/**
 * 默认目标（`docs/stage3.md` §5）：
 * - 只有**恰好一篇 Journal** 才默认 `append_source`；
 * - Inbox 单篇与任意多篇默认 `new_journal`。
 */
export function defaultTargetMode(sources: ReviewSource[]): ReviewTargetMode {
  return sources.length === 1 && sources[0].type === 'journal' ? 'append_source' : 'new_journal'
}

/**
 * 初始目标草稿。日期默认取**发起本轮的本地 04:00 业务日期**（调用方可在用户确认前
 * 捕获并传入），Folder 默认 null，标题留空（后端用「AI 复盘 YYYY-MM-DD」）。
 */
export function initialTargetDraft(
  sources: ReviewSource[],
  businessDate: string = defaultJournalDate(),
): ReviewTargetDraft {
  return { mode: defaultTargetMode(sources), title: '', journal_date: businessDate, folder_id: null }
}

/** 后端 `new_journal` target 的标题上限（与 `ReviewSave`/`NewReviewTarget` 一致）。 */
export const REVIEW_TITLE_MAX_CODE_POINTS = 80

/**
 * 本地可提交判定：只在校验通过时才允许点「确认保存」。
 * `append_source` 不需要日期/标题/Folder，因此恒为合法。
 */
export function validateTargetDraft(draft: ReviewTargetDraft): string | null {
  if (draft.mode === 'append_source') return null
  if (draft.journal_date.trim() === '') return '新建 Journal 需要业务日期。'
  if (countCodePoints(draft.title) > REVIEW_TITLE_MAX_CODE_POINTS) {
    return `标题最多 ${REVIEW_TITLE_MAX_CODE_POINTS} 个字符（emoji 按 1 个算）。`
  }
  return null
}

export interface ReviewAppendTargetPayload {
  mode: 'append_source'
}
export interface ReviewNewJournalTargetPayload {
  mode: 'new_journal'
  title: string | null
  journal_date: string
  folder_id: number | null
}
export type ReviewTargetPayload = ReviewAppendTargetPayload | ReviewNewJournalTargetPayload

/** 目标草稿 → 后端 target 形状；空标题提交 `null`（后端补默认标题）。 */
export function buildTargetPayload(draft: ReviewTargetDraft): ReviewTargetPayload {
  if (draft.mode === 'append_source') return { mode: 'append_source' }
  return {
    mode: 'new_journal',
    title: draft.title === '' ? null : draft.title,
    journal_date: draft.journal_date,
    folder_id: draft.folder_id,
  }
}

/* --------------------------------------------------------- 请求 payload */

export interface ReviewRequestSource {
  type: ReviewSourceType
  id: number
  expected_revision: number
}

export interface ReviewRequestPayload {
  request_id: string
  sources: ReviewRequestSource[]
}

/**
 * 冻结一次 `POST /api/ai/reviews` 的 payload。
 *
 * 源按 `(type,id)` 确定性排序：**响应丢失后的同键重放必须逐字相同**，
 * 否则后端会按「同键不同 payload」返回 409（`docs/stage3-api.md` §5）。
 * 只发送 `request_id` + typed sources（含 `expected_revision`），
 * **不自报日期、不自报全文、不伪造 AI 块**。
 */
export function buildReviewRequest(
  requestId: string,
  sources: { source: ReviewSource; revision: number }[],
): ReviewRequestPayload {
  const ordered = [...sources].sort((a, b) => compareSources(a.source, b.source))
  return {
    request_id: requestId,
    sources: ordered.map((item) => ({
      type: item.source.type,
      id: item.source.id,
      expected_revision: item.revision,
    })),
  }
}

/* ------------------------------------------------- review 对象解析 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function parseEvidence(raw: unknown): AIReviewEvidence | null {
  if (!isRecord(raw)) return null
  const source = raw.source
  if (!isRecord(source)) return null
  if (source.type !== 'journal' && source.type !== 'inbox') return null
  if (!isPositiveInt(source.id)) return null
  if (!isNonEmptyString(raw.quote)) return null
  return { source: { type: source.type, id: source.id }, quote: raw.quote }
}

/** evidence 数组必须存在且至少一项（镜像后端 `min_length=1`）。 */
function parseEvidenceList(raw: unknown): AIReviewEvidence[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const parsed: AIReviewEvidence[] = []
  for (const item of raw) {
    const evidence = parseEvidence(item)
    if (evidence === null) return null
    parsed.push(evidence)
  }
  return parsed
}

function parsePoint(raw: unknown, requireUncertainty: boolean): AIReviewPoint | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.text)) return null
  const evidence = parseEvidenceList(raw.evidence)
  if (evidence === null) return null
  const point: AIReviewPoint = { text: raw.text, evidence }
  if (requireUncertainty) {
    if (!isNonEmptyString(raw.uncertainty)) return null
    point.uncertainty = raw.uncertainty
  } else if (typeof raw.uncertainty === 'string') {
    point.uncertainty = raw.uncertainty
  }
  return point
}

function parsePointList(raw: unknown, requireUncertainty: boolean): AIReviewPoint[] | null {
  // 顶层列表允许为空（后端只有 max_length）；但每一项都必须合法。
  if (!Array.isArray(raw)) return null
  const parsed: AIReviewPoint[] = []
  for (const item of raw) {
    const point = parsePoint(item, requireUncertainty)
    if (point === null) return null
    parsed.push(point)
  }
  return parsed
}

function parseAngle(raw: unknown): AIReviewAngle | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.title)) return null
  if (!isNonEmptyString(raw.content)) return null
  return { title: raw.title, content: raw.content }
}

function parseStringList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const parsed: string[] = []
  for (const item of raw) {
    if (!isNonEmptyString(item)) return null
    parsed.push(item)
  }
  return parsed
}

function parseInsightDraft(raw: unknown): AIInsightDraft | null {
  if (!isRecord(raw)) return null
  if (!isNonEmptyString(raw.draft_id)) return null
  if (!isNonEmptyString(raw.title)) return null
  if (!isNonEmptyString(raw.viewpoint)) return null
  if (!isNonEmptyString(raw.content)) return null
  const evidence = parseEvidenceList(raw.evidence)
  if (evidence === null) return null
  return {
    draft_id: raw.draft_id,
    title: raw.title,
    viewpoint: raw.viewpoint,
    evidence,
    content: raw.content,
  }
}

function parseDraftList(raw: unknown): AIInsightDraft[] | null {
  // 允许为空数组：无适合观点时后端返回零份草稿（`docs/stage3.md` §6）。
  if (!Array.isArray(raw)) return null
  const parsed: AIInsightDraft[] = []
  for (const item of raw) {
    const draft = parseInsightDraft(item)
    if (draft === null) return null
    parsed.push(draft)
  }
  return parsed
}

/**
 * 严格解析后端 `review` 对象。
 *
 * 任何必需字段缺失/类型不符都返回 `null`（fail closed），调用方据此提示「结果无法
 * 解析」，**不**展示半截预览、也不把解析失败当成保存成功。
 */
export function parseReviewObject(raw: unknown): AIReviewObject | null {
  if (!isRecord(raw)) return null
  const facts = parsePointList(raw.facts, false)
  const emotion = parsePointList(raw.emotion_hypotheses, true)
  const explanations = parsePointList(raw.possible_explanations, true)
  if (facts === null || emotion === null || explanations === null) return null
  if (!Array.isArray(raw.angles)) return null
  const angles: AIReviewAngle[] = []
  for (const item of raw.angles) {
    const angle = parseAngle(item)
    if (angle === null) return null
    angles.push(angle)
  }
  const logic = parseStringList(raw.logic_chain)
  const questions = parseStringList(raw.follow_up_questions)
  if (logic === null || questions === null) return null
  const drafts = parseDraftList(raw.insight_drafts)
  if (drafts === null) return null
  if (!isNonEmptyString(raw.markdown)) return null
  return {
    facts,
    emotion_hypotheses: emotion,
    possible_explanations: explanations,
    angles,
    logic_chain: logic,
    follow_up_questions: questions,
    insight_drafts: drafts,
    markdown: raw.markdown,
  }
}

/* --------------------------------------------------------- 阶段与恢复 */

export type ReviewPhase =
  | 'idle'
  | 'generating'
  | 'polling'
  | 'ready'
  | 'saving'
  | 'applied'
  | 'failed'
  | 'conflict'
  | 'unknown'

/** 后端 status → 前端阶段；未知取值一律按 unknown，绝不当作成功。 */
export function reviewPhaseForStatus(status: string | null | undefined): ReviewPhase {
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

export function reviewPhaseLabel(phase: ReviewPhase): string {
  switch (phase) {
    case 'idle': return '未开始'
    case 'generating': return '正在生成'
    case 'polling': return '等待结果'
    case 'ready': return '待确认'
    case 'saving': return '正在保存'
    case 'applied': return '已保存'
    case 'failed': return '生成失败'
    case 'conflict': return '源已变化'
    case 'unknown': return '状态未知'
    default: return ''
  }
}

/** 在途阶段：这些阶段禁止第二次点击（双击只产生一个请求）。 */
const REVIEW_IN_FLIGHT: readonly ReviewPhase[] = ['generating', 'polling', 'saving']

export function reviewInFlight(phase: ReviewPhase): boolean {
  return REVIEW_IN_FLIGHT.includes(phase)
}

/** 是否允许开始一次新的生成（双击 / 连点只产生一个付费请求）。 */
export function reviewCanGenerate(phase: ReviewPhase): boolean {
  return !reviewInFlight(phase)
}

/**
 * 关页重开后对一条 review 恢复入口的处理计划（`docs/stage3-api.md` §4）：
 * - 404（`missing`）→ 移除失效入口，**不**重新 POST；
 * - pending → 继续有限轮询；
 * - 其他（ready/applied/failed/conflict/unknown）→ 直接展示已持久化结果。
 */
export function reviewRecoveryAction(
  status: string | null | undefined | 'missing',
): 'drop' | 'poll' | 'show' {
  if (status === 'missing') return 'drop'
  if (status === 'pending') return 'poll'
  return 'show'
}

/** 从共享恢复索引里挑出 review 入口（T07 的索引本身只存 request_id/kind/源身份）。 */
export function reviewRecoveryEntries(entries: AiRecoveryEntry[]): AiRecoveryEntry[] {
  return entries.filter((entry) => entry.kind === 'review')
}
