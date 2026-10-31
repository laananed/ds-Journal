/**
 * 「开始今天 / 结束今天」页面（Stage 4 / S04-T10）。
 *
 * 权威依据：`docs/stage4.md` §3～§7、`docs/stage4-api.md` §3～§6、
 * `docs/stage4-architecture.md` §4～§6、`docs/stage4-tasks.md` §3.11。
 *
 * 这个页面只做四件事，且都不越过 T02/T04/T07 的边界：
 *
 * 1. 读：`GET /api/business-day`、`GET /api/rituals`、`GET /api/ritual-templates`
 *    与回收箱列表，全部零写；缺失 Ritual 时不创建空文件（产品 §4/§5）。
 * 2. 写正文：走应用级会话 `editSessionStore`（T02），创建键/首次 payload/CAS/
 *    本地草稿都由会话层负责，这里只报告输入与保存状态。
 * 3. 模板：只 PATCH 模板本身；点击插入不写模板，也不回写已插入正文。
 * 4. 恢复：完整替换与手动复制都交给 T04 的服务端命令，取消不写；
 *    CAS 冲突保留本地草稿与双方内容。
 *
 * 目标（T07）只消费已交付接口：展示 canonical 目标/回顾/来源可用状态，
 * 勾选与「加入结束今天」都提交给 `api/ritualGoals.ts`，不在页面里 PATCH 两端。
 *
 * **路由接线未在本轮完成**（`App.tsx` 属 T06 写入范围）：页面以独立 props
 * 交付，接线方式见交付报告。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './RitualPage.css'
import RitualQuestions from '../components/RitualQuestions'
import RitualRestoreCompare from '../components/RitualRestoreCompare'
import { DraftConflictView, LocalDraftPanel, type DraftAction, type DraftPanelItem } from '../components/WritingDraftRecovery'
import RichTextEditor from '../editor/RichTextEditor'
import { EMPTY_DOCUMENT } from '../editor/schema'
import {
  copyRitualContent,
  createRitualGoal,
  getBusinessDay,
  getRitualTemplates,
  getRituals,
  insertRitualQuestion,
  restoreRitualReplace,
  updateRitualTemplate,
} from '../api/rituals'
import { getJournal } from '../api/journals'
import { linkGoals, updateGoal } from '../api/ritualGoals'
import { getTrashItem, listTrash } from '../api/trash'
import {
  draftHasChanges,
  editSessionStore,
  errorMessage,
  errorStatus,
  localStateLabel,
  statusLabel,
  type DocumentDraft,
  type FileMutation,
  type SaveResult,
} from '../state/editSessions'
import { journalToDraft, journalToServerFile, journalTransport } from '../state/journalSession'
import { useEditSession, useEditSessionActions, useJournalDraftMirror } from '../hooks/useEditSession'
import {
  draftRecordKey,
  localDraftWriter,
  newLocalId,
  resolveTabId,
  sortCandidates,
  type DraftCandidate,
  type LocalJournalDraft,
  type ServerDraftProbe,
} from '../state/localJournalDrafts'
import {
  conflictHeadings,
  duplicateOfServer,
  localDraftText,
  needsLocalDraft,
  planCandidate,
  planReplay,
  type CandidatePlan,
} from '../utils/writingSession'
import type { ContentDocument } from '../types/document'
import type { Journal } from '../types/journal'
import type { BusinessDay, RitualKind, RitualMutation, RitualQuestion, RitualSelection, RitualTemplates } from '../types/ritual'
import type { FlushResult } from '../hooks/useAutosave'
import {
  KIND_LABEL,
  applyBusinessDay,
  buildCopyPayload,
  buildRestorePayload,
  canAddGoalToEnd,
  deletedRitualsOf,
  displayTitle,
  goalsOf,
  isRitualDraftSavable,
  newNodeId,
  relatedRevisionsFor,
  reviewCanWriteBack,
  reviewsOf,
  ritualRecordMatches,
  userText,
  type GoalView,
  type ReviewView,
  type RitualCapture,
  type RitualFileRef,
} from '../utils/ritualView'
import { checklistCandidates } from '../utils/ritualControlled'

export interface RitualPageProps {
  /** 页面处理哪一种 Ritual；界面只显示「开始今天 / 结束今天」。 */
  kind: RitualKind
  /**
   * 路由给定的业务日期（历史文件编辑用）。
   * 省略时使用打开页面那一刻捕获的上海业务日，跨 04:00 也不重算。
   */
  journalDate?: string
  /** 上层写入锁（全局保存 / AI 进行中）。 */
  disabled?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  /** 提供时在对照入口显示「去回收箱」；页面本身不改路由。 */
  onOpenTrash?: () => void
}

/** 回收箱翻页上限：只为找到同日同类的旧版本，不把整个回收箱拉进内存。 */
const TRASH_PAGE_LIMIT = 10

type LoadStatus = 'loading' | 'ready' | 'error'

/** 详情响应里的关联信息（API §3）：只读展示与版本定位用。 */
type RitualDetail = Journal & {
  goal_links?: { link_id: string; set_id: number | null; end_id: number; goal_id: string; end_node_id: string }[]
  related_revisions?: { type: 'journal'; id: number; revision: number }[]
}

const EMPTY_TEMPLATE = { questions: [] as RitualQuestion[], revision: 0 }

/**
 * 浏览器抛出的原始网络错误（`Failed to fetch`、`NetworkError`、`Load failed`）
 * 对用户没有信息量，统一换成可执行的中文说明；其他错误原样展示。
 */
function humanError(message: string, fallback: string): string {
  if (message === '' || /failed to fetch|networkerror|load failed|fetch failed/i.test(message)) return fallback
  return message
}

function errorText(error: unknown, fallback: string): string {
  return humanError(errorMessage(error), fallback)
}

/**
 * T04 的 FileMutation（完整详情列表）→ T02 会话队列的 FileMutation 形状。
 *
 * 会话层只需要「身份 + 版本 + 权威草稿 + 受控 ops」，因此这里做一次纯映射，
 * 不重新解释 ops 的含义（含义由后端决定，架构 §4 / API §10）。
 */
function toFileMutation(result: RitualMutation): FileMutation {
  return {
    files: result.files.map((file) => ({ type: 'journal' as const, file: journalToServerFile(file) })),
    effects: result.effects.map((effect) => ({
      type: 'journal' as const,
      id: effect.id,
      base_revision: effect.base_revision,
      revision: effect.revision,
      ops: effect.ops.map((op) => ({ kind: op.kind, node_id: op.node_id })),
    })),
    request_id: result.request_id,
  }
}

