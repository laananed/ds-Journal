/**
 * Writing 页面与会话的纯逻辑（Stage 4 / S04-T06）。
 *
 * 权威依据：`docs/stage4.md` §4（Writing 与今日总览）、§5（业务日期）、§10（保存与恢复）、
 * `docs/stage4-api.md` §3（Journals 与今日读取）、§10（本地草稿恢复契约）、
 * `docs/stage4-architecture.md` §4 / §4.1、`docs/stage4-tasks.md` §3.7。
 *
 * 本文件**不实现第二套保存队列或第二套本地草稿存储**：
 * - 保存队列、创建键重放、CAS 全部来自 `state/editSessions.ts`（T02）；
 * - 本地草稿记录、校验、写入器、`decideDraftRecovery` 全部来自
 *   `state/localJournalDrafts.ts`（T02）；
 * - 正文用户事实投影来自 `editor/documentProjection.ts`（T03）。
 *
 * 这里只放「页面怎么判断」的纯函数，因此可以用
 *
 *   node --experimental-strip-types src/utils/writingSession.test.ts
 *
 * 直接验证，不需要浏览器、网络或数据库。
 */

import { draftEquals, type DocumentDraft } from '../state/editSessions.ts'
import {
  decideDraftRecovery,
  type DraftCandidate,
  type LocalJournalDraft,
  type ServerDraftProbe,
} from '../state/localJournalDrafts.ts'
import { userTextDocument } from '../editor/documentProjection.ts'
import type { Journal, JournalPage } from '../types/journal.ts'

/* --------------------------------------------------------------- 业务日期 */

/** 业务日时区与换日时刻的唯一显示口径（`docs/stage4-api.md` §3）。 */
export const WRITING_TIMEZONE = 'Asia/Shanghai'
export const WRITING_DAY_START_HOUR = 4

/** 普通写作正文上限（与后端 `journal_date` 校验同一口径：50,000 Unicode 码点）。 */
export const WRITING_MAX_CODE_POINTS = 50_000

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 只接受严格的 `YYYY-MM-DD`，并拒绝 2026-02-30 这类不存在的日期。 */
export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/**
 * 把业务日期格式化为「2026年10月30日 周五」。
 *
 * 业务日期已经是服务端按 Asia/Shanghai 04:00 算好的日历日期，
 * 这里**不做任何时区换算**，只取年月日拼字符串，再用本机 `Date` 取星期几
 * （星期几不参与日期计算，不会产生跨时区偏移）。
 */
export function formatBusinessDateLabel(value: string): string {
  if (!isBusinessDate(value)) return value
  const [year, month, day] = value.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(year, month - 1, day).getDay()]
  return `${year}年${month}月${day}日 ${weekday}`
}

/**
 * 新草稿使用的业务日期：**只信服务端** `GET /api/business-day`。
 *
 * 不拿本机时钟兜底：本机时区/时钟与固定 Asia/Shanghai 04:00 口径不一致时，
 * 兜底会静默写错日期。读取失败时返回空串，页面显示错误并停止创建。
 */
export function writingDateFromBusinessDay(businessDay: { business_date?: unknown } | null): string {
  if (businessDay === null) return ''
  const value = businessDay.business_date
  return isBusinessDate(value) ? value : ''
}

/* ----------------------------------------------------------------- 草稿 */

/** 空写作草稿：没有正文，`content_doc` 为 null 表示「还没有任何内容」。 */
export function newWritingDraft(date: string): DocumentDraft {
  return { title: '', content_doc: null, date, folder_id: null }
}

/** 一份文件会话的稳定草稿身份；同一篇文件重复打开会复用同一个会话。 */
export function writingDraftIdForFile(id: number): string {
  return `journal:${id}`
}

/** 会话 id 与草稿身份一一对应：切页返回时按同一 id 取回原会话。 */
export function writingSessionId(draftId: string): string {
  return `writing:draft:${draftId}`
}

/**
 * 可恢复的候选会话（应用内「返回同会话」的依据）。
 *
 * 只包含本标签、Journal 类型、且**仍值得恢复**的会话：
 * - 草稿身份还没落库（用户刚打开的新草稿）→ 恢复；
 * - 有未提交输入 → 恢复（跨日也不丢输入，产品 §5）；
 * - 已保存且日期就是当前业务日期 → 恢复（继续编辑今天这篇）。
 *
 * 已保存但属于别的业务日期的会话不自动顶到面前：那篇文件在日记列表里，
 * Writing 应当给今天一份新的空草稿。
 */
