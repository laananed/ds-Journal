/**
 * Ritual 页面的纯逻辑（Stage 4 / S04-T10）。
 *
 * 权威依据：`docs/stage4.md` §5～§7、`docs/stage4-api.md` §4～§6、
 * `docs/stage4-architecture.md` §5～§6、`docs/stage4-tasks.md` §3.11。
 *
 * 本文件**不依赖 React、不发请求、不读浏览器存储**，因此可以直接跑：
 *
 *   node --experimental-strip-types src/utils/ritualView.test.ts
 *
 * 这里只做三件可以离线验证的事：
 *
 * 1. 业务日与草稿捕获时刻：上海 04:00 换日，捕获后跨日不重算（产品 §5）；
 * 2. 正文文档的读法：把 `content_doc` 拆成可展示的问题/目标/回顾视图，
 *    以及手动复制需要的「可复制块」清单（API §5、§2.1）；
 * 3. 请求载荷的唯一构造入口：复制与完整替换（API §5）只由 ID/版本/选择组成，
 *    绝不携带前端自造的 AI 正文或来源。
 */

import type { ContentDocument } from '../types/document.ts'
import type { Journal } from '../types/journal.ts'
import type {
  BusinessDay,
  RitualCopyRequest,
  RitualKind,
  RitualQuestion,
  RitualRestoreRequest,
  RitualSelection,
} from '../types/ritual.ts'

/* ------------------------------------------------------------------ 常量 */

/** 当前模板的问题上限（产品 §5：0～4 问，只作用于当前模板）。 */
export const TEMPLATE_CAPACITY = 4

/** 单个问题正文上限，与 `backend/app/ritual/schemas.py` 的 500 一致。 */
export const QUESTION_TEXT_LIMIT = 500

/** 管理端展示名：界面只用中文，不显示 set/end 缩写（产品 §2）。 */
export const KIND_LABEL: Record<RitualKind, string> = {
  set: '开始今天',
  end: '结束今天',
}

/** 支持「块内文字范围」选择的块类型；其余块只能整块选择（API §5）。 */
const RANGE_TYPES = new Set(['paragraph', 'heading'])

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_START_MS = 4 * 60 * 60 * 1000

/* ------------------------------------------------------------- 基础工具 */

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 稳定节点 ID：优先 crypto.randomUUID，缺失时退化为时间戳 + 计数。 */
let idCounter = 0
export function newNodeId(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto !== undefined && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  idCounter += 1
  return `00000000-0000-4000-8000-${String(Date.now()).slice(-9)}${String(idCounter).padStart(3, '0')}`
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/* --------------------------------------------------------- 业务日与捕获 */

/**
 * 上海时区业务日：本地时间 04:00 换日。
 *
 * 计算方式是把时刻平移 `+08:00 - 04:00` 后取 UTC 日期。Asia/Shanghai 自 1991
 * 年起没有夏令时，固定偏移对当前与历史日期都成立；不使用电脑本机时区
 * （产品 §5：不能用 UTC 日期或电脑当前时区替代）。
 */
export function shanghaiBusinessDate(instant: string | Date): string {
  const millis = instant instanceof Date ? instant.getTime() : Date.parse(instant)
  if (!Number.isFinite(millis)) throw new Error('无效的时刻')
  return new Date(millis + SHANGHAI_OFFSET_MS - DAY_START_MS).toISOString().slice(0, 10)
}

export interface RitualCapture {
  /** 草稿创建时捕获的业务日期；首次落库后不可修改。 */
  journalDate: string
  /** 打开草稿时的带时区时刻，随首次创建 payload 冻结（API §3）。 */
  draftStartedAt: string
}

/**
 * 服务端业务日 → 捕获值。
 *
 * 日期与服务端时钟都取服务端返回值：客户端时钟可能偏，且换算口径只能有一份
 * （`GET /api/business-day` 是只读时钟依据，API §3）。
 */
export function captureDraft(day: BusinessDay): RitualCapture {
  const draftStartedAt = day.server_time === '' ? new Date().toISOString() : day.server_time
  return { journalDate: day.business_date, draftStartedAt }
}

/**
 * 再次读到 business-day 时保持已捕获的日期（页面已打开、跨过 04:00 也不换日）。
 * 只有还没有捕获值时才新建一份。
 */
export function applyBusinessDay(captured: RitualCapture | null, day: BusinessDay): RitualCapture {
  return captured ?? captureDraft(day)
}

/* --------------------------------------------------------- 标题与提示 */

/** 空标题的兜底文案；不借标题推断 Ritual 类型（产品 §5）。 */
export function displayTitle(kind: RitualKind, journalDate: string, title: string | null | undefined): string {
  const trimmed = textOf(title).trim()
  return trimmed === '' ? `${KIND_LABEL[kind]} ${journalDate}` : trimmed
}

/* --------------------------------------------------------------- 模板 */

/** 模板文本校验：trim 后非空且不超过 500 码点（API §4）。 */
export function questionTextError(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed === '') return '问题不能为空。'
  if (Array.from(trimmed).length > QUESTION_TEXT_LIMIT) return `问题最多 ${QUESTION_TEXT_LIMIT} 个字。`
  return null
}