function RitualPage({
  kind,
  journalDate,
  disabled = false,
  onDirtyChange,
  onBusyChange,
  onFlushReady,
  onOpenTrash,
}: RitualPageProps) {
  /* ------------------------------------------------------------ 读取 */

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [loadError, setLoadError] = useState('')
  const [capture, setCapture] = useState<RitualCapture | null>(null)
  const captureRef = useRef<RitualCapture | null>(null)
  const [openFile, setOpenFile] = useState<Journal | null>(null)
  const [rituals, setRituals] = useState<{ set: Journal | null; end: Journal | null }>({ set: null, end: null })
  const [templates, setTemplates] = useState<RitualTemplates>({ set: EMPTY_TEMPLATE, end: EMPTY_TEMPLATE })
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [templateError, setTemplateError] = useState('')
  const [templateSaving, setTemplateSaving] = useState(false)
  const [deletedSources, setDeletedSources] = useState<Journal[]>([])
  const [notice, setNotice] = useState('')
  const [insertError, setInsertError] = useState('')
  const [goalBusy, setGoalBusy] = useState('')
  const [goalError, setGoalError] = useState('')
  const [serverSnapshot, setServerSnapshot] = useState<Journal | null>(null)
  const [compareSource, setCompareSource] = useState<Journal | null>(null)
  const [compareError, setCompareError] = useState('')
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareServerTarget, setCompareServerTarget] = useState<Journal | null>(null)

  /* 本地未提交草稿（T02 持久化 + T06 恢复面板；本页只负责发现与处置） */
  const [records, setRecords] = useState<LocalJournalDraft[]>([])
  const [draftPlans, setDraftPlans] = useState<Record<string, CandidatePlan>>({})
  const [draftBusyKeys, setDraftBusyKeys] = useState<string[]>([])
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [draftNotice, setDraftNotice] = useState('')
  const [draftConflict, setDraftConflict] = useState<{ record: LocalJournalDraft; server: Journal } | null>(null)
  /** 最近一次被放回编辑器的那份本机草稿；只用于「丢弃」时把编辑器一并回到服务器版本。 */
  const [restoredKey, setRestoredKey] = useState('')
  /** 丢弃未落库草稿后强制重开一个空会话（内容不能留在编辑器里假装还有草稿）。 */
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const serverCache = useRef(new Map<number, Journal>())

  const tabId = useMemo(
    () => resolveTabId(typeof sessionStorage === 'undefined' ? null : sessionStorage, newLocalId()),
    [],
  )

  /**
   * 路由给了日期就以路由为准（它决定打开哪一天的文件）；否则用打开页面时
   * 捕获的上海业务日。两者不一致时说明在看历史日期：此时只读、不创建草稿
   * （见下方会话初始化里 `effectiveDate !== capture.journalDate` 的早退）。
   */
  const effectiveDate = journalDate !== undefined && journalDate !== ''
    ? journalDate
    : (capture?.journalDate ?? '')

  const loadTrash = useCallback(async (date: string) => {
    const found: Journal[] = []
    try {
      for (let page = 1; page <= TRASH_PAGE_LIMIT; page += 1) {
        const data = await listTrash('journal', page)
        for (const item of data.items) {
          if (item.type === 'journal') found.push(item)
        }
        if (!data.has_next) break
      }
      setDeletedSources(deletedRitualsOf(found, kind, date))
    } catch {
      // 回收箱读取失败不影响正文编辑；页面显示入口时再说明原因。
      setDeletedSources([])
    }
  }, [kind])

  const load = useCallback(async () => {
    setStatus('loading')
    setLoadError('')
    try {
      const day: BusinessDay = await getBusinessDay()
      const nextCapture = applyBusinessDay(captureRef.current, day)
      captureRef.current = nextCapture
      setCapture(nextCapture)
      const date = journalDate ?? nextCapture.journalDate
      const [ritualData, templateData] = await Promise.all([getRituals(date), getRitualTemplates()])
      setRituals({ set: ritualData.set, end: ritualData.end })
      setOpenFile(ritualData[kind])
      setTemplates(templateData)
      setTemplatesLoading(false)
      setStatus('ready')
      await loadTrash(date)
    } catch (error: unknown) {
      setStatus('error')
      setLoadError(errorText(error, '读取今天的记录失败，请稍后重试。'))
    }
  }, [journalDate, kind, loadTrash])

  useEffect(() => {
    void load()
  }, [load])

  /* ------------------------------------------------------------ 会话 */

  /**
   * 会话键以「业务日」为唯一身份，不随文件 id 变化。
   *
   * 同日同类型只允许一份 Ritual，所以「日期 + kind」本身就是稳定草稿身份。
   * 若改用 `f{id}`：页面内首次创建后会话键仍是 `d{date}`（只有 load() 才会拿到 id），
   * 切页再回来时页面会算出 `f{id}`，而 `openSession` 按 fileId 复用既有会话、
   * 不会新建这个键 —— 页面就订阅到一个不存在的会话，编辑器永远停在「准备中」。
   */
  const sessionId = useMemo(() => {
    if (effectiveDate === '') return null
    return `ritual:${kind}:d${effectiveDate}`
  }, [kind, effectiveDate])

  useEffect(() => {
    if (status !== 'ready' || sessionId === null || capture === null) return
    const transport = journalTransport({
      journalKind: kind,
      ...(openFile === null ? { draftStartedAt: capture.draftStartedAt } : {}),
    })
    if (openFile !== null) {
      const draft = journalToDraft(openFile)
      const opened = editSessionStore.openSession({
        sessionId, type: 'journal', tabId, draft, transport,
        file: { id: openFile.id, revision: openFile.revision, draft },
        isSavable: isRitualDraftSavable,
      })
      /**
       * 同一业务日的**有效文件换了**（完整替换 / 恢复后重读）：会话键不变，
       * 所以要把身份与基线显式切到新文件，否则后续 PATCH 会打到旧 id 上。
       * 有未确认输入时保留草稿（rebase），没有时才采用服务器内容——都不静默合并。
       */
      if (opened.fileId !== openFile.id) {
        const file = { id: openFile.id, revision: openFile.revision, draft }
        if (needsLocalDraft(opened)) editSessionStore.resolveKeepLocal(sessionId, file)
        else editSessionStore.resolveTakeServer(sessionId, file)
      }
      return
    }
    // 历史日期没有有效文件时不创建草稿：只有捕获当天才允许首次落库。
    if (effectiveDate !== capture.journalDate) return
    editSessionStore.openSession({
      sessionId,
      type: 'journal',
      tabId,
      draft: { title: '', content_doc: EMPTY_DOCUMENT, date: capture.journalDate, folder_id: null },
      transport,
      isSavable: isRitualDraftSavable,
    })
  }, [status, sessionId, capture, openFile, kind, tabId, effectiveDate, sessionEpoch])

  const session = useEditSession(sessionId)
  const actions = useEditSessionActions(sessionId)
  const draftStartedAt = capture?.draftStartedAt ?? ''
  const mirrorOptions = useMemo(() => ({
    sessionId,
    tabId,
    journalKind: kind,
    draftStartedAt,
    enabled: sessionId !== null && status === 'ready',
  }), [sessionId, tabId, kind, draftStartedAt, status])
  const mirror = useJournalDraftMirror(mirrorOptions)
  const flushLocalRef = useRef(mirror.flushLocal)
  flushLocalRef.current = mirror.flushLocal

  const inputSeq = session?.inputSeq ?? 0
  const sessionStatus = session?.status ?? 'saved'

  // 输入停稳后交给会话队列保存；失败/冲突/缺失时不再自动重试（API §10）。
  useEffect(() => {
    if (sessionId === null) return
    const current = editSessionStore.getSession(sessionId)
    if (current === null) return
    if (current.status === 'conflict' || current.status === 'failed' || current.status === 'missing') return
    if (current.inFlight !== null || current.imeComposing) return
    const pending = current.firstRequest !== null || draftHasChanges(current.draft, current.baseline)
    if (!pending) return
    if (current.isSavable !== null && !current.isSavable(current.draft)) return
    const timer = setTimeout(() => { void editSessionStore.saveToSequence(sessionId) }, 900)
    return () => clearTimeout(timer)
  }, [sessionId, inputSeq, sessionStatus])

  const flush = useCallback(async (): Promise<FlushResult> => {
    if (sessionId === null) return 'clean'
    flushLocalRef.current()
    const result: SaveResult = await editSessionStore.saveToSequence(sessionId)
    /**
     * 空正文按产品规则不可提交（`invalid`）。这种情况下拦着不让离开没有意义：
     * 服务端内容没被改动，本机也没有可丢的文字（空草稿本来就不镜像）。
     * 因此把它当作「没有待保存内容」，真正失败/冲突/缺失仍然返回 blocked。
     */
    if (result.kind === 'blocked' && result.reason === 'invalid') return 'clean'
    return result.kind === 'blocked' ? 'blocked' : 'clean'
  }, [sessionId])

  useEffect(() => {
    if (onFlushReady === undefined) return
    onFlushReady(flush)
    return () => onFlushReady(null)
  }, [flush, onFlushReady])

  /**
   * 离开页面（切页 / 换类型 / 卸载）时补一次本机草稿，再让应用级队列继续提交。
   *
   * 与 T02 语义一致：导航不等待网络，但**本机那份**必须先把未确认输入落盘，
   * 否则重开页面就找不到它了（API §10）。
   */
  useEffect(() => {
    if (sessionId === null) return
    const leaving = sessionId
    return () => {
      const current = editSessionStore.getSession(leaving)
      if (current !== null && needsLocalDraft(current)) flushLocalRef.current()
      if (current !== null && current.status !== 'saved') void editSessionStore.saveToSequence(leaving)
    }
  }, [sessionId])

  /* --------------------------------------------- 本地未提交草稿（发现/恢复） */

  const reloadDrafts = useCallback(async () => {
    const result = await localDraftWriter.list()
    if (!result.ok) {
      setDraftError(result.message)
      return
    }
    setRecords(result.records)
    setDraftError('')
  }, [])

  useEffect(() => { void reloadDrafts() }, [reloadDrafts])

  // 本机草稿刚落盘就刷新入口计数：未提交输入要马上能被看见。
  const mirrorLocalState = mirror.localState
  useEffect(() => {
    if (mirrorLocalState === 'saved') void reloadDrafts()
  }, [mirrorLocalState, reloadDrafts])

  // 关页 / 隐藏时写本机草稿已由 T02 的 `useJournalDraftMirror` 统一负责
  // （pagehide + visibilitychange），这里不再注册第二套监听。

  const currentFileId = session?.fileId ?? openFile?.id ?? null

  /**
   * 只列属于**这一页**的记录：同一 kind，且业务日相同或就是当前这份文件。
   * 其他日期的草稿在打开那一天时各自出现，不在这里混着恢复（日期不能顺手改）。
   */
  const ritualCandidates = useMemo(() => {
    return sortCandidates(records).filter((item) => ritualRecordMatches(item, {
      kind,
      journalDate: effectiveDate,
      fileId: currentFileId,
    }))
  }, [records, kind, effectiveDate, currentFileId])

  // 未取得服务器身份的记录不必探测就能定性：在渲染时直接给出计划，
  // 面板一打开就是正确动作（「恢复原请求」而不是先点一次「恢复」）。

  const probeRecord = useCallback(async (record: LocalJournalDraft): Promise<CandidatePlan> => {
    if (record.file_id === null) return planCandidate(record, null)
    let probe: ServerDraftProbe
    try {
      const detail = await getJournal(record.file_id)
      serverCache.current.set(record.file_id, detail)
      probe = { state: 'ok', revision: detail.revision, softDeleted: detail.deleted_at !== null }
    } catch (error: unknown) {
      probe = errorStatus(error) === 404
        ? { state: 'missing' }
        : { state: 'unreadable', message: errorText(error, '读取服务器版本失败') }
    }
    return planCandidate(record, probe)
  }, [])

  /**
   * 打开面板前把有服务器身份的记录都探测一次。
   *
   * 这样面板一打开显示的就是**真实计划**（可恢复 / 需对照 / 服务器已不存在），
   * 而不是「尚未读取服务器版本」加一个可能给错动作的「恢复」按钮。
   */
  const probeAllRecords = useCallback(async () => {
    const result = await localDraftWriter.list()
    if (!result.ok) {
      setDraftError(result.message)
      return
    }
    const page = { kind, journalDate: effectiveDate, fileId: currentFileId }
    const targets = result.records.filter((record) => record.file_id !== null
      && ritualRecordMatches(record, page))
    if (targets.length === 0) return
    const probed = await Promise.all(targets.map(async (record) => {
      const key = draftRecordKey(record.tab_id, record.draft_id)
      return [key, await probeRecord(record)] as const
    }))
    setDraftPlans((current) => ({ ...current, ...Object.fromEntries(probed) }))
  }, [kind, effectiveDate, currentFileId, probeRecord])

  function openRecoveryPanel(): void {
    setRecoveryOpen(true)
    void probeAllRecords()
  }

  function recordContent(record: LocalJournalDraft): DocumentDraft {
    return {
      title: record.title,
      content_doc: record.content_doc,
      date: record.business_date,
      folder_id: record.folder_id,
    }
  }

  function recordTransport(record: LocalJournalDraft) {
    return record.file_id === null
      ? journalTransport({ journalKind: kind, draftStartedAt: record.draft_started_at })
      : journalTransport({ journalKind: kind })
  }

  /**
   * 编辑器里是否已有「不该被恢复动作覆盖」的输入。
   *
   * 用**用户可见内容**（标题 + 正文文字）跟本页载入的那份比较，而不是 deepEqual：
   * 编辑器挂载时会把文档规范化后回写一次（纯结构差异），deepEqual 会把它误判成
   * 「用户刚输入」，于是一个空页面也会拒绝恢复自己的草稿。
   */
  function editorHasUnsubmittedInput(): boolean {
    if (session === null) return false
    if (session.firstRequest !== null) return true
    const currentTitle = session.draft.title.trim()
    const currentBody = userText(session.draft.content_doc as ContentDocument).trim()
    if (openFile === null) {
      // 还没有服务器文件：只有「标题和正文都为空」的空白草稿不算未提交输入，
      // 否则一个刚打开的空页面会拒绝恢复自己的本机草稿。
      return currentTitle !== '' || currentBody !== ''
    }
    return currentTitle !== (openFile.title ?? '').trim()
      || currentBody !== userText(openFile.content_doc as ContentDocument).trim()
  }

  /**
   * 把本机内容放回编辑器，并把基线换成服务器当前版本（`rebaseToServer`）。
   *
   * 这是唯一的「恢复」写法：草稿=本机内容，基线/版本=服务器最新，
   * 因此下一次保存仍是一次真实的 CAS，而不是覆盖别人的写入。
   */
  function putRecordInEditor(record: LocalJournalDraft, server: Journal): void {
    if (sessionId === null || session === null) {
      setDraftNotice('编辑会话还没准备好，请稍后重试。')
      return
    }
    editSessionStore.openSession({
      sessionId,
      type: 'journal',
      tabId,
      draft: recordContent(record),
      transport: recordTransport(record),
      isSavable: isRitualDraftSavable,
    })
    editSessionStore.changeSession(sessionId, recordContent(record), 'system')
    editSessionStore.resolveKeepLocal(sessionId, {
      id: server.id,
      revision: server.revision,
      draft: journalToDraft(server),
    })
    setRestoredKey(draftRecordKey(record.tab_id, record.draft_id))
    setDraftConflict(null)
    setRecoveryOpen(false)
    setDraftNotice('已把本机内容放回编辑器，基于服务器当前版本；保存时仍按版本比对。')
  }

  /** 未落库草稿：只写进「今天的空会话」，不另开文件、不换创建键。 */
  function restoreFreshRecord(record: LocalJournalDraft): void {
    if (sessionId === null || session === null) {
      setDraftNotice('编辑会话还没准备好，请稍后重试。')
      return
    }
    if (session.fileId !== null) {
      setDraftNotice('今天已经有服务器文件；这份未落库草稿不会自动再建一条（同日同类型只允许一份）。')
      return
    }
    editSessionStore.openSession({
      sessionId,
      type: 'journal',
      tabId,
      draft: recordContent(record),
      // 恢复后的会话一定是「创建会话」（没有 fileId）：创建载荷需要
      // draft_started_at，即便记录原本挂在某个已消失的文件上。
      transport: journalTransport({ journalKind: kind, draftStartedAt: record.draft_started_at }),
      isSavable: isRitualDraftSavable,
    })
    editSessionStore.changeSession(sessionId, recordContent(record), 'system')
    setRestoredKey(draftRecordKey(record.tab_id, record.draft_id))
    setDraftConflict(null)
    setRecoveryOpen(false)
    setDraftNotice('已恢复这份本机草稿；它还没提交到服务器，确认后会自动保存。')
  }

  /**
   * 「恢复原请求」：用记录里的原创建键 + 原首次 payload 重放，再 PATCH 最新输入。
   *
   * 只消费 T02 已公开的 `openSession({ firstRequest, resumedInputSeq })`；
   * 键或 payload 不成立时 `planReplay` / 会话核心都会拒绝，这里如实转述。
   */
  async function replayRecord(record: LocalJournalDraft): Promise<void> {
    if (sessionId === null) return
    const plan = planReplay(record)
    if (plan.kind !== 'ready') {
      setDraftNotice(plan.message)
      return
    }
    if (!isRitualDraftSavable(plan.latest)) {
      setDraftNotice('这份草稿的正文为空，不能重放创建；可以先补内容或直接丢弃。')
      return
    }
    /**
     * 编辑器挂载时会把初始文档以 `system` 来源同步进会话并推进输入序号，
     * 让「页面先开的空占位会话」看起来像已输入。会话没有服务器身份、
     * 没有在途请求、没有已挂的首次请求、且用户可见内容为空时，它只是
     * 占位符：关掉重开，把创建键换成记录里的原键（这正是「重放」的含义）。
     * 用户可见内容非空时绝不能这么做——那会覆盖真实输入。
     */
    if (session !== null && session.fileId === null && session.firstRequest === null
      && session.inFlight === null
      && session.draft.title.trim() === '' && userText(session.draft.content_doc as ContentDocument).trim() === '') {
      editSessionStore.closeSession(sessionId)
    }
    try {
      editSessionStore.openSession({
        sessionId,
        type: 'journal',
        tabId,
        draft: recordContent(record),
        transport: recordTransport(record),
        isSavable: isRitualDraftSavable,
        firstRequest: plan.request,
        resumedInputSeq: plan.latestSeq,
      })
      editSessionStore.changeSession(sessionId, plan.latest, 'system')
    } catch (error: unknown) {
      setDraftNotice(errorText(error, '这份草稿不能按原创建请求重放。'))
      return
    }
    setRestoredKey(draftRecordKey(record.tab_id, record.draft_id))
    setRecoveryOpen(false)
    setDraftConflict(null)
    const result = await editSessionStore.saveToSequence(sessionId)
    if (result.kind === 'blocked') {
      setDraftNotice('重放没有完成（可能是版本冲突或网络中断）；本机草稿仍保留，可以重试。')
      return
    }
    setDraftNotice('已按原创建键取回那次提交，并把最新输入提交为一次版本更新。')
    await load()
  }

  async function discardRecord(record: LocalJournalDraft): Promise<void> {
    const key = draftRecordKey(record.tab_id, record.draft_id)
    const result = await localDraftWriter.remove(record.tab_id, record.draft_id)
    await reloadDrafts()
    setDraftPlans((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    if (!result.ok) {
      setDraftError(result.message)
      return
    }
    // 编辑器里现在放着这份被丢弃的内容：必须明确回到服务器版本（或空），
    // 否则「丢弃」只是删了本机记录，屏幕上还留着一份会被再次写回的正文。
    if (restoredKey === key && session !== null && sessionId !== null) {
      if (session.fileId !== null && session.revision !== null) {
        editSessionStore.resolveTakeServer(sessionId, {
          id: session.fileId,
          revision: session.revision,
          draft: session.baseline,
        })
      } else {
        editSessionStore.closeSession(sessionId)
        setSessionEpoch((value) => value + 1)
      }
    }
    setRestoredKey('')
    setDraftNotice('已丢弃这份本机草稿；服务器上的内容没有被改动。')
  }

  async function onDraftAction(candidate: DraftCandidate, action: DraftAction): Promise<void> {
    const record = records.find((item) => draftRecordKey(item.tab_id, item.draft_id) === candidate.key) ?? null
    if (record === null) {
      setDraftError('这份本机草稿已经不存在了，请重新读取。')
      await reloadDrafts()
      return
    }
    setDraftError('')
    if (action === 'later') {
      setRecoveryOpen(false)
      setDraftNotice('已稍后处理；这份草稿仍在本机，可以从「本地未提交草稿」再打开。')
      return
    }
    if (action === 'discard') {
      await discardRecord(record)
      return
    }
    // 不静默覆盖：编辑器里已有未提交输入时，先让用户保存或复制，再恢复别的草稿。
    if (restoredKey !== candidate.key && editorHasUnsubmittedInput()) {
      setDraftNotice('当前正文里还有未提交的输入，恢复这份草稿会覆盖它。请先保存，或把内容复制出来再恢复。')
      return
    }

    setDraftBusyKeys((current) => [...current, candidate.key])
    try {
      if (action === 'replayOriginal') {
        await replayRecord(record)
        return
      }
      if (action === 'saveAsNew') {
        restoreFreshRecord(record)
        return
      }
      const plan = draftPlans[candidate.key] ?? await probeRecord(record)
      setDraftPlans((current) => ({ ...current, [candidate.key]: plan }))
      const server = record.file_id === null ? null : serverCache.current.get(record.file_id) ?? null
      switch (plan.kind) {
        case 'fresh':
          restoreFreshRecord(record)
          return
        case 'editable':
          if (server === null) {
            setDraftNotice('服务器版本已读取，但内容缓存丢失，请重试一次。')
            return
          }
          putRecordInEditor(record, server)
          return
        case 'conflict':
          if (server === null) {
            setDraftNotice('服务器版本已读取，但内容缓存丢失，请重试一次。')
            return
          }
          // 两侧内容完全一致（保存已确认、记录没来得及清理）：直接按服务器版本继续。
          if (duplicateOfServer(record, server)) {
            putRecordInEditor(record, server)
            return
          }
          setDraftConflict({ record, server })
          setRecoveryOpen(false)
          return
        case 'server_missing':
          setDraftNotice(session !== null && session.fileId === null
            ? '服务器上这份文件已不存在（可能在回收箱）。今天没有有效文件，可以「另存为新草稿」重新提交，或从回收箱恢复；不会自动新建。'
            : '服务器上这份文件已不存在（可能已删除或替换）。本机内容保留；恢复不会自动新建，也不会自动重连关联。')
          return
        case 'replay_pending':
          setDraftNotice('这份草稿的创建结果未确认。请用「恢复原请求」按原创建键重放，避免在服务器上多出一条。')
          return
        default:
          setDraftNotice(`暂时读不到服务器版本：${plan.message}。本机内容保留，稍后可以再试。`)
      }
    } finally {
      setDraftBusyKeys((current) => current.filter((item) => item !== candidate.key))
    }
  }

  function takeServerForRecordConflict(): void {
    if (draftConflict === null || sessionId === null || session === null) return
    const server = draftConflict.server
    editSessionStore.openSession({
      sessionId,
      type: 'journal',
      tabId,
      draft: journalToDraft(server),
      transport: journalTransport({ journalKind: kind }),
      file: { id: server.id, revision: server.revision, draft: journalToDraft(server) },
      isSavable: isRitualDraftSavable,
    })
    editSessionStore.resolveTakeServer(sessionId, {
      id: server.id,
      revision: server.revision,
      draft: journalToDraft(server),
    })
    setDraftConflict(null)
    setDraftNotice('已采用服务器版本；本机那份草稿仍保留在「本地未提交草稿」里，可以稍后对照或丢弃。')
  }

  const busy = (session?.inFlight !== null && session?.inFlight !== undefined) || templateSaving || goalBusy !== '' || compareBusy
  useEffect(() => { onBusyChange?.(busy) }, [busy, onBusyChange])

  /* ------------------------------------------------------- 编辑正文 */

  const draft = session?.draft ?? null
  const document = (draft?.content_doc ?? EMPTY_DOCUMENT) as ContentDocument

  /**
   * 全新一天、用户还没写任何东西时，草稿相对「空基线」也算有差异，
   * 但这不该显示成「还有改动未提交」。只在没有有效文件、标题与用户正文
   * 都为空时，才把这段草稿当作尚未开始的空白草稿。
   */
  const untouchedBlank = draft !== null && draft.title.trim() === '' && userText(document).trim() === ''
  const pristineBlank = untouchedBlank && session?.fileId === null
  const dirty = session !== null && draftHasChanges(session.draft, session.baseline) && !pristineBlank
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  const changeDraft = useCallback((next: DocumentDraft, origin: 'user_input' | 'system' = 'user_input') => {
    if (sessionId === null) return
    editSessionStore.changeSession(sessionId, next, origin)
  }, [sessionId])

  function handleBodyChange(next: ContentDocument) {
    if (draft === null) return
    changeDraft({ ...draft, content_doc: next })
  }

  function handleTitleChange(value: string) {
    if (draft === null) return
    changeDraft({ ...draft, title: value })
  }

  /* ----------------------------------------------------------- 模板 */

  const currentTemplate = templates[kind] ?? EMPTY_TEMPLATE

  async function refreshRitualMetadata(): Promise<boolean> {
    try {
      const latest = await getRituals(effectiveDate)
      setRituals({ set: latest.set, end: latest.end })
      return true
    } catch {
      return false
    }
  }

  async function saveTemplate(questions: RitualQuestion[]) {
    setTemplateSaving(true)
    setTemplateError('')
    try {
      const saved = await updateRitualTemplate(kind, currentTemplate.revision, questions)
      setTemplates((previous) => ({ ...previous, [kind]: saved }))
      setNotice('模板已保存。已插入正文的问题不会因为模板变化而改变。')
    } catch (error: unknown) {
      const conflict = errorStatus(error) === 409
      setTemplateError(conflict
        ? '模板已在别处更新（版本冲突）。本地修改已保留，重新读取后再决定是否覆盖。'
        : errorText(error, '保存模板失败，请稍后重试。'))
    } finally {
      setTemplateSaving(false)
    }
  }

  async function reloadTemplates() {
    setTemplatesLoading(true)
    setTemplateError('')
    try {
      setTemplates(await getRitualTemplates())
    } catch (error: unknown) {
      setTemplateError(errorText(error, '重新读取模板失败。'))
    } finally {
      setTemplatesLoading(false)
    }
  }

  async function insertTemplateQuestion(question: RitualQuestion) {
    setInsertError('')
    if (sessionId === null) return
    if (!currentTemplate.questions.some((saved) => saved.id === question.id && saved.text === question.text)) {
      setInsertError('请先保存模板修改，再插入问题。')
      return
    }
    setGoalBusy('question')
    try {
      await editSessionStore.runFileCommand(sessionId, async () => {
        const fresh = editSessionStore.getSession(sessionId)
        if (fresh?.fileId == null || fresh.revision == null) throw new Error('请先写入并保存正文，再插入问题。')
        return toFileMutation(await insertRitualQuestion(fresh.fileId, {
          expected_revision: fresh.revision, expected_template_revision: currentTemplate.revision, question_id: question.id,
        }))
      })
      if (editSessionStore.getSession(sessionId)?.status === 'conflict') {
        setInsertError('问题可能已写入服务器；本地有更新，请对照版本后处理，不要重复点击。')
      } else setNotice('问题已插入正文，可以继续在后面写答案。')
    } catch (error: unknown) {
      setInsertError(errorStatus(error) === 409 ? '文件或模板版本已变化，请重新读取后检查是否已插入。' : errorText(error, '插入失败，请先检查服务器内容再重试。'))
    } finally { setGoalBusy('') }
  }

  async function convertGoal(itemId: string) {
    if (sessionId === null) return
    setGoalBusy(itemId)
    setGoalError('')
    try {
      await editSessionStore.runFileCommand(sessionId, async () => {
        const fresh = editSessionStore.getSession(sessionId)
        if (fresh?.fileId == null || fresh.revision == null) throw new Error('请先保存清单。')
        return toFileMutation(await createRitualGoal(fresh.fileId, {
          expected_revision: fresh.revision, task_item_id: itemId,
        }))
      })
      if (editSessionStore.getSession(sessionId)?.status === 'conflict') {
        setGoalError('目标可能已创建；本地有更新，请对照版本后处理。')
      } else if (await refreshRitualMetadata()) setNotice('清单条目已转换为目标；可主动加入结束今天。')
      else setGoalError('目标已创建，但关联信息读取失败；请重新打开页面后再关联。')
    } catch (error: unknown) {
      setGoalError(errorStatus(error) === 409 ? '文件版本已变化，请重新读取并确认目标状态。' : errorText(error, '转换失败，请先检查服务器内容再重试。'))
    } finally { setGoalBusy('') }
  }

  /* ------------------------------------------------------- 保存状态 */

  const saveHint = (() => {
    if (session === null) return ''
    // 失败/冲突/缺失都把用户可执行的下一步写清楚，不透出原始英文错误。
    if (session.status === 'conflict') {
      return '服务器上这份文件已被更新（版本冲突），本次保存没有写入。本地草稿没有被覆盖，'
        + '请选择采用服务器版本，或保留本地草稿后基于最新版本重新提交。'
    }
    if (session.status === 'missing') {
      return '服务器上这份文件已不存在（可能已被删除或替换）。本地草稿仍保留，可以先复制内容再决定。'
    }
    if (session.status === 'failed') {
      return humanError(session.error, '保存没有成功（可能是网络中断）。本地草稿与正文都还在，可以重试保存。')
    }
    if (draft !== null && !isRitualDraftSavable(draft) && !pristineBlank) return '正文为空，还没有提交到服务器（本地草稿会保留）。'
    return ''
  })()

  async function reloadServerVersion() {
    if (session?.fileId === null || session?.fileId === undefined) return
    try {
      const fresh = await getJournal(session.fileId)
      setServerSnapshot(fresh)
      setNotice(`已读取服务器最新版本（revision ${fresh.revision}）。本地草稿没有被覆盖。`)
    } catch (error: unknown) {
      setNotice(errorText(error, '读取服务器版本失败，本地草稿仍在。'))
    }
  }

  function takeServerVersion() {
    if (session === null || serverSnapshot === null) return
    editSessionStore.resolveTakeServer(session.sessionId, {
      id: serverSnapshot.id,
      revision: serverSnapshot.revision,
      draft: journalToDraft(serverSnapshot),
    })
    setServerSnapshot(null)
    setNotice('已采用服务器版本，本地草稿被明确丢弃。')
  }

  function keepLocalDraft() {
    if (session === null || serverSnapshot === null) return
    editSessionStore.resolveKeepLocal(session.sessionId, {
      id: serverSnapshot.id,
      revision: serverSnapshot.revision,
      draft: journalToDraft(serverSnapshot),
    })
    setServerSnapshot(null)
    setNotice('已保留本地草稿；下一次保存会基于服务器最新版本提交。')
  }

  /* ----------------------------------------------------------- 目标 */

  const links = useMemo(() => {
    const detail = kind === 'set' ? rituals.set : rituals.end
    const raw = (detail as RitualDetail | null)?.goal_links
    return Array.isArray(raw) ? raw : []
  }, [kind, rituals])

  const setDetail = rituals.set
  const endDetail = rituals.end
  const addToEnd = canAddGoalToEnd(endDetail)
  const goals: GoalView[] = useMemo(() => (kind === 'set' ? goalsOf(document) : []), [kind, document])
  const reviews: ReviewView[] = useMemo(() => (kind === 'end' ? reviewsOf(document, links) : []), [kind, document, links])

  async function toggleGoal(goal: GoalView, checked: boolean) {
    if (sessionId === null || session === null) return
    const setId = session.fileId ?? setDetail?.id ?? null
    if (setId === null) {
      setGoalError('开始今天还没有保存，无法修改目标。')
      return
    }
    setGoalBusy(goal.goalId)
    setGoalError('')
    try {
      await editSessionStore.runFileCommand(sessionId, async () => {
        const fresh = editSessionStore.getSession(sessionId)
        if (fresh === null || fresh.revision === null) throw new Error('当前文件还没有保存，先保存再修改目标。')
        const related = relatedRevisionsFor(setDetail ?? null, [setId])
        const link = links.find((item) => item.goal_id === goal.goalId)
        const endRevision = link === undefined
          ? undefined
          : related.find((item) => item.id === link.end_id)?.revision
        return updateGoal(setId, goal.goalId, {
          expected_set_revision: fresh.revision,
          ...(endRevision === undefined ? {} : { expected_end_revision: endRevision }),
          checked,
        })
      })
      if (editSessionStore.getSession(sessionId)?.status === 'conflict') {
        setGoalError('修改已提交，但本地草稿无法安全合并；请对照版本处理。')
        return
      }
      if (await refreshRitualMetadata()) setNotice('目标完成状态已提交；关联的结束今天会同步更新，回答不变。')
      else setGoalError('目标修改已提交，但关联信息读取失败；请重新打开页面。')
    } catch (error: unknown) {
      setGoalError(errorStatus(error) === 409
        ? '关联文件版本已变化（或关联集合改变），本次勾选没有写入；本地草稿与回答都保留。'
        : errorText(error, '修改目标失败，请稍后重试。'))
    } finally {
      setGoalBusy('')
    }
  }

  async function toggleReview(review: ReviewView, checked: boolean) {
    if (sessionId === null || session === null) return
    const setId = review.setId
    const goalId = review.goalId
    if (!reviewCanWriteBack(review) || setId === null || goalId === null) {
      setGoalError('目标来源不可用（关联已解除），不能从结束今天回写；可以继续编辑本文件的回顾文字和回答。')
      return
    }
    setGoalBusy(review.nodeId)
    setGoalError('')
    try {
      await editSessionStore.runFileCommand(sessionId, async () => {
        const fresh = editSessionStore.getSession(sessionId)
        if (fresh === null || fresh.revision === null) throw new Error('当前文件还没有保存，先保存再修改目标。')
        const related = relatedRevisionsFor(endDetail ?? null, [setId])
        const setRevision = related.find((item) => item.id === setId)?.revision
        if (setRevision === undefined) throw new Error('开始今天的版本未知，请先重新读取。')
        return updateGoal(setId, goalId, {
          expected_set_revision: setRevision,
          expected_end_revision: fresh.revision,
          checked,
        })
      })
      if (editSessionStore.getSession(sessionId)?.status === 'conflict') {
        setGoalError('修改已提交，但本地草稿无法安全合并；请对照版本处理。')
        return
      }
      if (await refreshRitualMetadata()) setNotice('目标状态已回写到开始今天，回答保持不变。')
      else setGoalError('目标修改已提交，但关联信息读取失败；请重新打开页面。')
    } catch (error: unknown) {
      setGoalError(errorStatus(error) === 409
        ? '开始今天或关联集合已变化，本次修改没有写入；本地草稿保留。'
        : errorText(error, '修改目标失败，请稍后重试。'))
    } finally {
      setGoalBusy('')
    }
  }

  async function addGoalToEnd(goal: GoalView) {
    if (sessionId === null) return
    const availability = canAddGoalToEnd(endDetail)
    if (!availability.available) {
      setGoalError(availability.reason)
      return
    }
    setGoalBusy(goal.goalId)
    setGoalError('')
    try {
      await editSessionStore.runFileCommand(sessionId, async () => {
        const fresh = editSessionStore.getSession(sessionId)
        if (fresh === null || fresh.fileId === null || fresh.revision === null) {
          throw new Error('开始今天还没有保存，先保存再关联目标。')
        }
        return linkGoals({
          source_set_id: fresh.fileId,
          goal_ids: [goal.goalId],
          expected_set_revision: fresh.revision,
          end_id: availability.entry.id,
          expected_end_revision: availability.entry.revision,
        })
      })
      if (editSessionStore.getSession(sessionId)?.status === 'conflict') {
        setGoalError('关联已提交，但本地草稿无法安全合并；请对照版本处理。')
        return
      }
      if (await refreshRitualMetadata()) setNotice('已把目标加入结束今天；之后两端修改文字或完成状态会同步，回答不会被改写。')
      else setGoalError('关联请求已提交，但关联信息读取失败；请重新打开页面确认。')
    } catch (error: unknown) {
      setGoalError(errorStatus(error) === 409
        ? '开始今天或结束今天已被修改，本次关联没有写入。'
        : errorText(error, '加入结束今天失败，请稍后重试。'))
    } finally {
      setGoalBusy('')
    }
  }

  /* ------------------------------------------------------- 恢复对照 */

  const targetRef: RitualFileRef | null = session === null || session.fileId === null || session.revision === null
    ? null
    : { id: session.fileId, revision: session.revision, content_doc: document }

  async function openCompare() {
    if (deletedSources.length === 0) return
    // 对照/替换都需要一个已落库的当前文件（服务端以 target 的 revision 做 CAS）。
    if (session === null || session.fileId === null) {
      setNotice('对照需要一个已保存的当前文件：先在正文里写下内容并保存，再打开对照。')
      return
    }
    setCompareError('')
    try {
      const item = await getTrashItem('journal', deletedSources[0].id)
      if (item.type !== 'journal') return
      setCompareSource(item)
    } catch (error: unknown) {
      setNotice(errorText(error, '读取回收箱里的旧版本失败。'))
    }
  }

  function chooseCompareSource(id: number) {
    const found = deletedSources.find((item) => item.id === id)
    if (found === undefined) return
    setCompareError('')
    setCompareSource(found)
  }

  function cancelCompare() {
    setCompareSource(null)
    setCompareServerTarget(null)
    setCompareError('')
    setNotice('已取消对照，没有写入任何数据。')
  }

  async function copySelection(selection: RitualSelection[], insertAfterNodeId: string) {
    if (sessionId === null || compareSource === null || session === null) return
    setCompareBusy(true)
    setCompareError('')
    try {
      await editSessionStore.runFileCommand(sessionId, async () => {
        const fresh = editSessionStore.getSession(sessionId)
        if (fresh === null || fresh.fileId === null || fresh.revision === null) {
          throw new Error('当前文件还没有保存，先保存再复制。')
        }
        const built = buildCopyPayload({
          source: compareSource,
          target: { id: fresh.fileId, revision: fresh.revision, content_doc: fresh.draft.content_doc as ContentDocument | null },
          copyId: newNodeId(),
          selection,
          insertAfterNodeId,
          relatedRevisions: relatedRevisionsFor(openFile, [fresh.fileId]),
        })
        if (!built.ok) throw new Error(built.message)
        const result = await copyRitualContent(compareSource.id, built.payload)
        return toFileMutation(result)
      })
      setCompareSource(null)
      setNotice('已按所选内容复制到当前文件：新内容由服务端构造，旧版本仍留在回收箱。')
    } catch (error: unknown) {
      if (errorStatus(error) === 409) {
        setCompareError('版本冲突：旧版本或当前文件已被修改，本次复制没有写入。本地草稿与双方内容都保留。')
        await reloadCompareTarget()
      } else {
        setCompareError(errorText(error, '复制失败，请稍后重试。'))
      }
    } finally {
      setCompareBusy(false)
    }
  }

  async function replaceWithSource(sourceRevision: number) {
    if (sessionId === null || compareSource === null || targetRef === null) return
    setCompareBusy(true)
    setCompareError('')
    try {
      const built = buildRestorePayload(compareSource, targetRef, relatedRevisionsFor(openFile, [targetRef.id]))
      if (!built.ok) throw new Error(built.message)
      // 命令成功后由服务端决定谁是有效文件：整页重读，不靠本地猜测身份。
      await editSessionStore.runFileCommand(
        sessionId,
        async () => toFileMutation(await restoreRitualReplace(compareSource.id, sourceRevision, built.payload)),
      )
      setCompareSource(null)
      setCompareServerTarget(null)
      setNotice('已完整替换：旧版本恢复为有效文件，原当前文件已移入回收箱；旧关联不会自动重建。')
      await load()
    } catch (error: unknown) {
      if (errorStatus(error) === 409) {
        setCompareError('版本冲突：来源或当前文件已被修改，本次替换没有写入。双方内容都保留。')
        await reloadCompareTarget()
      } else {
        setCompareError(errorText(error, '完整替换失败，请稍后重试。'))
      }
    } finally {
      setCompareBusy(false)
    }
  }

  async function reloadCompareTarget() {
    if (session?.fileId === null || session?.fileId === undefined) return
    try {
      setCompareServerTarget(await getJournal(session.fileId))
    } catch {
      setCompareServerTarget(null)
    }
  }

  async function reloadCompare() {
    if (compareSource === null) return
    setCompareError('')
    try {
      const item = await getTrashItem('journal', compareSource.id)
      if (item.type === 'journal') setCompareSource(item)
      await reloadCompareTarget()
    } catch (error: unknown) {
      setCompareError(errorText(error, '重新读取失败，请稍后重试。'))
    }
  }

  /* ----------------------------------------------------------- 渲染 */

  const title = draft?.title ?? ''
  const fileId = session?.fileId ?? null
  const missingHistoryFile = effectiveDate !== '' && capture !== null && effectiveDate !== capture.journalDate
    && openFile === null
  const panelItems: DraftPanelItem[] = ritualCandidates.map((candidate) => {
    const record = records.find((item) => draftRecordKey(item.tab_id, item.draft_id) === candidate.key) ?? null
    const plan = draftPlans[candidate.key]
      ?? (record !== null && record.file_id === null ? planCandidate(record, null) : null)
    return {
      candidate,
      plan,
      busy: draftBusyKeys.includes(candidate.key),
    }
  })

  return (
    <div className="ritual-page">
      <header className="ritual-head">
        <p className="ritual-eyebrow">{KIND_LABEL[kind]} · 业务日 {effectiveDate === '' ? '读取中' : effectiveDate}</p>
        <h2 className="ritual-title">
          {displayTitle(kind, effectiveDate, title)}
          {fileId === null && <span className="ritual-badge">未保存</span>}
        </h2>
        <p className="ritual-sub">
          上海时间每日 04:00 换日；本页的日期在打开草稿时固定，不会因为跨过 04:00 自动跳转。
          {openFile !== null && openFile.journal_date !== effectiveDate && `（历史文件：${openFile.journal_date}）`}
        </p>
        <div className="ritual-status" role="status" aria-live="polite">
          {session !== null && <span>{statusLabel(sessionStatus)}</span>}
          {mirror.localState !== 'idle' && <span>{localStateLabel(mirror.localState)}</span>}
          {session !== null && !busy && dirty && <span>还有改动未提交</span>}
        </div>
      </header>

      {draftNotice !== '' && <p className="ritual-notice" role="status">{draftNotice}</p>}

      {ritualCandidates.length > 0 && !recoveryOpen && (
        <div className="ritual-recovery-callout" role="status">
          <p>本机还有 {ritualCandidates.length} 份未提交的草稿（只保存在这台浏览器，不代表服务器已保存）。</p>
          <p className="ritual-hint">可以打开列表选择恢复、稍后处理或明确丢弃；不做选择时不会有任何自动写入。</p>
          <button type="button" className="ritual-button" onClick={openRecoveryPanel}>
            查看本地草稿
          </button>
        </div>
      )}

      {recoveryOpen && (
        <LocalDraftPanel
          items={panelItems}
          currentTabId={tabId}
          error={draftError}
          notice=""
          disabled={disabled || busy}
          onAction={(candidate, action) => { void onDraftAction(candidate, action) }}
          onClose={() => setRecoveryOpen(false)}
          onClearAll={() => { void (async () => {
            const cleared = await localDraftWriter.clearAll()
            await reloadDrafts()
            setDraftPlans({})
            setDraftNotice(cleared.ok ? '已清空本应用存在这台浏览器上的草稿。' : cleared.message)
          })() }}
        />
      )}

      {draftConflict !== null && (
        <DraftConflictView
          title={`这份${KIND_LABEL[kind]}的本机草稿与服务器版本不一致`}
          localHeading={conflictHeadings(draftConflict.record.base_revision, draftConflict.server.revision).local}
          localText={localDraftText(draftConflict.record)}
          localMeta={`本机草稿 · 输入序号 ${draftConflict.record.input_seq}`}
          serverHeading={conflictHeadings(draftConflict.record.base_revision, draftConflict.server.revision).server}
          serverText={draftConflict.server.content}
          serverMeta={`${draftConflict.server.display_title} · 版本 ${draftConflict.server.revision}`}
          keepLocalLabel="保留我的草稿（基于服务器版本）"
          takeServerLabel="采用服务器版本"
          busy={draftBusyKeys.length > 0}
          onKeepLocal={() => putRecordInEditor(draftConflict.record, draftConflict.server)}
          onTakeServer={takeServerForRecordConflict}
          onLater={() => { setDraftConflict(null); setDraftNotice('已稍后处理；服务器与本机内容都保留。') }}
        />
      )}

      {status === 'loading' && <p className="ritual-state" role="status">正在读取今天的记录……</p>}

      {status === 'error' && (
        <div className="ritual-state ritual-state--error" role="alert">
          <p>{loadError}</p>
          <p className="ritual-hint">这里只读取数据，重试不会创建任何文件。</p>
          <button type="button" className="ritual-button" onClick={() => void load()}>重新读取</button>
        </div>
      )}

      {status === 'ready' && (
        <div className={`ritual-layout${compareSource !== null ? ' ritual-layout--compare' : ''}`}>
          <aside className="ritual-context" aria-label={`${KIND_LABEL[kind]} 上下文`}>
            <RitualQuestions
              kind={kind}
              journalDate={effectiveDate}
              questions={currentTemplate.questions}
              revision={currentTemplate.revision}
              loading={templatesLoading}
              disabled={disabled || busy}
              error={templateError}
              canInsert={sessionId !== null}
              insertBlockedReason="请先写入并保存正文。"
              onSave={(questions) => void saveTemplate(questions)}
              onReload={() => void reloadTemplates()}
              onInsert={(question) => void insertTemplateQuestion(question)}
              insertError={insertError}
            />

            <section className="ritual-goals" aria-labelledby="ritual-goals-title">
              <h3 id="ritual-goals-title">{kind === 'set' ? '今天的目标' : '目标回顾'}</h3>
              {kind === 'set' && checklistCandidates(document).map((item) => (
                <div key={item.id} className="ritual-goal-item">
                  <span>{item.text}</span>{' '}
                  <button type="button" disabled={disabled || busy} onClick={() => void convertGoal(item.id)}>转为目标</button>
                </div>
              ))}
              {kind === 'set' && goals.length === 0 && (
                <p className="ritual-hint">
                  还没有目标。可将正文中的纯文字清单条目转为目标；含格式或嵌套的条目需先调整。
                </p>
              )}
              {kind === 'set' && goals.length > 0 && (
                <ul className="ritual-goal-list">
                  {goals.map((goal) => (
                    <li key={goal.goalId} className="ritual-goal-item">
                      <label className="ritual-goal-check">
                        <input type="checkbox" checked={goal.checked} disabled={disabled || goalBusy !== ''}
                          onChange={(event) => void toggleGoal(goal, event.target.checked)} />
                        <span>{goal.text}</span>
                      </label>
                      <button type="button" className="ritual-button"
                        disabled={disabled || goalBusy !== '' || !addToEnd.available}
                        title={addToEnd.available ? undefined : addToEnd.reason}
                        onClick={() => void addGoalToEnd(goal)}>
                        加入结束今天
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {kind === 'end' && reviews.length === 0 && (
                <p className="ritual-hint">还没有关联的目标回顾。目标需要在开始今天里主动加入结束今天。</p>
              )}
              {kind === 'end' && reviews.length > 0 && (
                <ul className="ritual-review-list">
                  {reviews.map((review) => (
                    <li key={review.nodeId} className="ritual-review-item">
                      <p className="ritual-review-title">{review.title === '' ? '（无标题回顾）' : review.title}</p>
                      <p className="ritual-review-meta">
                        快照：{review.snapshot === '' ? '（空）' : review.snapshot}
                        {' · '}
                        {review.checked ? '已完成' : '未完成'}
                      </p>
                      {!review.sourceAvailable && (
                        <p className="ritual-review-unavailable" role="status">
                          目标来源不可用（关联已解除），回顾快照和回答仍保留，恢复也不会自动重连。
                        </p>
                      )}
                      <div className="ritual-review-actions">
                        <button type="button" className="ritual-button"
                          disabled={disabled || goalBusy !== '' || !reviewCanWriteBack(review)}
                          onClick={() => void toggleReview(review, !review.checked)}>
                          {review.checked ? '标记为未完成' : '标记为完成'}
                        </button>
                      </div>
                      {!review.sourceAvailable && !reviewCanWriteBack(review) && (
                        <p className="ritual-hint">来源不可用时不能从结束今天回写；可以继续编辑回顾文字与回答。</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {goalError !== '' && <p className="ritual-alert" role="alert">{goalError}</p>}
            </section>

            {deletedSources.length > 0 && (
              <section className="ritual-restore" aria-labelledby="ritual-restore-title">
                <h3 id="ritual-restore-title">同日旧版本</h3>
                <p className="ritual-hint">
                  回收箱里有 {deletedSources.length} 个同日{ KIND_LABEL[kind]}。可以对照后手动复制内容，或完整替换当前文件。
                </p>
                <label className="ritual-restore-select">
                  <span>旧版本</span>
                  <select value={compareSource?.id ?? ''} disabled={disabled || compareBusy}
                    onChange={(event) => chooseCompareSource(Number(event.target.value))}>
                    <option value="">选择旧版本…</option>
                    {deletedSources.map((item) => (
                      <option key={item.id} value={item.id}>
                        #{item.id} · revision {item.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="ritual-restore-actions">
                  <button type="button" className="ritual-button ritual-button--primary"
                    disabled={disabled || compareBusy} onClick={() => void openCompare()}>
                    打开对照
                  </button>
                  {onOpenTrash !== undefined && (
                    <button type="button" className="ritual-button" onClick={onOpenTrash}>去回收箱</button>
                  )}
                </div>
              </section>
            )}
          </aside>

          <div className="ritual-main">
            {notice !== '' && <p className="ritual-notice" role="status">{notice}</p>}

            {saveHint !== '' && (
              <div className="ritual-alert" role="alert">
                <p>{saveHint}</p>
                <div className="ritual-alert-actions">
                  {sessionStatus === 'failed' && (
                    <button type="button" className="ritual-button" disabled={disabled || busy}
                      onClick={() => void actions.retry()}>
                      重试保存
                    </button>
                  )}
                  {fileId !== null && (
                    <button type="button" className="ritual-button" disabled={disabled || busy}
                      onClick={() => void reloadServerVersion()}>
                      读取服务器最新版本
                    </button>
                  )}
                </div>
                {serverSnapshot !== null && (
                  <div className="ritual-conflict">
                    <p>
                      服务器现在是 revision {serverSnapshot.revision}；本地草稿仍在。
                      选择一方不会被再次自动合并。
                    </p>
                    <div className="ritual-alert-actions">
                      <button type="button" className="ritual-button" onClick={takeServerVersion}>采用服务器版本</button>
                      <button type="button" className="ritual-button ritual-button--primary" onClick={keepLocalDraft}>
                        保留本地草稿并基于最新重写
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {missingHistoryFile ? (
              <p className="ritual-state">
                {effectiveDate} 没有有效的{KIND_LABEL[kind]}。本页不提供历史日期的创建入口；
                请在当天打开时写入，或从回收箱恢复。
              </p>
            ) : (
              <>
                <label className="ritual-title-field">
                  <span>标题</span>
                  <input
                    type="text"
                    value={title}
                    disabled={disabled || session === null}
                    placeholder={displayTitle(kind, effectiveDate, null)}
                    onChange={(event) => handleTitleChange(event.target.value)}
                  />
                </label>
                <p className="ritual-hint">
                  类型与业务日期不可修改；标题、Folder 与正文可以编辑。
                </p>

                {compareSource !== null && targetRef !== null ? (
                  <RitualRestoreCompare
                    kind={kind}
                    journalDate={effectiveDate}
                    source={compareSource}
                    target={targetRef}
                    targetDraft={document}
                    disabled={disabled || compareBusy || busy}
                    error={compareError}
                    serverTarget={compareServerTarget}
                    onCancel={cancelCompare}
                    onReplace={(revision) => void replaceWithSource(revision)}
                    onCopy={(selection, insertAfter) => void copySelection(selection, insertAfter)}
                    onReload={() => void reloadCompare()}
                    right={(
                      <div className="ritual-editor ritual-editor--compare">
                        <RichTextEditor doc={document} readOnly={disabled} label={`${KIND_LABEL[kind]} 正文`}
                          onUserChange={handleBodyChange} />
                      </div>
                    )}
                  />
                ) : (
                  <div className="ritual-editor">
                    {session === null
                      ? <p className="ritual-state" role="status">正在准备编辑会话……</p>
                      : (
                        <RichTextEditor
                          doc={document}
                          readOnly={disabled}
                          label={`${KIND_LABEL[kind]} 正文`}
                          onUserChange={handleBodyChange}
                        />
                      )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default RitualPage