export interface ResumableSession {
  draftId: string
  tabId: string
  type: 'journal' | 'insight'
  fileId: number | null
  date: string
  hasUnsavedInput: boolean
  updatedAt: number
}

export function pickResumableDraftId(
  sessions: readonly ResumableSession[],
  tabId: string,
  businessDate: string,
): string | null {
  let best: ResumableSession | null = null
  for (const session of sessions) {
    if (session.type !== 'journal') continue
    if (session.tabId !== tabId) continue
    const worthResuming = session.fileId === null
      || session.hasUnsavedInput
      || (businessDate !== '' && session.date === businessDate)
    if (!worthResuming) continue
    if (best === null || session.updatedAt >= best.updatedAt) best = session
  }
  return best === null ? null : best.draftId
}

/** 明确「新建一篇」：总是产生新的草稿身份，绝不复用旧键。 */
export function newDraftId(generate: () => string): string {
  return generate()
}

/** 会话里是否有未提交输入（`draft !== baseline`）。 */
export function hasUnsavedInput(session: { draft: DocumentDraft; baseline: DocumentDraft }): boolean {
  return !draftEquals(session.draft, session.baseline)
}

/* ------------------------------------------------------------ 可保存判定 */

/** 取用户正文（排除 AI/系统块）；结构不认识时返回空串，绝不抛错。 */
export function userTextOf(contentDoc: unknown): string {
  if (typeof contentDoc !== 'object' || contentDoc === null) return ''
  const candidate = contentDoc as { type?: unknown; content?: unknown }
  if (candidate.type !== 'doc' || !Array.isArray(candidate.content)) return ''
  try {
    return userTextDocument(contentDoc)
  } catch {
    return ''
  }
}

/**
 * 空草稿不得创建服务器记录（产品 §4、Task 验收）。
 *
 * 只有**真实用户正文**存在且不超过上限才可提交：
 * 标题单独存在、空白/全空白正文、超长正文都不提交，草稿留在编辑器里。
 */
export function writingSavable(draft: DocumentDraft): boolean {
  const text = userTextOf(draft.content_doc)
  if (text.trim() === '') return false
  return Array.from(text).length <= WRITING_MAX_CODE_POINTS
}

/** 正文超长（用于给出提示，而不是静默不保存）。 */
export function writingTooLong(draft: DocumentDraft): boolean {
  return Array.from(userTextOf(draft.content_doc)).length > WRITING_MAX_CODE_POINTS
}

/* -------------------------------------------------------------- 今日列表 */

/** 列表项：标题不截断（由 CSS 换行），只有预览会被裁剪。 */
export interface WritingListItem {
  id: number
  /** 服务端只读投影，不做前端重算编号。 */
  displayTitle: string
  preview: string
  revision: number
  journalDate: string
  updatedAt: string
}

export interface WritingList {
  items: WritingListItem[]
  page: number
  total: number
  hasNext: boolean
}

const PREVIEW_LIMIT = 88

/**
 * 预览裁剪：折叠空白后按 Unicode 码点截断。
 * 只用于预览，绝不用于标题或正文存储。
 */
export function writingPreview(content: string, limit: number = PREVIEW_LIMIT): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  const points = Array.from(flat)
  if (points.length <= limit) return flat
  return `${points.slice(0, limit).join('')}…`
}

/**
 * 当日侧栏只列**当前业务日期**的 `writing` 文件（产品 §4）。
 *
 * 服务端已按 `journal_date` + `journal_kind=writing` 过滤，这里再做一次防御性
 * 过滤：接口参数被误用、或返回里混入别的 kind 时，侧栏不会显示错的东西。
 */
export function writingListItems(page: JournalPage | null, businessDate: string): WritingList {
  if (page === null) return { items: [], page: 1, total: 0, hasNext: false }
  const items: WritingListItem[] = []
  for (const journal of page.items) {
    if (journal.type !== 'journal') continue
    const kind = journal.journal_kind ?? 'writing'
    if (kind !== 'writing') continue
    if (businessDate !== '' && journal.journal_date !== businessDate) continue
    items.push({
      id: journal.id,
      displayTitle: journal.display_title,
      preview: writingPreview(journal.content),
      revision: journal.revision,
      journalDate: journal.journal_date,
      updatedAt: journal.updated_at,
    })
  }
  return { items, page: page.page, total: page.total, hasNext: page.has_next }
}