export type TemplateEdit =
  | { ok: true; questions: RitualQuestion[] }
  | { ok: false; message: string }

/** 顺序敏感的模板相等判定：顺序是模板的一部分，不能当成集合比较。 */
export function templatesEqual(left: readonly RitualQuestion[], right: readonly RitualQuestion[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => item.id === right[index].id && item.text === right[index].text)
}

/** 新增问题：上限作用于当前模板，不回溯历史正文（产品 §5）。 */
export function addTemplateQuestion(
  questions: readonly RitualQuestion[],
  text: string,
  id: string,
): TemplateEdit {
  const error = questionTextError(text)
  if (error !== null) return { ok: false, message: error }
  if (questions.length >= TEMPLATE_CAPACITY) {
    return { ok: false, message: `当前模板最多 ${TEMPLATE_CAPACITY} 个问题。` }
  }
  if (questions.some((item) => item.id === id)) return { ok: false, message: '问题标识重复，请重试。' }
  return { ok: true, questions: [...questions, { id, text: text.trim() }] }
}

/** 修改问题文字：只改当前模板，已插入正文的快照不受影响（产品 §5）。 */
export function updateTemplateQuestion(
  questions: readonly RitualQuestion[],
  index: number,
  text: string,
): TemplateEdit {
  if (index < 0 || index >= questions.length) return { ok: false, message: '要修改的问题不存在。' }
  const error = questionTextError(text)
  if (error !== null) return { ok: false, message: error }
  const next = questions.map((item, position) => (position === index ? { ...item, text: text.trim() } : item))
  return { ok: true, questions: next }
}

/** 删除问题：只减少模板项，正文里已有的问题快照保持原样。 */
export function removeTemplateQuestion(questions: readonly RitualQuestion[], index: number): RitualQuestion[] {
  return questions.filter((_, position) => position !== index)
}

/* ----------------------------------------------------------- 正文读取 */

function nodesOf(document: ContentDocument | null | undefined): JsonObject[] {
  if (document === null || document === undefined) return []
  const content = (document as unknown as JsonObject).content
  return Array.isArray(content) ? content.filter(isObject) : []
}

function typeOf(node: JsonObject): string {
  return textOf(node.type)
}

function attrsOf(node: JsonObject): JsonObject {
  return isObject(node.attrs) ? node.attrs : {}
}

function childrenOf(node: JsonObject): JsonObject[] {
  const content = node.content
  return Array.isArray(content) ? content.filter(isObject) : []
}

/** 收集用户可见文字；AI/模板/系统节点按 API §2.1 的 U 规则排除。 */
function collectUserText(node: JsonObject, out: string[]): void {
  const type = typeOf(node)
  if (type === 'text') {
    out.push(textOf(node.text))
    return
  }
  if (type === 'ritualQuestion' || type === 'aiReply' || type === 'aiSummary' || type === 'aiPlaceholder') return
  if (type === 'legacyText') {
    if (attrsOf(node).author === 'user') out.push(textOf(attrsOf(node).raw_text))
    return
  }
  if (type === 'goalItem') {
    out.push(textOf(attrsOf(node).text))
    return
  }
  for (const child of childrenOf(node)) collectUserText(child, out)
}

/** 全部用户文字（换行连接）。用于「是否有可保存的业务内容」与预览。 */
export function userText(document: ContentDocument | null | undefined): string {
  const parts: string[] = []
  for (const node of nodesOf(document)) collectUserText(node, parts)
  return parts.join('\n')
}

/**
 * 是否值得首次落库。
 *
 * 产品 §4/§5：只打开页面、查询缺失 Ritual 或插入空问题都不创建空文件；
 * 只有真实用户正文/目标/回顾才形成文件。因此空文档一律返回 false。
 */
