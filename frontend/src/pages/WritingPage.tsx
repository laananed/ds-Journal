/**
 * 写作页（Stage 4 / S04-T06）。
 *
 * 产品与契约：`docs/stage4.md` §4 / §5 / §10，`docs/stage4-api.md` §3 / §10，
 * `docs/stage4-architecture.md` §4 / §4.1，`docs/stage4-tasks.md` §3.7。
 *
 * 这一页只做三件事：
 *
 * 1. **页面消费**：今日写作列表（当日 `writing`）、继续编辑、明确新建、状态显示；
 * 2. **会话复用**：保存、创建键、CAS、本地草稿全部走 T02 的
 *    `state/editSessions.ts` + `state/localJournalDrafts.ts` + `hooks/useEditSession.ts`，
 *    本页**没有**第二套写队列或第二套本地存储；
 * 3. **可发现的恢复入口**：本地未提交草稿列表、恢复/稍后/明确丢弃、
 *    服务器版本冲突时两侧并排保留，任何一步都必须用户点击。
 *
 * 明确的边界：
 * - **不改** `App.tsx` / 公共类型 / 编辑器核心 / T02 会话核心（见交付报告的接线差异）；
 * - 带 `content_blocks` 或没有 `content_doc` 的记录不在这里转换，交给既有旧编辑器
 *   （`onOpenLegacy`），原文与服务器字段都不动；
 * - 打开页面、切换草稿、读取列表都不会创建服务器记录：只有真实用户正文
 *   （`writingSavable`）才会触发首次 POST。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './WritingPage.css'
import { getAISettings } from '../api/ai'
import { JournalApiError, getJournal, listJournals } from '../api/journals'
import { getBusinessDay } from '../api/rituals'
import FolderSelect from '../components/FolderSelect'
import Pagination from '../components/Pagination'
import WritingAiPanel from '../components/WritingAiPanel'
import { DraftConflictView, LocalDraftPanel, type DraftAction, type DraftPanelItem } from '../components/WritingDraftRecovery'
import RichTextEditor, { type EditorSelectionInfo } from '../editor/RichTextEditor'
import { useEditSession, useJournalDraftMirror } from '../hooks/useEditSession'
import type { FlushResult } from '../hooks/useAutosave'
import type { AutoRange } from '../state/autoAi'
import {
  displayStatus,
  editSessionStore,
  localStateLabel,
  statusLabel,
  type DocumentDraft,
} from '../state/editSessions'
import { journalToDraft, journalToServerFile, journalTransport } from '../state/journalSession'
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
import type { ContentDocument } from '../types/document'
import type { AISettings } from '../types/ai'
import type { Journal, JournalPage } from '../types/journal'
import type { BusinessDay } from '../types/ritual'
import { nearestValidPage } from '../utils/pagination'
import { replayPendingCreate } from '../utils/pendingCreateReplay'
import {
  conflictHeadings,
  duplicateOfServer,
  formatBusinessDateLabel,
  hasUnsavedInput,
  idsWithLocalDrafts,
  isLegacyRecord,
  localDraftText,
  needsLocalDraft,
  newDraftId,
  newWritingDraft,
  pickResumableDraftId,
  planCandidate,
  userTextOf,
  writingDateFromBusinessDay,
  writingDraftIdForFile,
  writingListItems,
  writingSavable,
  writingSessionId,
  writingTooLong,
  type CandidatePlan,
  type ResumableSession,
} from '../utils/writingSession'

export interface WritingPageProps {
  /** 本标签身份；默认从 `sessionStorage` 解析，多标签各有独立草稿。 */
  tabId?: string
  /** 上层全局写锁（例如 AI 处理中）。 */
  disabled?: boolean
  onDirtyChange?: (dirty: boolean) => void
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  /** 旧格式记录交给既有旧编辑器；本页不强制转换、不改原文。 */
  onOpenLegacy?: (id: number) => void
  /**
   * 一次性「打开某篇」请求（今日概览的写作点击）。
   * 按 `key` 只消费一次：同一篇再次点击会带新 key，不会因为重渲染重复打开。
   */
  initialFile?: { id: number; key: number } | null
  onInitialFileConsumed?: () => void
}

/** 当前正在编辑的草稿身份（切页返回时按它取回同一个会话）。 */
type ActiveDraft = { draftId: string; tabId: string; startedAt: string }

/** 服务器版本冲突：来自当前会话保存，或来自本地草稿恢复。 */
type ConflictState =
  | { kind: 'session'; server: Journal }
  | { kind: 'record'; record: LocalJournalDraft; server: Journal }

function browserSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** 草稿开始的带时区时刻（Ritual 用，写作仅作记录）。 */
function nowStamp(): string {
  return new Date().toISOString()
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

function WritingPage({
  tabId: injectedTabId,
  disabled = false,
  onDirtyChange,
  onFlushReady,
  onOpenLegacy,
  initialFile = null,
  onInitialFileConsumed,
}: WritingPageProps) {
  const store = editSessionStore
  const transport = useMemo(() => journalTransport({ journalKind: 'writing' }), [])
  const tabId = useMemo(
    () => injectedTabId ?? resolveTabId(browserSessionStorage(), newLocalId()),
    [injectedTabId],
  )

  /* ---------------------------------------------------------- 业务日期 */
  const [businessDay, setBusinessDay] = useState<BusinessDay | null>(null)
  const [dayStatus, setDayStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [dayError, setDayError] = useState('')
  const [dayToken, setDayToken] = useState(0)

  /* ------------------------------------------------------------ 草稿 */
  const [active, setActive] = useState<ActiveDraft | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [legacy, setLegacy] = useState<Journal | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)

  /* ---------------------------------------------------------- 今日列表 */
  const [listPage, setListPage] = useState(1)
  const [list, setList] = useState<JournalPage | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [listToken, setListToken] = useState(0)

  /* -------------------------------------------------------- 本地草稿 */
  const [records, setRecords] = useState<LocalJournalDraft[]>([])
  const [draftError, setDraftError] = useState('')
  const [draftNotice, setDraftNotice] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [plans, setPlans] = useState<Record<string, CandidatePlan>>({})
  const [busyKeys, setBusyKeys] = useState<string[]>([])
  const serverCache = useRef(new Map<number, Journal>())

  const sessionId = active === null ? null : writingSessionId(active.draftId)
  const session = useEditSession(sessionId, store)

  /* ------------------------------------------------------ AI 设置（T09） */
  /**
   * 自动开关与预置只在设置页改；本页只**读取**，不写回。
   * 读不到设置时保持 `null`：面板会如实显示「状态未知」，
   * 手动 Go Deeper / Minds 仍可用（它们的默认预置不依赖设置）。
   */
  const [aiSettings, setAiSettings] = useState<AISettings | null>(null)
  const [aiSettingsToken, setAiSettingsToken] = useState(0)
  /** 编辑器当前选区（块 ID + 码点区间）；`null` 表示整篇评论。 */
  const [aiSelection, setAiSelection] = useState<AutoRange[] | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getAISettings(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setAiSettings(value)
    }).catch(() => {
      if (controller.signal.aborted) return
      setAiSettings(null)
    })
    return () => controller.abort()
  }, [aiSettingsToken])

  /**
   * 选区 → 评论范围。
   *
   * `onSelection` 已经给出**码点**区间（编辑器内部是 UTF-16，换算在 T03 完成），
   * 这里只做形状转换；空选区、跨块选区（`blockId === null`）都退回整篇，
   * 绝不猜一个「相近的文字」当锚点。
   */
  const onEditorSelection = useCallback((info: EditorSelectionInfo | null) => {
    if (info === null || info.empty || info.blockId === null || info.end <= info.start) {
      setAiSelection(null)
      return
    }
    setAiSelection([{ node_id: info.blockId, start: info.start, end: info.end }])
  }, [])

  // 换草稿/换会话时丢掉旧选区：范围属于某一篇正文，不跟着跨文件走。
  useEffect(() => { setAiSelection(null) }, [sessionId])

  const businessDate = writingDateFromBusinessDay(businessDay)

  /* ------------------------------------------------------ 读取业务日期 */
  useEffect(() => {
    const controller = new AbortController()
    getBusinessDay(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      if (writingDateFromBusinessDay(value) === '') {
        setDayError('服务端返回的业务日期不合法，暂时不能新建草稿。')
        setDayStatus('error')
        return
      }
      setBusinessDay(value)
      setDayStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setDayError(errorText(error, '读取业务日期失败，请稍后重试。'))
      setDayStatus('error')
    })
    return () => controller.abort()
  }, [dayToken])

  const resumableSessions = useCallback((): ResumableSession[] => store.listSessions().map((item) => ({
    draftId: item.draftId,
    tabId: item.tabId,
    type: item.type,
    fileId: item.fileId,
    date: item.draft.date,
    hasUnsavedInput: hasUnsavedInput(item),
    updatedAt: item.updatedAt,
  })), [store])

  /** 首次进入：恢复本标签同一草稿；只有「新建一篇」才换身份。 */
  useEffect(() => {
    if (dayStatus !== 'success' || active !== null) return
    const resumed = pickResumableDraftId(resumableSessions(), tabId, businessDate)
    setActive({
      draftId: resumed ?? newDraftId(newLocalId),
      tabId,
      startedAt: nowStamp(),
    })
  }, [active, businessDate, dayStatus, resumableSessions, tabId])

  /** 打开（或取回）会话。已存在的会话原样返回：草稿、在途请求与创建键都不动。 */
  useEffect(() => {
    if (active === null || businessDate === '') return
    store.openSession({
      sessionId: writingSessionId(active.draftId),
      type: 'journal',
      tabId: active.tabId,
      draftId: active.draftId,
      draft: newWritingDraft(businessDate),
      transport,
      isSavable: writingSavable,
    })
  }, [active, businessDate, store, transport])

  /* -------------------------------------------------------- 今日列表读取 */
  useEffect(() => {
    if (businessDate === '') return
    const controller = new AbortController()
    listJournals(businessDate, listPage, controller.signal, 'writing').then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setListPage(validPage)
        return
      }
      setList(data)
      setListStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setList(null)
      setListError(errorText(error, '读取今天的写作失败，请稍后重试。'))
      setListStatus('error')
    })
    return () => controller.abort()
  }, [businessDate, listPage, listToken])

  /* ------------------------------------------------------ 本地草稿读取 */
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

  const candidates = useMemo(() => sortCandidates(records), [records])

  /* ------------------------------------------------------------ 保存 */
  const inputSeq = session?.inputSeq ?? 0
  useEffect(() => {
    if (sessionId === null || inputSeq === 0) return
    const timer = setTimeout(() => {
      const current = store.getSession(sessionId)
      if (current === null) return
      if (current.status === 'conflict' || current.status === 'missing' || current.status === 'failed') return
      void store.saveToSequence(sessionId)
    }, 800)
    return () => clearTimeout(timer)
  }, [inputSeq, sessionId, store])

  const display = session === null ? null : displayStatus(session)
  const dirty = display !== null && display !== 'saved'

  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  useEffect(() => {
    if (onFlushReady === undefined) return
    if (sessionId === null) {
      onFlushReady(null)
      return
    }
    onFlushReady(async () => {
      const result = await store.flush([sessionId])
      const first = result[sessionId]
      if (first === undefined) return 'clean'
      return first.kind === 'blocked' ? 'blocked' : 'clean'
    })
    return () => onFlushReady(null)
  }, [onFlushReady, sessionId, store])

  /** 保存成功后只重读列表：不重发创建、不重发命令。 */
  const refreshedKey = useRef('')
  useEffect(() => {
    if (session === null || session.fileId === null || session.status !== 'saved') return
    const key = `${session.fileId}:${session.revision}`
    if (refreshedKey.current === key) return
    refreshedKey.current = key
    setListToken((value) => value + 1)
  }, [session])

  /* ------------------------------------------------ 本地草稿镜像（T02） */
  const mirror = useJournalDraftMirror({
    sessionId,
    tabId: active?.tabId ?? tabId,
    draftId: active?.draftId,
    journalKind: 'writing',
    draftStartedAt: active?.startedAt ?? '',
    enabled: active !== null && session !== null,
  })
  const flushLocalRef = useRef<() => void>(() => {})
  useEffect(() => { flushLocalRef.current = mirror.flushLocal }, [mirror])

  // 本机草稿刚落盘时立即刷新「本地草稿」入口：
  // 保存失败 / 未提交的输入要能马上被看见，而不是等用户手动打开面板。
  const mirrorLocalState = mirror.localState
  useEffect(() => {
    if (mirrorLocalState === 'saved') void reloadDrafts()
  }, [mirrorLocalState, reloadDrafts])

  /**
   * 离开页面（切页 / 换草稿 / 卸载）时：
   * 先尽力写一次本机草稿，再让应用级队列把未提交输入继续提交完。
   * 导航本身不等待网络——这与 T02「立即导航、保存继续」的语义一致。
   *
   * 只有**服务器还没确认**的输入才值得写：已确认的草稿再写一次，
   * 会让「本地草稿」入口把已保存内容误报成未提交草稿。
   */
  useEffect(() => {
    if (sessionId === null) return
    const leaving = sessionId
    return () => {
      const current = store.getSession(leaving)
      if (current !== null && needsLocalDraft(current)) flushLocalRef.current()
      if (current !== null && current.status !== 'saved') void store.saveToSequence(leaving)
    }
  }, [sessionId, store])

  /* ------------------------------------------------------------ 动作 */
  const change = useCallback((next: DocumentDraft, origin: 'user_input' | 'system' = 'user_input') => {
    if (sessionId === null) return
    store.changeSession(sessionId, next, origin)
  }, [sessionId, store])

  async function saveNow(): Promise<void> {
    if (sessionId === null) return
    setBusy(true)
    setNotice('')
    try {
      const result = await store.saveToSequence(sessionId)
      const current = store.getSession(sessionId)
      if (result.kind === 'blocked' && result.reason === 'conflict' && current !== null && current.fileId !== null) {
        await loadServerForSessionConflict(current.fileId)
      } else if (result.kind === 'blocked' && result.reason === 'missing') {
        setNotice('服务器上已经没有这篇（可能被移入回收箱）。你的输入仍保留，可以另存为新草稿。')
      }
    } finally {
      setBusy(false)
    }
  }

  async function loadServerForSessionConflict(fileId: number): Promise<void> {
    try {
      const server = await getJournal(fileId)
      serverCache.current.set(fileId, server)
      setConflict({ kind: 'session', server })
    } catch (error: unknown) {
      setNotice(`保存遇到版本冲突，但读取服务器版本失败：${errorText(error, '请稍后重试')}`)
    }
  }

  async function openExisting(id: number): Promise<void> {
    setBusy(true)
    setNotice('')
    setLegacy(null)
    try {
      if (sessionId !== null) void store.saveToSequence(sessionId)
      const detail = await getJournal(id)
      serverCache.current.set(id, detail)
      if (isLegacyRecord(detail)) {
        // 旧格式不自动转换：保留当前草稿身份，只把主区域切到旧格式说明。
        setLegacy(detail)
        return
      }
      const record = records.find((item) => item.file_id === id) ?? null
      if (record !== null && !duplicateOfServer(record, detail)) {
        // 本机还有未提交内容：先让用户在两侧之间选择，不直接用服务器内容覆盖。
        setConflict({ kind: 'record', record, server: detail })
        return
      }
      if (record !== null) {
        // 内容与服务器完全一致：只是「已保存但记录没来得及清理」的残影，
        // 没有任何需要保留的东西，直接按服务器版本打开，并清掉这份重复记录。
        await localDraftWriter.remove(record.tab_id, record.draft_id)
        await reloadDrafts()
      }
      const existingForFile = store.listSessions().find((item) => item.type === 'journal' && item.fileId === id) ?? null
      if (existingForFile !== null) {
        // 同一文件的会话已在本次会话中打开（draftId 未必是 journal:<id>）：
        // 直接切回，不动它的草稿、在途请求与创建键。
        setActive({ draftId: existingForFile.draftId, tabId, startedAt: nowStamp() })
        setNotice('这篇已在本次会话中打开，已切回该会话；未提交输入原样保留。')
        return
      }
      openServerSession(detail, journalToDraft(detail))
    } catch (error: unknown) {
      setNotice(`读取这篇写作失败：${errorText(error, '请稍后重试')}`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 概览的一次性「打开某篇」请求（`initialFile`）。
   *
   * 直接用**同一条** `openExisting` 路径（GET 详情 → 旧格式判定 → 本机草稿比对
   * → `openSession` 复用或打开），因此不存在「概览走一套、列表走另一套」的第二
   * 实现；也不会在这里另建会话或另发写请求。
   *
   * 用 `key` 而不是 `id` 判重：同一篇再次点击会带新的 key，能重新打开；
   * 重渲染不会重复触发。业务日期未就绪时不消费（等它就绪再执行）。
   */
  const openExistingRef = useRef<((id: number) => Promise<void>) | null>(null)
  useEffect(() => {
    openExistingRef.current = openExisting
  })
  const consumedInitialKey = useRef(0)
  useEffect(() => {
    if (initialFile === null) return
    if (dayStatus !== 'success') return
    if (consumedInitialKey.current === initialFile.key) return
    consumedInitialKey.current = initialFile.key
    void openExistingRef.current?.(initialFile.id)
    onInitialFileConsumed?.()
  }, [dayStatus, initialFile, onInitialFileConsumed])

  function startNew(): void {
    if (sessionId !== null) void store.saveToSequence(sessionId)
    setNotice('')
    setLegacy(null)
    setConflict(null)
    setActive({ draftId: newDraftId(newLocalId), tabId, startedAt: nowStamp() })
  }

  /* -------------------------------------------------- 本地草稿处置 */
  function markBusy(key: string, on: boolean): void {
    setBusyKeys((current) => (on
      ? Array.from(new Set([...current, key]))
      : current.filter((item) => item !== key)))
  }

  async function probe(record: LocalJournalDraft): Promise<CandidatePlan> {
    if (record.file_id === null) return planCandidate(record, null)
    let probeResult: ServerDraftProbe
    try {
      const detail = await getJournal(record.file_id)
      serverCache.current.set(record.file_id, detail)
      probeResult = { state: 'ok', revision: detail.revision, softDeleted: detail.deleted_at !== null }
    } catch (error: unknown) {
      probeResult = error instanceof JournalApiError && error.status === 404
        ? { state: 'missing' }
        : { state: 'unreadable', message: errorText(error, '读取服务器版本失败') }
    }
    return planCandidate(record, probeResult)
  }

  function recordDraft(record: LocalJournalDraft, server: Journal | null): DocumentDraft {
    return {
      title: record.title,
      content_doc: record.content_doc,
      // 已存在文件时用服务器日期，避免恢复时顺手改掉业务日期。
      date: server === null ? record.business_date : server.journal_date,
      folder_id: record.folder_id,
    }
  }

  /**
   * 以服务器文件为准打开会话，并把 active 指到**返回的会话**。
   *
   * T02 的 `openSession` 会复用同一文件的既有会话（它可能在更早的 draftId 下创建，
   * 例如这篇就是在本页新建的），且复用时**绝不覆盖草稿**。所以：
   * - active 必须用返回会话的 draftId，否则挂载 effect 会另开一个空会话、编辑器被清空；
   * - 复用的会话里若有更新的未提交输入，不能拿目标内容盖掉它（不做静默覆盖）。
   */
  function openServerSession(server: Journal, draft: DocumentDraft): { draftId: string; keptNewerInput: boolean } {
    const opened = store.openSession({
      sessionId: writingSessionId(writingDraftIdForFile(server.id)),
      type: 'journal',
      tabId,
      draftId: writingDraftIdForFile(server.id),
      draft,
      file: { id: server.id, revision: server.revision, draft: journalToDraft(server) },
      transport,
      isSavable: writingSavable,
    })
    const keptNewerInput = needsLocalDraft(opened)
    if (!keptNewerInput) {
      // 复用既有会话时 openSession 不覆盖草稿；会话没有未确认输入时，
      // 才把目标内容以 system 来源放回去（内容相同时 changeSession 是 no-op）。
      store.changeSession(opened.sessionId, draft, 'system')
    }
    setActive({ draftId: opened.draftId, tabId, startedAt: nowStamp() })
    return { draftId: opened.draftId, keptNewerInput }
  }

  function openRecordSession(record: LocalJournalDraft, server: Journal): void {
    const opened = openServerSession(server, recordDraft(record, server))
    setRecoveryOpen(false)
    setConflict(null)
    setDraftNotice(opened.keptNewerInput
      ? '这篇会话里还有未提交的新输入，已原样保留；本机草稿仍在「本地草稿」里，可稍后对照。'
      : '已把本地内容放回编辑器（基于服务器当前版本）。确认无误后按「立即保存」提交。')
  }

  function openFreshRecord(record: LocalJournalDraft): void {
    const draftId = record.draft_id
    store.openSession({
      sessionId: writingSessionId(draftId),
      type: 'journal',
      tabId: record.tab_id,
      draftId,
      draft: recordDraft(record, null),
      transport,
      isSavable: writingSavable,
    })
    setActive({ draftId, tabId: record.tab_id, startedAt: record.draft_started_at })
    setRecoveryOpen(false)
    setDraftNotice('已恢复这份草稿；还没有提交到服务器，继续写会自动保存。')
  }

  function openAsNewDraft(record: LocalJournalDraft): void {
    if (businessDate === '') {
      setDraftNotice('业务日期未就绪，暂时不能另存为新草稿。')
      return
    }
    const draftId = newDraftId(newLocalId)
    const id = writingSessionId(draftId)
    store.openSession({
      sessionId: id,
      type: 'journal',
      tabId,
      draftId,
      draft: newWritingDraft(businessDate),
      transport,
      isSavable: writingSavable,
    })
    // 以 system 来源落到新会话：会保存新记录，但不会被当成用户新输入触发自动 AI。
    store.changeSession(id, { ...recordDraft(record, null), date: businessDate }, 'system')
    setActive({ draftId, tabId, startedAt: nowStamp() })
    setRecoveryOpen(false)
    setConflict(null)
    setDraftNotice('已另存为一份新草稿，正在提交为新的服务器记录；原本地记录仍保留。')
  }

  /**
   * 「恢复原请求」：同键、同首次 payload 重放创建，再在同一会话 PATCH 最新输入。
   *
   * 全部实现细节在 `utils/pendingCreateReplay.ts`（只消费 T02 已公开的会话接口）；
   * 这一层只负责把结果落到页面上：成功就切到那个会话，失败就如实说明并保留草稿。
   */
  async function replayRecord(record: LocalJournalDraft): Promise<void> {
    const result = await replayPendingCreate({
      record,
      store,
      transport,
      tabId: record.tab_id,
      isSavable: writingSavable,
    })
    if (result.kind === 'refused') {
      setDraftNotice(result.message)
      await reloadDrafts()
      return
    }
    setActive({ draftId: result.draftId, tabId: record.tab_id, startedAt: record.draft_started_at })
    setRecoveryOpen(false)
    setConflict(null)
    setLegacy(null)
    setDraftNotice(result.message)
    setListToken((value) => value + 1)
    await reloadDrafts()
  }

  async function discardRecord(record: LocalJournalDraft): Promise<void> {
    const result = await localDraftWriter.remove(record.tab_id, record.draft_id)
    await reloadDrafts()
    if (!result.ok) {
      setDraftError(result.message)
      return
    }
    setDraftNotice('已丢弃这份本地草稿。')
    if (active !== null && active.draftId === record.draft_id && record.file_id === null) {
      store.closeSession(writingSessionId(record.draft_id))
      setActive({ draftId: newDraftId(newLocalId), tabId, startedAt: nowStamp() })
    }
  }

  async function onDraftAction(candidate: DraftCandidate, action: DraftAction): Promise<void> {
    const record = records.find((item) => item.draft_id === candidate.draft_id && item.tab_id === candidate.tab_id)
    if (record === undefined) {
      setDraftError('这份本机草稿已不存在，请刷新。')
      await reloadDrafts()
      return
    }
    if (action === 'later') {
      setRecoveryOpen(false)
      setDraftNotice('已稍后处理；草稿仍保留在本机，可随时再打开这个入口。')
      return
    }
    if (action === 'discard') {
      await discardRecord(record)
      return
    }

    markBusy(candidate.key, true)
    try {
      const plan = plans[candidate.key] ?? await probe(record)
      setPlans((current) => ({ ...current, [candidate.key]: plan }))
      if (action === 'saveAsNew') {
        openAsNewDraft(record)
        return
      }
      if (action === 'replayOriginal') {
        await replayRecord(record)
        return
      }
      const server = record.file_id === null ? null : serverCache.current.get(record.file_id) ?? null
      switch (plan.kind) {
        case 'fresh':
          openFreshRecord(record)
          return
        case 'editable':
          if (server === null) {
            setDraftNotice('服务器版本已读取，但内容缓存丢失，请重试。')
            return
          }
          openRecordSession(record, server)
          return
        case 'conflict':
          if (server === null) {
            setDraftNotice('服务器版本已读取，但内容缓存丢失，请重试。')
            return
          }
          // 两侧内容完全一致时没有必要让用户取舍：直接按服务器版本继续编辑。
          if (duplicateOfServer(record, server)) {
            openRecordSession(record, server)
            return
          }
          setConflict({ kind: 'record', record, server })
          setRecoveryOpen(false)
          return
        case 'server_missing':
          setDraftNotice('服务器上已经不存在这篇（可能在回收箱）。本地内容保留，可以另存为新草稿或稍后处理。')
          return
        case 'replay_pending':
          setDraftNotice('这份草稿的创建结果未确认。请用「恢复原请求」按原创建键重放，或「另存为新草稿」另建一篇；两者不会同时发生。')
          return
        default:
          setDraftNotice(plan.kind === 'server_unreadable' ? `暂时读不到服务器版本：${plan.message}` : '暂时无法恢复这份草稿。')
      }
    } finally {
      markBusy(candidate.key, false)
    }
  }

  /* ------------------------------------------------------ 冲突处置 */
  async function keepLocalSessionConflict(): Promise<void> {
    if (conflict === null || conflict.kind !== 'session' || sessionId === null) return
    store.resolveKeepLocal(sessionId, journalToServerFile(conflict.server))
    setConflict(null)
    setNotice('已保留你的草稿并基于服务器当前版本，正在提交……')
    await store.saveToSequence(sessionId)
  }

  function takeServerSessionConflict(): void {
    if (conflict === null || conflict.kind !== 'session' || sessionId === null) return
    store.resolveTakeServer(sessionId, journalToServerFile(conflict.server))
    setConflict(null)
    setNotice('已采用服务器版本；本地草稿已被这份服务器内容替换。')
  }

  function keepLocalRecordConflict(): void {
    if (conflict === null || conflict.kind !== 'record') return
    openRecordSession(conflict.record, conflict.server)
  }

  function takeServerRecordConflict(): void {
    if (conflict === null || conflict.kind !== 'record') return
    const server = conflict.server
    const opened = openServerSession(server, journalToDraft(server))
    setConflict(null)
    setDraftNotice(opened.keptNewerInput
      ? '这篇会话里还有未提交的新输入，已原样保留；本机那份草稿仍在「本地草稿」里。'
      : '已采用服务器版本；本机那份草稿仍保留在「本地草稿」里，可稍后对照或丢弃。')
  }

  /* ------------------------------------------------------------ 渲染 */
  const today = writingListItems(list, businessDate)
  const localIds = useMemo(() => idsWithLocalDrafts(candidates), [candidates])
  const writingCandidates = useMemo(
    () => candidates.filter((item) => item.journal_kind === 'writing'),
    [candidates],
  )
  /**
   * 未取得服务器身份的记录**不需要探测**就能定性（`planCandidate` 只看记录本身）。
   * 这里预置它们的计划，让「创建未确认」的草稿一打开面板就显示「恢复原请求」，
   * 而不是先点一次「恢复」才暴露真正的动作；已有文件 id 的记录仍要等真实探测。
   */
  useEffect(() => {
    setPlans((current) => {
      let changed = false
      const next = { ...current }
      for (const record of records) {
        if (record.file_id !== null) continue
        const key = draftRecordKey(record.tab_id, record.draft_id)
        if (next[key] !== undefined) continue
        next[key] = planCandidate(record, null)
        changed = true
      }
      return changed ? next : current
    })
  }, [records])
  const panelItems: DraftPanelItem[] = writingCandidates.map((candidate) => ({
    candidate,
    plan: plans[candidate.key] ?? null,
    busy: busyKeys.includes(candidate.key),
  }))
  const selectedFileId = session?.fileId ?? null
  const locked = disabled || busy
  const savable = session !== null && writingSavable(session.draft)
  const tooLong = session !== null && writingTooLong(session.draft)
  /** 用户投影文本 U（不含 AI/系统节点）：AI 增量、去重与 apply 前置条件都用它。 */
  const draftUserText = session === null ? '' : userTextOf(session.draft.content_doc)

  return (
    <section className="writing-page" aria-label="写作">
      <header className="writing-head">
        <div>
          <p className="writing-eyebrow">写作</p>
          <h2 className="writing-title">
            {businessDate === '' ? '今天' : formatBusinessDateLabel(businessDate)}
          </h2>
          <p className="writing-sub">普通日记，不限篇数 · 每天 04:00 换日（Asia/Shanghai）</p>
        </div>
        <div className="writing-head-actions">
          <button type="button" className="writing-primary" disabled={locked || dayStatus !== 'success'} onClick={startNew}>
            新建一篇
          </button>
          <button type="button" aria-expanded={recoveryOpen} onClick={() => {
            setRecoveryOpen((open) => !open)
            void reloadDrafts()
          }}>
            本地草稿（{writingCandidates.length}）
          </button>
        </div>
      </header>

      {notice !== '' && <p className="writing-notice" role="status">{notice}</p>}

      {!recoveryOpen && writingCandidates.length > 0 && (
        <div className="writing-recovery-callout" role="status">
          <p>本机还有 {writingCandidates.length} 份未提交的草稿（不含服务器已保存的内容）。</p>
          <p className="writing-hint">可以打开列表选择恢复、稍后处理或明确丢弃；不做选择时不会有任何自动写入。</p>
          <button type="button" onClick={() => { setRecoveryOpen(true); void reloadDrafts() }}>
            查看本地草稿
          </button>
        </div>
      )}

      {recoveryOpen && (
        <LocalDraftPanel
          items={panelItems}
          currentTabId={tabId}
          error={draftError}
          notice={draftNotice}
          disabled={locked}
          onAction={(candidate, action) => { void onDraftAction(candidate, action) }}
          onClose={() => setRecoveryOpen(false)}
          onClearAll={() => { void (async () => {
            const result = await localDraftWriter.clearAll()
            await reloadDrafts()
            setDraftNotice(result.ok ? '已清空本应用的本地草稿。' : result.message)
            setPlans({})
          })() }}
        />
      )}

      {conflict !== null && conflict.kind === 'session' && session !== null && (
        <DraftConflictView
          title="这篇写作的服务器版本已变化"
          localHeading={conflictHeadings(session.revision, conflict.server.revision).local}
          localText={userTextOf(session.draft.content_doc)}
          localMeta={`未提交的本地输入 · 标题「${session.draft.title === '' ? '无' : session.draft.title}」`}
          serverHeading={conflictHeadings(session.revision, conflict.server.revision).server}
          serverText={conflict.server.content}
          serverMeta={`${conflict.server.display_title} · 版本 ${conflict.server.revision}`}
          keepLocalLabel="保留我的草稿并提交"
          takeServerLabel="采用服务器版本"
          busy={busy}
          onKeepLocal={() => { void keepLocalSessionConflict() }}
          onTakeServer={takeServerSessionConflict}
          onLater={() => { setConflict(null); setNotice('已稍后处理；服务器与本地内容都保留。') }}
        />
      )}

      {conflict !== null && conflict.kind === 'record' && (
        <DraftConflictView
          title="本机草稿与服务器版本不一致"
          localHeading={conflictHeadings(conflict.record.base_revision, conflict.server.revision).local}
          localText={localDraftText(conflict.record)}
          localMeta={`本机草稿 · 输入序号 ${conflict.record.input_seq}`}
          serverHeading={conflictHeadings(conflict.record.base_revision, conflict.server.revision).server}
          serverText={conflict.server.content}
          serverMeta={`${conflict.server.display_title} · 版本 ${conflict.server.revision}`}
          keepLocalLabel="保留我的草稿（基于服务器版本）"
          takeServerLabel="采用服务器版本"
          busy={busy}
          onKeepLocal={keepLocalRecordConflict}
          onTakeServer={takeServerRecordConflict}
          onLater={() => { setConflict(null); setDraftNotice('已稍后处理；本地草稿仍保留。') }}
        />
      )}

      <div className="writing-layout">
        <aside className="writing-side" aria-label="今天的写作">
          <div className="writing-side-head">
            <h3>今天</h3>
            <p>{listStatus === 'success' ? `共 ${today.total} 篇` : ''}</p>
          </div>
          {listStatus === 'loading' && <p className="writing-state" role="status">正在读取今天的写作……</p>}
          {listStatus === 'error' && (
            <div className="writing-state writing-state-error" role="alert">
              <p>读取今天写作失败：{listError}</p>
              <p className="writing-hint">重试只会重新读取，不会创建或修改任何文件。</p>
              <button type="button" disabled={locked} onClick={() => { setListStatus('loading'); setListError(''); setListToken((value) => value + 1) }}>重新读取</button>
            </div>
          )}
          {listStatus === 'success' && today.items.length === 0 && (
            <p className="writing-state">今天还没有写作。写下第一句就会创建，空白不会产生记录。</p>
          )}
          {listStatus === 'success' && today.items.length > 0 && (
            <ul className="writing-items">
              {today.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`writing-item${selectedFileId === item.id ? ' is-current' : ''}`}
                    aria-current={selectedFileId === item.id ? 'true' : undefined}
                    disabled={locked}
                    onClick={() => { void openExisting(item.id) }}
                  >
                    <span className="writing-item-title">{item.displayTitle}</span>
                    {item.preview !== '' && <span className="writing-item-preview">{item.preview}</span>}
                    <span className="writing-item-meta">
                      版本 {item.revision}
                      {localIds.has(item.id) ? ' · 本机有未提交草稿' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listStatus === 'success' && today.total > 0 && (
            <Pagination page={today.page} total={today.total} hasNext={today.hasNext}
              onPageChange={(value) => { setListStatus('loading'); setListPage(value); setListToken((token) => token + 1) }}
              disabled={locked} label="今天写作分页" />
          )}
          {today.hasNext && <p className="writing-hint">还有更多写作在下一页。</p>}
        </aside>

        <div className="writing-main">
          {dayStatus === 'loading' && <p className="writing-state" role="status">正在读取业务日期……</p>}
          {dayStatus === 'error' && (
            <div className="writing-state writing-state-error" role="alert">
              <p>{dayError}</p>
              <p className="writing-hint">业务日期由服务端按固定时区计算；读取失败时不会用本机时钟猜一个日期，也不会创建草稿。</p>
              <button type="button" onClick={() => { setDayStatus('loading'); setDayError(''); setDayToken((value) => value + 1) }}>重新读取</button>
            </div>
          )}

          {legacy !== null && (
            <section className="writing-legacy" aria-label="旧格式记录">
              <h3>这篇仍是旧格式</h3>
              <p>
                它带有旧的正文块或还没有 JSON 正文。为了不改变作者身份和检查点，
                这里不自动转换、也不删除原文；可以继续用旧编辑器打开。
              </p>
              <div className="writing-legacy-actions">
                {onOpenLegacy !== undefined && (
                  <button type="button" className="writing-primary" onClick={() => onOpenLegacy(legacy.id)}>
                    用旧编辑器打开
                  </button>
                )}
                <button type="button" onClick={() => setLegacy(null)}>回到今天的草稿</button>
              </div>
            </section>
          )}

          {legacy === null && dayStatus === 'success' && session === null && (
            <p className="writing-state" role="status">正在准备草稿……</p>
          )}

          {legacy === null && session !== null && (
            <>
              <div className={`writing-status writing-status-${display ?? 'saved'}`} role="status" aria-live="polite">
                <span className="writing-status-label">
                  {session.fileId === null && (display === 'saved' || display === 'unsaved')
                    ? '还没有保存到服务器'
                    : statusLabel(display ?? 'saved')}
                </span>
                <span className="writing-status-hint">
                  {display === 'conflict' || display === 'failed' || display === 'missing'
                    ? session.error
                    : session.fileId === null
                      ? '写下正文后自动创建；空白草稿不会产生服务器记录。'
                      : `文件 #${session.fileId} · 版本 ${session.revision ?? 0}`}
                </span>
                <span className="writing-status-local">{localStateLabel(session.localState)}</span>
                {display === 'failed' && (
                  <button type="button" disabled={locked} onClick={() => { void store.retry(sessionId as string) }}>重试保存</button>
                )}
                {display === 'conflict' && session.fileId !== null && (
                  <button type="button" disabled={locked}
                    onClick={() => { void loadServerForSessionConflict(session.fileId as number) }}>
                    对照服务器版本
                  </button>
                )}
                {display === 'missing' && (
                  <button type="button" disabled={locked} onClick={() => {
                    const record = records.find((item) => item.file_id === session.fileId)
                    if (record !== undefined) openAsNewDraft(record)
                    else setNotice('服务器上已没有这篇；本地输入仍在编辑器里，可以复制到新草稿。')
                  }}>另存为新草稿</button>
                )}
              </div>

              <div className="writing-editor">
                <label className="writing-field">
                  <span>标题（可留空）</span>
                  <input
                    type="text"
                    value={session.draft.title}
                    disabled={locked}
                    placeholder="给今天起个标题，也可以留空"
                    onChange={(event) => change({ ...session.draft, title: event.target.value })}
                  />
                </label>
                <label className="writing-field">
                  <span>日期</span>
                  <input
                    type="date"
                    value={session.draft.date}
                    disabled={locked}
                    onChange={(event) => change({ ...session.draft, date: event.target.value })}
                  />
                </label>
                <div className="writing-field">
                  <span>正文</span>
                  <div
                    onCompositionStart={() => { if (sessionId !== null) store.setComposing(sessionId, true) }}
                    onCompositionEnd={() => { if (sessionId !== null) store.setComposing(sessionId, false) }}
                  >
                    <RichTextEditor
                      doc={session.draft.content_doc as ContentDocument | null}
                      readOnly={locked}
                      label="写作正文"
                      onUserChange={(document) => change({ ...session.draft, content_doc: document })}
                      onSelection={onEditorSelection}
                    />
                  </div>
                </div>
                <FolderSelect value={session.draft.folder_id} disabled={locked}
                  onChange={(folderId) => change({ ...session.draft, folder_id: folderId })} />
                {tooLong && (
                  <p className="writing-hint" role="alert">
                    正文超过 50,000 个字符（按 Unicode 码点），暂不提交；内容仍保留在编辑器里。
                  </p>
                )}
                {!savable && !tooLong && (
                  <p className="writing-hint" role="status">空白正文不会提交，也不会创建空记录。</p>
                )}
                <div className="writing-actions">
                  <button type="button" className="writing-primary"
                    disabled={locked || !dirty || !savable}
                    onClick={() => { void saveNow() }}>
                    立即保存
                  </button>
                  <button type="button" disabled={locked} onClick={startNew}>新建一篇</button>
                </div>
              </div>

              {/*
                AI 写作面板（T09）。
                这里**不把 `locked` 传给它**：`locked` 含本页 `busy`（保存动作中），
                而 AI 的「在途」语义明确允许继续写、允许切页。
                只有页面级全局写锁 `disabled` 会禁用入口。
              */}
              <WritingAiPanel
                sessionId={sessionId}
                fileId={session.fileId}
                userText={draftUserText}
                editorDocument={session.draft.content_doc}
                saved={display === 'saved'}
                userInputSeq={session.userInputSeq}
                composing={session.imeComposing}
                settings={aiSettings}
                selection={aiSelection}
                disabled={disabled}
                store={store}
                onNotice={setNotice}
                onReloadSettings={() => setAiSettingsToken((value) => value + 1)}
              />
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** 标题区的业务日期显示（与列表同一口径）。 */
export default WritingPage