/** 列表项上「本机有未提交草稿」的标记：按文件 id 对上本地记录。 */
export function idsWithLocalDrafts(candidates: readonly DraftCandidate[]): Set<number> {
  const ids = new Set<number>()
  for (const candidate of candidates) {
    if (candidate.file_id !== null) ids.add(candidate.file_id)
  }
  return ids
}

/* -------------------------------------------------------------- 今日总览 */

/**
 * 今日总览的数据形状。
 *
 * 与 T05 `pages/DashboardPage.tsx` 的 `DashboardToday` **结构一致**，
 * 但在这里独立声明：纯逻辑模块不能 import `.tsx`（那会连带 CSS import，
 * 让 `node --experimental-strip-types` 无法运行本测试）。
 */
export interface TodayWritingItem {
  id: number
  title: string
  preview: string
  revision: number
  updatedAt?: string | null
}

export type TodayRitualSlot =
  | { state: 'absent' }
  | { state: 'exists'; id: number; title: string; revision: number; preview?: string }

export interface TodayOverviewView {
  businessDate: string
  timezone: string
  dayStartHour: number
  writings: TodayWritingItem[]
  rituals: { set: TodayRitualSlot; end: TodayRitualSlot }
  /** 今日写作超过一页（20 条）时为 true：总览不声称自己列全了。 */
  writingsHasNext: boolean
}

/**
 * 组装今日总览（产品 §4、API §3）。
 *
 * 纯读：只把已取得的数据排成视图，不产生任何文件、草稿或“今日汇总”。
 * 业务日期非法（服务端读取失败）时返回 null，页面显示错误而不是猜一个日期。
 */
export function buildTodayOverview(input: {
  businessDay: { timezone?: unknown; day_start_hour?: unknown; business_date?: unknown } | null
  writings: JournalPage | null
  rituals: { set: Journal | null; end: Journal | null } | null
}): TodayOverviewView | null {
  const businessDate = writingDateFromBusinessDay(input.businessDay)
  if (businessDate === '') return null
  const list = writingListItems(input.writings, businessDate)
  const toSlot = (journal: Journal | null | undefined): TodayRitualSlot => {
    if (journal === null || journal === undefined) return { state: 'absent' }
    return {
      state: 'exists',
      id: journal.id,
      title: journal.display_title,
      revision: journal.revision,
      preview: writingPreview(journal.content),
    }
  }
  return {
    businessDate,
    timezone: typeof input.businessDay?.timezone === 'string' ? input.businessDay.timezone : WRITING_TIMEZONE,
    dayStartHour: typeof input.businessDay?.day_start_hour === 'number'
      ? input.businessDay.day_start_hour : WRITING_DAY_START_HOUR,
    writings: list.items.map((item) => ({
      id: item.id,
      title: item.displayTitle,
      preview: item.preview,
      revision: item.revision,
      updatedAt: item.updatedAt,
    })),
    rituals: {
      set: toSlot(input.rituals?.set ?? null),
      end: toSlot(input.rituals?.end ?? null),
    },
    writingsHasNext: list.hasNext,
  }
}

/* ------------------------------------------------------------ 旧格式判定 */

/**
 * 是否必须走旧格式路径（API §2「T01 过渡选择」）。
 *
 * 带 `content_blocks` 或没有 `content_doc` 的记录**不自动转换**：
 * 没有证据证明阅读投影、作者与检查点都能保留时，转换就是静默改内容。
 * 这类文件由既有旧编辑器继续打开，正文与服务端字段都不动。
 */
export function isLegacyRecord(journal: Journal): boolean {
  if (journal.content_doc === null || journal.content_doc === undefined) return true
  if (journal.document_format === 'legacy') return true
  const blocks = journal.content_blocks
  return blocks !== null && blocks !== undefined && blocks.length > 0
}

/* --------------------------------------------------------- 本地草稿恢复 */