export function hasSavableBody(document: ContentDocument | null | undefined): boolean {
  if (userText(document).trim() !== '') return true
  return nodesOf(document).some((node) => typeOf(node) === 'goalReview' || typeOf(node) === 'goalItem')
}

/** 单行预览：折叠空白并截断，不把正文写进日志或提示。 */
export function previewText(value: string, limit = 48): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  const characters = Array.from(collapsed)
  if (characters.length <= limit) return collapsed
  return `${characters.slice(0, limit).join('')}…`
}

/* ------------------------------------------------------- 问题插入 */

export interface InsertedQuestion {
  document: ContentDocument
  questionId: string
  answerId: string
}

export type InsertQuestionResult =
  | { ok: true; value: InsertedQuestion }
  | { ok: false; message: string }

/**
 * 把一个模板问题插入正文末尾。
 *
 * 插入的是**当时文字的快照**：`template_question_id` 只记录来源，之后改模板
 * 不回写正文；同时补一个空段落作为答案位置（用户答案是独立正文）。
 * 新文档是新对象，绝不修改传入的 `content_doc`。
 *
 * 说明（2026-10-31）：真正的写入走服务端受控命令
 * `POST /api/rituals/{id}/questions`（API §4），节点 ID 与快照都由后端生成；
 * 本函数只作为「插入后文档长什么样」的纯形状参考与回归断言使用，
 * 页面不得用它本地拼节点后保存（受保护节点会被 422 拒绝）。
 */
export function insertQuestion(
  document: ContentDocument | null | undefined,
  question: RitualQuestion,
  createId: () => string = newNodeId,
): InsertQuestionResult {
  const error = questionTextError(question.text)
  if (error !== null) return { ok: false, message: error }
  const candidate = document as unknown as JsonObject | null | undefined
  if (!isObject(candidate) || textOf(candidate.type) !== 'doc') {
    return { ok: false, message: '正文还没有加载完成，暂时不能插入问题。' }
  }
  const base = clone(candidate)
  const content = Array.isArray(base.content) ? base.content.filter(isObject) : []
  const questionId = createId()
  const answerId = createId()
  content.push({
    type: 'ritualQuestion',
    attrs: {
      id: questionId,
      template_question_id: question.id,
      question_snapshot: question.text.trim(),
    },
  })
  content.push({ type: 'paragraph', attrs: { id: answerId }, content: [] })
  base.content = content
  return { ok: true, value: { document: base as unknown as ContentDocument, questionId, answerId } }
}

/* --------------------------------------------------- 可复制块与插入位置 */

export interface CopyCandidate {
  nodeId: string
  type: string
  label: string
  preview: string
  /** 是否支持块内文字范围（仅 paragraph/heading，API §5）。 */
  rangeSelectable: boolean
  /** 服务端会拒绝整块复制的原因；null 表示可复制。 */
  blockedReason: string | null
}

const TYPE_LABEL: Record<string, string> = {
  paragraph: '段落',
  heading: '标题',
  bulletList: '无序列表',
  orderedList: '有序列表',
  taskList: '清单',
  blockquote: '引用',
  codeBlock: '代码块',
  horizontalRule: '分隔线',
  ritualQuestion: '问题模板',
  goalItem: '目标',
  goalReview: '目标回顾',
  aiReply: 'AI 回复',
  aiSummary: 'AI 总结',
  aiPlaceholder: 'AI 占位',
  legacyText: '旧格式原文',
}

/** 块内是否带评论 Mark：跨文件评论归属不可复制（API §5）。 */
function hasCommentMarks(node: JsonObject): boolean {
  const marks = Array.isArray(node.marks) ? node.marks : []
  if (marks.some((mark) => isObject(mark) && textOf(mark.type) === 'mindComment')) return true
  return childrenOf(node).some(hasCommentMarks)
}

/**
 * 顶层可复制块清单（左栏旧版本的选择列表）。
 *
 * `blockedReason` 与后端 `copy_content` 的拒绝条件对齐：
 * AI 占位在途不可复制、带评论 Mark 的块无法跨文件保留评论归属。
 */
export function copyCandidates(document: ContentDocument | null | undefined): CopyCandidate[] {
  return nodesOf(document).flatMap((node) => {
    const nodeId = textOf(attrsOf(node).id)
    if (nodeId === '') return []
    const type = typeOf(node)
    let blockedReason: string | null = null
    if (type === 'aiPlaceholder') blockedReason = 'AI 正在处理的占位块不能复制。'
    else if (hasCommentMarks(node)) blockedReason = '带评论标记的内容不能跨文件复制。'
    return [{
      nodeId,
      type,
      label: TYPE_LABEL[type] ?? type,
      preview: previewText(userTextOfNode(node)),
      rangeSelectable: RANGE_TYPES.has(type) && blockedReason === null,
      blockedReason,
    }]
  })
}

function userTextOfNode(node: JsonObject): string {
  const parts: string[] = []
  collectUserText(node, parts)
  return parts.join('\n')
}

export interface InsertPosition {
  nodeId: string
  label: string
  preview: string
}

/** `insert_after_node_id` 的候选：必须是目标文档里带 ID 的顶层块（API §5）。 */
export function insertPositions(document: ContentDocument | null | undefined): InsertPosition[] {
  return nodesOf(document).flatMap((node) => {
    const nodeId = textOf(attrsOf(node).id)
    if (nodeId === '') return []
    const type = typeOf(node)
    return [{ nodeId, label: TYPE_LABEL[type] ?? type, preview: previewText(userTextOfNode(node)) }]
  })
}

/* ------------------------------------------------------------- 关联版本 */

export interface RelatedRevision {
  type: 'journal'
  id: number
  revision: number
}

/**
 * 受影响关联文件的版本集合。
 *
 * 只保留 `related_revisions` 里真实存在、且不属于 source/target 的项：
 * 后端要求「完整且不过期」的集合，多提交一个无关文件同样会被拒绝。
 */
export function relatedRevisionsFor(
  detail: (RitualFileRef & { related_revisions?: readonly RelatedRevision[] }) | null | undefined,
  excludeIds: readonly number[] = [],
): RelatedRevision[] {
  const list = detail?.related_revisions
  if (!Array.isArray(list)) return []
  const excluded = new Set(excludeIds)
  return list
    .filter((item) => item.type === 'journal' && !excluded.has(item.id))
    .map((item) => ({ type: 'journal' as const, id: item.id, revision: item.revision }))
}

/* --------------------------------------------------------- 请求载荷 */

export type PayloadResult<T> = { ok: true; payload: T } | { ok: false; message: string }

/**
 * 命令只需要「身份 + 版本 + 正文」三样。
 *
 * 页面手里的当前文件可能来自会话（刚创建、有未保存输入），这时不会有完整
 * 的 `Journal` 详情；用这个窄类型既能构造载荷，也避免为了填字段去伪造详情。
 */
export interface RitualFileRef {
  id: number
  revision: number
  content_doc?: ContentDocument | null
  title?: string | null
}

function sourceNodes(document: ContentDocument | null | undefined): Map<string, JsonObject> {
  const found = new Map<string, JsonObject>()
  const walk = (node: JsonObject): void => {
    const nodeId = textOf(attrsOf(node).id)
    if (nodeId !== '') found.set(nodeId, node)
    childrenOf(node).forEach(walk)
  }
  nodesOf(document).forEach(walk)
  return found
}

export interface CopyRequestInput {
  source: RitualFileRef
  target: RitualFileRef
  copyId: string
  selection: readonly RitualSelection[]
  insertAfterNodeId: string
  relatedRevisions?: readonly RelatedRevision[]
}

/**
 * 构造 `POST /api/rituals/{source_id}/copy-content` 的请求体。
 *
 * 只提交「ID + 码点范围 + 版本」：真实内容由服务端按 source revision 读取，
 * 前端提交的「旧 AI 内容」不会被采信（API §5）。复制结果的新 ID 也由服务端
 * 从 `copy_id` 派生，这里只保证请求本身合法。
 */