/** 恢复候选的处置计划；每一种都必须由用户明确选择，不自动执行。 */
export type CandidatePlan =
  /** 同版本：可直接恢复编辑，之后按 CAS 保存。 */
  | { kind: 'editable' }
  /** 版本不同：保留双方，交给用户对照。 */
  | { kind: 'conflict'; localRevision: number | null; serverRevision: number }
  /** 服务器上已不存在（404 / 软删）：本地保留，不自动新建。 */
  | { kind: 'server_missing' }
  /** 读取失败（网络/权限）：本地保留，稍后再试。 */
  | { kind: 'server_unreadable'; message: string }
  /** 创建响应未确认：需要「同键同首次 payload」重放入口。 */
  | { kind: 'replay_pending' }
  /** 从未发出创建：可直接作为新草稿继续。 */
  | { kind: 'fresh' }

/**
 * 由 T02 的 `decideDraftRecovery` 得出处置计划。
 *
 * 唯一的额外判断是 `replay_pending`：记录里有首次创建请求但没有文件 id，
 * 说明 POST 已发出、响应未知。安全做法是**同键同首次 payload 重放**取回 id；
 * 能否重放由 `planReplay` 逐项校验（身份、payload 完整性、日期/类型、序号），
 * 执行见 `utils/pendingCreateReplay.ts`。页面不允许自己换键重发。
 */
export function planCandidate(record: LocalJournalDraft, probe: ServerDraftProbe | null): CandidatePlan {
  if (record.file_id === null) {
    return record.first_request === null ? { kind: 'fresh' } : { kind: 'replay_pending' }
  }
  const decision = decideDraftRecovery(record, probe ?? { state: 'unreadable', message: '尚未读取服务器版本' })
  switch (decision.kind) {
    case 'restore_editable':
      return { kind: 'editable' }
    case 'conflict':
      return { kind: 'conflict', localRevision: decision.local_revision, serverRevision: decision.server_revision }
    case 'server_missing':
      return { kind: 'server_missing' }
    case 'server_unreadable':
      return { kind: 'server_unreadable', message: decision.message }
    case 'replay_create':
      return { kind: 'replay_pending' }
    default:
      return { kind: 'fresh' }
  }
}

/** 候选来源标签：同一标签与「其他标签」要区分，避免误以为自己刚写的东西消失了。 */
export function candidateOriginLabel(candidate: DraftCandidate, currentTabId: string): string {
  const own = candidate.tab_id === currentTabId ? '本标签' : '其他标签'
  const kindLabel = candidate.journal_kind === 'writing' ? '写作' : candidate.journal_kind === 'set' ? '开始今天' : '结束今天'
  return `${own} · ${kindLabel}`
}

/** 候选副标题：业务日期 + 是否有服务器文件身份；不含正文。 */
export function candidateMeta(candidate: DraftCandidate): string {
  const target = candidate.file_id === null
    ? (candidate.has_first_request ? '创建未确认' : '未落库草稿')
    : `服务器文件 #${candidate.file_id}`
  const stamp = candidate.updated_at === '' ? '' : ` · ${formatLocalStamp(candidate.updated_at)}`
  return `${candidate.business_date} · ${target}${stamp}`
}

/** 本机时间戳的短显示；解析失败原样返回，不抛错。 */
export function formatLocalStamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 处置计划的用户可读说明；不含正文。 */
export function planLabel(plan: CandidatePlan): string {
  switch (plan.kind) {
    case 'editable': return '可以恢复编辑'
    case 'conflict': return '与服务器版本不同，需要你选择'
    case 'server_missing': return '服务器上已不存在'
    case 'server_unreadable': return '暂时读不到服务器版本'
    case 'replay_pending': return '创建结果未确认（可恢复原请求）'
    default: return '尚未提交到服务器'
  }
}

/** 恢复时用于左右对照的本地文本（用户正文，不含 AI/系统块）。 */
export function localDraftText(record: LocalJournalDraft): string {
  return userTextOf(record.content_doc)
}

/**
 * 这份会话的输入是否值得在本机留一份草稿记录。
 *
 * 只有**服务器还没确认**的输入（`inputSeq > ackedSeq`）才需要：已确认的草稿再写一次，
 * 会让「本地草稿」入口把已经保存成功的内容误报成未提交草稿，
 * 也会在再次打开这篇时弹出两块内容完全相同的「冲突」。
 */
export function needsLocalDraft(input: { inputSeq: number; ackedSeq: number }): boolean {
  return input.inputSeq > input.ackedSeq
}

/**
 * 本地记录是否与服务器版本内容完全一致（标题与用户正文都比较，空白宽松）。
 *
 * 「保存已确认、但本机记录没来得及清理」的残影会出现在这个状态：
 * 内容一致就没有任何需要保留的东西，可以直接按服务器版本继续编辑。
 * 只有两侧都不需要用户取舍时才返回 true——用于**避免误报冲突**，不用于合并。
 */
export function duplicateOfServer(
  record: Pick<LocalJournalDraft, 'title' | 'content_doc'>,
  server: { title: string | null; content: string },
): boolean {
  return sameText(record.title, server.title ?? '') && sameText(userTextOf(record.content_doc), server.content)
}

function sameText(left: string, right: string): boolean {
  return left.replace(/\s+/gu, ' ').trim() === right.replace(/\s+/gu, ' ').trim()
}

/** 冲突界面的两侧标题。 */
export function conflictHeadings(localRevision: number | null, serverRevision: number): { local: string; server: string } {
  return {
    local: localRevision === null ? '我的本地草稿' : `我的本地草稿（基于版本 ${localRevision}）`,
    server: `服务器当前版本（版本 ${serverRevision}）`,
  }
}

/* --------------------------------------------------- 重放恢复（replay_pending） */

/**
 * 「同创建键、同首次 payload」重放参数的形状。
 *
 * 与 T02 `EditSession['firstRequest']` 完全同构：等 T02 会话核心开放
 * 「用已存首次请求打开会话」的入口（`OpenSessionInput` 增加 `firstRequest`）后，
 * 页面把这里的结果原样传进去，`planWrite` 就会按原键原 payload 重放创建。
 */
export interface ReplayFirstRequest {
  client_create_id: string
  draft: DocumentDraft
  extras: Record<string, unknown> | null
  seq: number
}

/** 镜像层写进 `first_request.payload` 的四个草稿字段；其余都是 extras。 */
const FIRST_REQUEST_DRAFT_KEYS: readonly string[] = ['title', 'content_doc', 'journal_date', 'folder_id']

/**
 * 从本机记录的 `first_request` 重建重放参数；记录损坏时返回 null，绝不编造默认值。
 *
 * 映射是镜像写入（`useEditSession.toRecord`）的严格逆变换：
 * `payload.{title, content_doc, journal_date, folder_id}` 还原为 `DocumentDraft`，
 * 其余字段归入 `extras`。四个草稿字段缺失或类型不对就拒绝重建——
 * 宁可让用户走「另存为新草稿」，也不用猜测的数据冒充原请求。
 *
 * `seq` 用记录里单独保存的首次请求序号（`first_request.seq`）；旧记录没有这个字段时
 * 回退到 `input_seq`。两种情况都要求 `seq ∈ [1, input_seq]`：超前说明记录来自另一条
 * 时间线，为 0 说明记录被截断——都不重放。用最新 `input_seq` 冒充首次请求序号，
 * 会让创建确认后就把较新但还没 PATCH 的输入算作已保存。
 *
 * 本函数**不**自己发请求：重放动作由 T02 会话核心在页面接线后执行。
 */
export function rebuildFirstRequest(record: LocalJournalDraft): ReplayFirstRequest | null {
  const stored = record.first_request
  if (stored === null) return null
  if (typeof stored.client_create_id !== 'string' || stored.client_create_id.trim() === '') return null
  const payload = stored.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const source = payload as Record<string, unknown>
  if (typeof source.title !== 'string') return null
  if (typeof source.journal_date !== 'string') return null
  if (!('content_doc' in source)) return null
  if (source.folder_id !== null && typeof source.folder_id !== 'number') return null
  const storedSeq = stored.seq
  // 只校验形状；「序号是否落在记录范围内」交给 `planReplay`（那里才有记录上下文）。
  if (storedSeq !== undefined && (!Number.isInteger(storedSeq) || storedSeq < 1)) return null
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!FIRST_REQUEST_DRAFT_KEYS.includes(key)) extras[key] = value
  }
  return {
    client_create_id: stored.client_create_id,
    draft: {
      title: source.title,
      content_doc: source.content_doc ?? null,
      date: source.journal_date,
      folder_id: source.folder_id,
    },
    extras: Object.keys(extras).length === 0 ? null : extras,
    seq: storedSeq ?? record.input_seq,
  }
}