export function buildCopyPayload(input: CopyRequestInput): PayloadResult<RitualCopyRequest> {
  const { source, target, selection, insertAfterNodeId, copyId } = input
  if (selection.length === 0) return { ok: false, message: '请先选择要复制的内容。' }
  if (typeof source.revision !== 'number' || source.revision <= 0) {
    return { ok: false, message: '旧版本缺少修订号，请重新读取回收箱内容。' }
  }
  if (typeof target.revision !== 'number' || target.revision <= 0) {
    return { ok: false, message: '当前文件缺少修订号，请先保存再复制。' }
  }
  if (copyId.trim() === '') return { ok: false, message: '缺少复制标识，请重试。' }
  if (insertAfterNodeId.trim() === '') return { ok: false, message: '请选择插入位置。' }

  const sourceIndex = sourceNodes(source.content_doc)
  const seen = new Set<string>()
  const cleaned: RitualSelection[] = []
  for (const item of selection) {
    const nodeId = item.node_id.trim()
    if (nodeId === '') return { ok: false, message: '选择项缺少节点标识。' }
    if (seen.has(nodeId)) return { ok: false, message: '同一个块只能选择一次。' }
    seen.add(nodeId)
    const node = sourceIndex.get(nodeId)
    if (node === undefined) return { ok: false, message: '所选内容已不在旧版本中，请重新选择。' }
    const hasFrom = typeof item.from === 'number'
    const hasTo = typeof item.to === 'number'
    if (hasFrom !== hasTo) return { ok: false, message: '选区范围不完整。' }
    if (hasFrom && hasTo) {
      if (!RANGE_TYPES.has(typeOf(node))) return { ok: false, message: '该类块只能整块复制。' }
      if (item.from! < 0 || item.to! <= item.from!) return { ok: false, message: '选区范围不合法。' }
      cleaned.push({ node_id: nodeId, from: item.from, to: item.to })
    } else {
      cleaned.push({ node_id: nodeId })
    }
  }

  const positions = insertPositions(target.content_doc)
  if (!positions.some((position) => position.nodeId === insertAfterNodeId)) {
    return { ok: false, message: '插入位置不在当前文件中，请重新选择。' }
  }

  const excluded = new Set([source.id, target.id])
  return {
    ok: true,
    payload: {
      source_revision: source.revision,
      target_id: target.id,
      expected_target_revision: target.revision,
      copy_id: copyId,
      selection: cleaned,
      insert_after_node_id: insertAfterNodeId,
      related_revisions: (input.relatedRevisions ?? []).filter((item) => !excluded.has(item.id)),
    },
  }
}

/**
 * 构造 `POST /api/rituals/{source_id}/restore-replace` 的请求体。
 *
 * `expected_target_revision` 必须是**当前有效文件**的版本；If-Match 用来源
 * （回收箱文件）的版本，两者任何一个变化都要 409，不能靠重试覆盖。
 */
export function buildRestorePayload(
  source: RitualFileRef,
  target: RitualFileRef,
  relatedRevisions: readonly RelatedRevision[],
): PayloadResult<RitualRestoreRequest> {
  if (source.id === target.id) return { ok: false, message: '来源与目标是同一个文件。' }
  if (typeof target.revision !== 'number' || target.revision <= 0) {
    return { ok: false, message: '当前文件缺少修订号，请先保存再替换。' }
  }
  if (typeof source.revision !== 'number' || source.revision <= 0) {
    return { ok: false, message: '旧版本缺少修订号，请重新读取回收箱内容。' }
  }
  const excluded = new Set([source.id, target.id])
  return {
    ok: true,
    payload: {
      target_id: target.id,
      expected_target_revision: target.revision,
      related_revisions: relatedRevisions.filter((item) => !excluded.has(item.id)),
    },
  }
}

/* ------------------------------------------------------------- 目标视图 */

export interface GoalView {
  nodeId: string
  goalId: string
  text: string
  checked: boolean
}

/** 开始今天里的目标（canonical 在 Set 正文，架构 §6）。 */
export function goalsOf(document: ContentDocument | null | undefined): GoalView[] {
  return nodesOf(document).flatMap((node) => {
    if (typeOf(node) !== 'goalItem') return []
    const attrs = attrsOf(node)
    const goalId = textOf(attrs.goal_id)
    const nodeId = textOf(attrs.id)
    if (goalId === '' || nodeId === '') return []
    return [{
      nodeId,
      goalId,
      text: textOf(attrs.text),
      checked: attrs.checked === true,
    }]
  })
}

export interface GoalLink {
  link_id: string
  set_id: number | null
  end_id: number
  goal_id: string
  end_node_id: string
}

export interface ReviewView {
  nodeId: string
  /** 有效关联：`link_id` 非 null；解除关联后为 null（来源不可用）。 */
  linkId: string | null
  title: string
  snapshot: string
  checked: boolean
  answer: string
  sourceAvailable: boolean
  goalId: string | null
  setId: number | null
}