/* ------------------------------------------- 重放前的记录一致性校验 */

/** 拒绝重放的原因；都是「记录与事实不符」，不涉及正文内容。 */
export type ReplayRefusal =
  /** 记录里没有首次创建请求：这不是「响应丢失」，而是从未发出。 */
  | 'no_first_request'
  /** 记录已经有服务器文件身份：不需要也不能再重放创建。 */
  | 'already_created'
  /** 首次 payload 字段缺失/类型不对：不能猜测原请求。 */
  | 'corrupt_payload'
  /** 记录的业务日期与首次 payload 的日期不一致：不是同一次创建。 */
  | 'date_mismatch'
  /** 记录的类型与首次 payload 的 journal_kind 不一致。 */
  | 'kind_mismatch'
  /** 输入序号不成立（0 或小于首次请求序号）：记录被截断或损坏。 */
  | 'stale_seq'
  /** 首次 payload 本身不可提交（空白正文）：重放会创建一个空记录。 */
  | 'not_savable'

const REFUSAL_MESSAGES: Record<ReplayRefusal, string> = {
  no_first_request: '这份记录里没有已发出的创建请求，不需要重放。',
  already_created: '这份记录已经拿到服务器文件身份，应直接继续编辑，不能重放创建。',
  corrupt_payload: '本机保存的首次请求不完整，无法确认原始提交内容，因此不重放。',
  date_mismatch: '本机记录的业务日期与首次请求不一致，不能把它当作同一次创建重放。',
  kind_mismatch: '本机记录的类型与首次请求不一致，不能重放。',
  stale_seq: '本机记录的输入序号不成立（过旧或损坏），不能重放。',
  not_savable: '首次请求的正文是空白，重放会创建空记录，因此不重放。',
}

export type ReplayPlan =
  | {
    kind: 'ready'
    /** 冻结的原首次请求：键、草稿与 extras 全部来自记录，不用较新输入替换。 */
    request: ReplayFirstRequest
    /** 记录里最新的本地内容（重放成功后用它 PATCH）。 */
    latest: DocumentDraft
    /** 重放会话应延续的输入序号（≥ 首次请求序号）。 */
    latestSeq: number
  }
  | { kind: 'unusable'; reason: ReplayRefusal; message: string }

/**
 * 判断一份本地记录能否按原请求重放，并给出重放所需的三样东西。
 *
 * 这里只做**校验与装配**，不发请求：执行在 `utils/pendingCreateReplay.ts`。
 * 校验的顺序刻意从「最不可能误判」到「最可能误判」：
 * 身份（有没有文件 id）→ 记录完整性 → 日期/类型一致性 → 序号 → 可提交性。
 * 任何一项不成立都返回 `unusable`，绝不带默认值硬上——
 * 用错数据重放会创建一条内容不同的记录，比不恢复更糟。
 */
export function planReplay(record: LocalJournalDraft): ReplayPlan {
  const refuse = (reason: ReplayRefusal): ReplayPlan => ({
    kind: 'unusable',
    reason,
    message: REFUSAL_MESSAGES[reason],
  })
  if (record.file_id !== null) return refuse('already_created')
  if (record.first_request === null) return refuse('no_first_request')
  const request = rebuildFirstRequest(record)
  if (request === null) return refuse('corrupt_payload')
  if (request.draft.date !== record.business_date) return refuse('date_mismatch')
  const extraKind = request.extras === null ? undefined : request.extras.journal_kind
  if (extraKind !== undefined && extraKind !== record.journal_kind) return refuse('kind_mismatch')
  if (!Number.isInteger(request.seq) || request.seq < 1 || request.seq > record.input_seq) {
    return refuse('stale_seq')
  }
  if (!writingSavable(request.draft)) return refuse('not_savable')
  return {
    kind: 'ready',
    request,
    latest: {
      title: record.title,
      content_doc: record.content_doc,
      date: record.business_date,
      folder_id: record.folder_id,
    },
    latestSeq: Math.max(record.input_seq, request.seq),
  }
}