/** 结束今天里的目标回顾；回答只是展示，编辑入口在正文编辑器里。 */
export function reviewsOf(
  document: ContentDocument | null | undefined,
  links: readonly GoalLink[] = [],
): ReviewView[] {
  return nodesOf(document).flatMap((node) => {
    if (typeOf(node) !== 'goalReview') return []
    const attrs = attrsOf(node)
    const nodeId = textOf(attrs.id)
    if (nodeId === '') return []
    const linkId = textOf(attrs.link_id) === '' ? null : textOf(attrs.link_id)
    const link = linkId === null ? undefined : links.find((item) => item.link_id === linkId)
    return [{
      nodeId,
      linkId,
      title: textOf(attrs.review_title),
      snapshot: textOf(attrs.goal_snapshot),
      checked: attrs.checked_snapshot === true,
      answer: userTextOfNode(node),
      sourceAvailable: linkId !== null,
      goalId: link?.goal_id ?? null,
      setId: link?.set_id ?? null,
    }]
  })
}

/** 关联身份是否齐全，决定「从结束今天改目标」是否可提交。 */
export function reviewCanWriteBack(review: ReviewView): boolean {
  return review.linkId !== null && review.goalId !== null && review.setId !== null
}

export type AddGoalAvailability = { available: true; entry: Journal } | { available: false; reason: string }

/**
 * 把目标加入结束今天是否可用。
 *
 * 2026-10-30 用户决定：04:00 前捕获的加入草稿允许换日后按原业务日提交，但接口
 * 没有服务端捕获凭证；在契约解决前，**不存在 End 的新建路径保持拒绝**
 * （`create_links` 直接 422，不创建空壳）。所以这里如实禁用并说明限制。
 */
export function canAddGoalToEnd(end: Journal | null | undefined): AddGoalAvailability {
  if (end === null || end === undefined) {
    return {
      available: false,
      reason: '结束今天还没有有效文件。服务端尚未开放「关联时新建结束今天」路径（fail-closed 422），'
        + '需要先在结束今天写入并保存真实内容，才能把目标加入。',
    }
  }
  return { available: true, entry: end }
}

/* --------------------------------------------------- 回收箱中的旧版本 */

/**
 * 回收箱里同日同类的旧 Ritual。
 *
 * 回收箱列表是全局分页（20 条/页），页面按需翻页后本地筛选；这里只负责筛选，
 * 不猜分页边界。
 */
export function deletedRitualsOf(items: readonly Journal[], kind: RitualKind, journalDate: string): Journal[] {
  return items.filter((item) => item.journal_kind === kind && item.journal_date === journalDate)
}

/* ------------------------------------------------- 本地草稿与页面归属 */

/** 本地草稿记录里与本页筛选有关的字段（不含正文）。 */
export interface RitualRecordRef {
  journal_kind: string
  business_date: string
  file_id: number | null
}

/**
 * 一份本地草稿是否属于这一页。
 *
 * 规则只有两条，且都不改日期：
 * - 同 `journal_kind` 且业务日与本页业务日相同（今天/该历史日的草稿）；
 * - 或者就是当前这份服务器文件（历史文件编辑时，记录的业务日可能取自文件）。
 *
 * 其他日期的草稿刻意不列：在这页恢复它们就等于把内容搬到另一个业务日，
 * 那是一次隐式的日期改写，必须由用户自己打开那一天再决定。
 */
export function ritualRecordMatches(
  record: RitualRecordRef,
  page: { kind: RitualKind; journalDate: string; fileId: number | null },
): boolean {
  if (record.journal_kind !== page.kind) return false
  if (page.fileId !== null && record.file_id === page.fileId) return true
  return page.journalDate !== '' && record.business_date === page.journalDate
}


/* --------------------------------------------------------- 保存判定 */

/** 首次落库前的可提交判定：必须有真实业务内容（产品 §4/§5）。 */
export function isRitualDraftSavable(draft: { title: string; content_doc: unknown }): boolean {
  if (draft.title.trim() !== '') return true
  return hasSavableBody(draft.content_doc as ContentDocument | null)
}

/** 编辑器只提交正文与标题；类型与业务日期不进 PATCH（API §3）。 */
export function ritualDraftOf(input: {
  title: string
  contentDoc: ContentDocument
  journalDate: string
  folderId: number | null
}): { title: string; content_doc: ContentDocument; date: string; folder_id: number | null } {
  return {
    title: input.title,
    content_doc: input.contentDoc,
    date: input.journalDate,
    folder_id: input.folderId,
  }
}

/** 展示用的「当前模板」：始终最多四问，超出不静默截断而是提示。 */
export function visibleQuestions(questions: readonly RitualQuestion[]): {
  questions: RitualQuestion[]
  overflow: number
} {
  return {
    questions: questions.slice(0, TEMPLATE_CAPACITY),
    overflow: Math.max(0, questions.length - TEMPLATE_CAPACITY),
  }
}
