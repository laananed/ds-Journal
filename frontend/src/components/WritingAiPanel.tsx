/**
 * 写作 AI 面板：Go Deeper 与 Minds Comments 的手动/自动入口（Stage 4 / S04-T09）。
 *
 * 权威依据：
 * - `docs/stage4-api.md` §7（prepare / execute / apply 三段、同 ID 只执行一次、
 *   apply 在保存屏障之后、占位仍在且调用边界之前的 U 未变）、§8（两个自动开关与
 *   15s/80 码点/60s）、§10（FileMutation 与较新草稿的窄 effects）；
 * - `docs/stage4-architecture.md` §7.1～§7.3；
 * - `docs/stage4-tasks.md` §3.10（AI 期间可续写与切页、迟到结果不跳转、不锁导航）。
 *
 * 三条本组件严格遵守的规则：
 *
 * 1. **不锁导航、不锁编辑**：AI 在途时用户继续写、切页都合法（与 Stage 3 的
 *    `AiWritingActions` 处理中锁不同——那是旧 `POST /api/ai/local` 的路径）。
 * 2. **execute 在写队列之外**：上游调用期间不占文件队列，保存可以继续；
 *    prepare 与 apply 才进入队列（各自是短事务 + 保存屏障）。
 * 3. **迟到结果只做窄应用**：apply 由会话的 `applyFileMutation` 处理，
 *    新占位按「纯插入」合并、评论只增 Mark，绝不整篇回填覆盖较新输入，
 *    也绝不因为结果回来就切换页面。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './WritingAiPanel.css'
import {
  AiApiError,
  applyAIWriting,
  deleteAIComment,
  executeAIWriting,
  getAIRequest,
  listAIComments,
  prepareAIWriting,
} from '../api/ai'
import MindsSidebar from './MindsSidebar'
import {
  editSessionStore,
  type EditSessionStore,
  type FileMutation,
} from '../state/editSessions'
import { journalToDraft } from '../state/journalSession'
import {
  addWritingEntry,
  decideRecovery,
  defaultMessage,
  mergeWritingDetail,
  phaseLabel,
  readWritingIndex,
  removeWritingEntry,
  writeWritingIndex,
  type StorageLike,
  type WritingRecoveryEntry,
  type WritingRequestKind,
  type WritingRequestRecord,
} from '../state/writingRequests'
import {
  AUTO_AI_CONFIG,
  MIND_PRESET_IDS,
  createAutoFileState,
  evaluateAuto,
  noteChange,
  noteScheduled,
  noteSettled,
  syncSettings,
  type AutoAiSettings,
  type AutoRange,
  type MindPresetId,
} from '../state/autoAi'
import { newRequestId } from '../utils/aiRequestState'
import type { AIComment, AIRequestDetail, AIRequestStatus, AIWritingMutation, AINoopResponse } from '../types/ai'
import type { Journal } from '../types/journal'

export interface WritingAiPanelProps {
  /** 会话身份；为空表示还没有会话（不能调用 AI）。 */
  sessionId: string | null
  /** 服务器文件 ID；`null` 说明这篇还没有保存成功。 */
  fileId: number | null
  /** 当前用户投影文本 U（不含 AI/系统节点）。 */
  userText: string
  /** 当前文档 JSON（自动范围与增量依据）。命名避开全局 `document`。 */
  editorDocument: unknown
  /** 最新输入已经保存成功且没有在途保存。 */
  saved: boolean
  /** 会话的用户输入序号；只有它前进才算真实用户输入。 */
  userInputSeq: number
  /** IME 组合中（组合结束前不调度）。 */
  composing?: boolean
  /** 设置里的自动开关与预置；`null` 表示还没读到设置。 */
  settings: AutoAiSettings | null
  /** 用户当前选中的范围（文件/选区评论）；`null` 表示整篇。 */
  selection?: AutoRange[] | null
  disabled?: boolean
  store?: EditSessionStore
  /** 顶层面板提示（保存失败等）。 */
  onNotice?: (message: string) => void
  /** 重新读取设置（用户刚在设置页改了开关时用）。 */
  onReloadSettings?: () => void
  storage?: StorageLike | null
  /** 页面可见性（默认读 document.visibilityState）。 */
  visible?: boolean
}

function browserStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

function isNoop(value: AIWritingMutation | AINoopResponse): value is AINoopResponse {
  return (value as AINoopResponse).status === 'noop'
}

/** 后端文件详情数组 → 会话可应用的 FileMutation（effects 原样来自后端）。 */
function toMutation(files: Journal[], effects: FileMutation['effects'], requestId: string | null): FileMutation {
  return {
    files: files.map((file) => ({
      type: 'journal' as const,
      file: { id: file.id, revision: file.revision, draft: journalToDraft(file) },
    })),
    effects,
    request_id: requestId,
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

function statusOf(error: unknown): number | null {
  return error instanceof AiApiError ? error.status : null
}

function WritingAiPanel({
  sessionId,
  fileId,
  userText,
  editorDocument,
  saved,
  userInputSeq,
  composing = false,
  settings,
  selection = null,
  disabled = false,
  store = editSessionStore,
  onNotice,
  onReloadSettings,
  storage,
  visible,
}: WritingAiPanelProps) {
  const [record, setRecord] = useState<WritingRequestRecord | null>(null)
  const [comments, setComments] = useState<AIComment[]>([])
  const [commentsError, setCommentsError] = useState('')
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsPage, setCommentsPage] = useState(1)
  const [commentsTotal, setCommentsTotal] = useState(0)
  const [commentsHasNext, setCommentsHasNext] = useState(false)
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState('')
  const [presets, setPresets] = useState<MindPresetId[]>(settings?.mind_preset_ids ?? ['gentle_reflection'])
  const [notice, setNotice] = useState('')
  const [autoStatus, setAutoStatus] = useState('')
  const [tickToken, setTickToken] = useState(0)
  /**
   * 最近一次从服务端读到的**原始**状态。
   *
   * `phase` 是给界面看的粗粒度值；`prepared` 与 `pending` 都会映射成 `running`，
   * 但只有 `prepared`（已登记、从未执行）才允许用同一个 request_id 继续执行。
   */
  const [lastStatus, setLastStatus] = useState<AIRequestStatus | null>(null)

  /** 重入守卫用 ref（回调里读不会过期）；同步维护一份 state 供渲染使用。 */
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const mountedRef = useRef(true)
  const autoRef = useRef<ReturnType<typeof createAutoFileState> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ userText, editorDocument, saved, composing, fileId })
  const indexRef = useRef<WritingRecoveryEntry[]>(readWritingIndex(storage ?? browserStorage()))

  useEffect(() => {
    latestRef.current = { userText, editorDocument, saved, composing, fileId }
  })

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const markBusy = useCallback((on: boolean) => {
    busyRef.current = on
    if (mountedRef.current) setBusy(on)
  }, [])

  // 设置里的预置集合变化时跟随（用户可能刚在设置页改过）。
  useEffect(() => {
    if (settings === null) return
    setPresets(settings.mind_preset_ids)
  }, [settings])

  const persistIndex = useCallback((next: WritingRecoveryEntry[]) => {
    indexRef.current = next
    writeWritingIndex(storage ?? browserStorage(), next)
  }, [storage])

  const notify = useCallback((message: string) => {
    setNotice(message)
    onNotice?.(message)
  }, [onNotice])

  /* ------------------------------------------------ 应用级请求恢复入口 */

  /**
   * 切回这一篇时把**上次没处理完**的请求重新显示出来。
   *
   * 索引在发请求之前就写进本地存储（`persistIndex`），所以「进程被杀 / 切页 /
   * 关标签」之后仍能按 ID 查回真实状态。这里只把入口摆出来，**不自动重发**：
   * `phase` 一律先按 `unknown` 处理并要求用户点「查询状态」，因为离开时
   * 无法知道模型是否已经调用过（存在已计费的可能）。
   */
  const hydratedFileRef = useRef<number | null>(null)
  useEffect(() => {
    if (fileId === null) {
      hydratedFileRef.current = null
      setRecord(null)
      return
    }
    if (hydratedFileRef.current === fileId) return
    hydratedFileRef.current = fileId
    const entries = indexRef.current.filter((item) => item.fileId === fileId)
    const latest = entries[entries.length - 1]
    if (latest === undefined) {
      // 换到另一篇：上一篇的结果不属于这一篇，不能留着误导。
      setRecord(null)
      setLastStatus(null)
      return
    }
    setRecord({
      requestId: latest.requestId,
      kind: latest.kind,
      fileId: latest.fileId,
      phase: 'unknown',
      message: '上次离开时这次请求还没有结果（可能已消耗 Token）。请先「查询状态」，不会自动重发。',
      mayHaveCharged: true,
      startedAt: 0,
      updatedAt: 0,
      applied: false,
    })
    setLastStatus(null)
  }, [fileId])

  /* ------------------------------------------------------ 评论读取 */

  const reloadComments = useCallback(async (page = 1) => {
    if (fileId === null) return
    setCommentsLoading(true)
    setCommentsError('')
    try {
      const data = await listAIComments(fileId, page)
      if (!mountedRef.current) return
      setComments(data.items)
      setCommentsPage(data.page)
      setCommentsTotal(data.total)
      setCommentsHasNext(data.has_next)
    } catch (error: unknown) {
      if (!mountedRef.current) return
      setCommentsError(errorText(error, '读取评论失败，请稍后重试'))
    } finally {
      if (mountedRef.current) setCommentsLoading(false)
    }
  }, [fileId])

  useEffect(() => {
    setComments([])
    setCommentsTotal(0)
    setCommentsPage(1)
    if (fileId !== null) void reloadComments(1)
  }, [fileId, reloadComments])

  /* ------------------------------------------------- 自动调度状态机 */

  useEffect(() => {
    if (settings === null || fileId === null) return
    const key = `journal:${fileId}`
    const current = autoRef.current
    if (current === null || current.fileKey !== key) {
      // 打开文件/会话：记录调度基线，已有旧文不算新输入。
      autoRef.current = createAutoFileState({
        fileKey: key, settings, userText, document: editorDocument, now: Date.now(),
      })
      return
    }
    // 开关从关到开会重建基线；设置变化本身不触发请求。
    autoRef.current = syncSettings(current, settings, { userText, document: editorDocument })
  }, [editorDocument, fileId, settings, userText])

  // 只有真实用户输入序号前进才算「用户输入」；系统写入（载入/AI 回写/模板/恢复）
  // 不会走到这里，因此不会形成付费循环。
  useEffect(() => {
    const state = autoRef.current
    if (state === null || userInputSeq === 0) return
    autoRef.current = noteChange(state, {
      origin: 'user_input',
      userText: latestRef.current.userText,
      document: latestRef.current.editorDocument,
      now: Date.now(),
      composing: latestRef.current.composing,
    })
  }, [userInputSeq])

  /* ------------------------------------------------------- 主流程 */

  /**
   * 应用一条**已就绪**的结果（队列内，窄应用）。
   *
   * 只有 apply 进队列：它需要「先保存最新输入，再按 base_revision 比对」的屏障。
   * 失败时不重发、不改草稿，结果仍留在服务端请求记录里。
   */
  const applyReady = useCallback(async (
    requestId: string,
    kind: WritingRequestKind,
  ): Promise<boolean> => {
    if (sessionId === null) return false
    try {
      await store.runFileCommand(sessionId, async () => {
        const session = store.getSession(sessionId)
        if (session === null || session.revision === null) throw new Error('会话已关闭')
        const mutation = await applyAIWriting(requestId, session.revision)
        return toMutation(mutation.files, mutation.effects, requestId)
      })
      persistIndex(removeWritingEntry(indexRef.current, requestId))
      if (kind === 'minds_comments') {
        void reloadComments(commentsPage)
        notify('Minds 评论已写入：侧栏显示结果，正文出现评论标记。')
      } else {
        notify('Go Deeper 结果已附着在正文原位，可以继续往下写。')
      }
      return true
    } catch (error: unknown) {
      notify(`结果已生成但没能写入正文：${errorText(error, '源或占位已变化')}。结果保留在服务端记录里，不会被自动重发。`)
      return false
    }
  }, [commentsPage, notify, persistIndex, reloadComments, sessionId, store])

  /**
   * 一次完整写作请求：prepare（队列内）→ execute（队列外）→ apply（队列内）。
   *
   * `dedupeTuple` 来自自动调度；手动请求传 null，被服务端视为新请求。
   */
  const runWriting = useCallback(async (input: {
    kind: WritingRequestKind
    trigger: 'manual' | 'automatic'
    ranges?: AutoRange[] | null
    presets?: MindPresetId[]
    dedupeTuple?: string | null
  }): Promise<void> => {
    if (sessionId === null || fileId === null) {
      notify('这篇还没有服务器版本：先保存成功，AI 才能读取它。')
      return
    }
    if (busyRef.current) return
    const rawQuestion = question.trim()
    if (input.kind === 'go_deeper' && input.trigger === 'manual'
      && Array.from(rawQuestion).length > 2000) {
      setQuestionError('问题太长（最多 2,000 字），内容保留在输入框里。')
      return
    }
    setQuestionError('')
    markBusy(true)
    const requestId = newRequestId()
    const started = Date.now()
    const base: WritingRequestRecord = {
      requestId,
      kind: input.kind,
      fileId,
      phase: 'running',
      message: defaultMessage('running', input.kind),
      mayHaveCharged: false,
      startedAt: started,
      updatedAt: started,
      applied: false,
    }
    // 先登记再发送：进程被杀也能按 ID 查回状态，绝不靠猜。
    persistIndex(addWritingEntry(indexRef.current, { requestId, kind: input.kind, fileId }))
    setRecord(base)
    setNotice('')

    try {
      /* ---- 1. prepare：队列内（先落库到序号屏障，再发短事务） ---- */
      const captured: { value: AIWritingMutation | AINoopResponse | null } = { value: null }
      try {
        await store.runFileCommand(sessionId, async () => {
          const session = store.getSession(sessionId)
          if (session === null || session.fileId === null || session.revision === null) {
            throw new Error('这篇还没有服务器版本')
          }
          const result = await prepareAIWriting({
            request_id: requestId,
            kind: input.kind,
            trigger: input.trigger,
            source: { type: 'journal', id: session.fileId, expected_revision: session.revision },
            ...(input.kind === 'go_deeper'
              ? (input.trigger === 'manual' && rawQuestion !== '' ? { question: rawQuestion } : {})
              : {
                  mind_preset_ids: input.presets ?? presets,
                  // `null`/空数组表示整篇：不传 scope，由服务端按 `all` 处理。
                  ...(input.ranges === null || input.ranges === undefined || input.ranges.length === 0
                    ? {}
                    : { scope: { ranges: input.ranges } }),
                }),
          })
          captured.value = result
          if (isNoop(result)) return { files: [], effects: [], request_id: null }
          return toMutation(result.files, result.effects, requestId)
        })
      } catch (error: unknown) {
        const status = statusOf(error)
        // 这些失败都发生在模型调用之前（409 版本/在途冲突、422 校验、503 缺配置）。
        persistIndex(removeWritingEntry(indexRef.current, requestId))
        setLastStatus(null)
        const blocked = status === 409 || status === 422 || status === 428 || status === 503 || status === 404 || status === 429
        const phase = status === 409 ? 'conflict' : 'failed'
        setRecord({
          ...base,
          phase: blocked ? phase : 'unknown',
          mayHaveCharged: !blocked,
          message: `没有发起 AI 调用：${errorText(error, '请求被拒绝')}`,
        })
        if (input.kind === 'go_deeper' && input.trigger === 'automatic') {
          autoRef.current = autoRef.current === null ? null : noteSettled(autoRef.current, input.kind, {
            dedupeTuple: input.dedupeTuple ?? null,
            blocked: true,
            userText: latestRef.current.userText,
          })
        }
        return
      }

      if (captured.value !== null && isNoop(captured.value)) {
        persistIndex(removeWritingEntry(indexRef.current, requestId))
        setLastStatus(null)
        setRecord({
          ...base,
          phase: 'noop',
          message: captured.value.message ?? defaultMessage('noop', input.kind),
        })
        return
      }

      /* ---- 2. execute：队列外，允许继续写与切页 ---- */
      setLastStatus('prepared')
      let detail: AIRequestDetail
      try {
        const result = await executeAIWriting(requestId)
        detail = result.body
        setLastStatus(result.body.status)
      } catch (error: unknown) {
        const status = statusOf(error)
        const current = record ?? base
        setLastStatus(status === 503 ? 'failed' : 'unknown')
        const merged = mergeWritingDetail(current, { status: status === 503 ? 'failed' : 'unknown' }, Date.now())
        setRecord({
          ...merged,
          message: status === 503
            ? '后端没有配置模型 Key（HTTP 503），本次未调用模型，不会消耗 Token。'
            : `没有拿到结果：${errorText(error, '调用失败')}。可能已消耗 Token，只查询不重发。`,
        })
        if (input.trigger === 'automatic') {
          autoRef.current = autoRef.current === null ? null : noteSettled(autoRef.current, input.kind, {
            dedupeTuple: input.dedupeTuple ?? null,
            blocked: true,
            userText: latestRef.current.userText,
          })
        }
        return
      }

      const merged = mergeWritingDetail(base, detail, Date.now())
      setRecord(merged)
      if (merged.phase !== 'ready') {
        if (input.trigger === 'automatic') {
          autoRef.current = autoRef.current === null ? null : noteSettled(autoRef.current, input.kind, {
            dedupeTuple: input.dedupeTuple ?? null,
            blocked: merged.phase !== 'applied',
            userText: latestRef.current.userText,
          })
        }
        return
      }

      /* ---- 3. apply：队列内（保存屏障之后，只做窄应用） ---- */
      const applied = await applyReady(requestId, input.kind)
      setRecord(applied
        ? { ...merged, phase: 'applied', applied: true, message: defaultMessage('applied', input.kind) }
        : {
            ...merged,
            phase: 'conflict',
            message: '结果已生成但没能写入正文（源或占位已变化）。结果保留在请求记录里，不会被自动重发。',
          })
      if (input.trigger === 'automatic') {
        autoRef.current = autoRef.current === null ? null : noteSettled(autoRef.current, input.kind, {
          dedupeTuple: input.dedupeTuple ?? null,
          blocked: false,
          userText: latestRef.current.userText,
        })
      }
    } finally {
      markBusy(false)
      if (mountedRef.current) setTickToken((value) => value + 1)
    }
  }, [applyReady, fileId, markBusy, notify, persistIndex, presets, question, record, sessionId, store])

  /* --------------------------------------------------- 自动触发循环 */

  const evaluateNow = useCallback(() => {
    const state = autoRef.current
    if (state === null || sessionId === null || fileId === null) return
    if (busyRef.current || disabled) return
    const latest = latestRef.current
    const isVisible = visible ?? (typeof document === 'undefined' || document.visibilityState !== 'hidden')
    const decision = evaluateAuto(state, {
      now: Date.now(),
      visible: isVisible,
      composing: latest.composing,
      saved: latest.saved,
      userText: latest.userText,
      document: latest.editorDocument,
      available: true,
    })
    if (decision.action === 'request') {
      autoRef.current = noteScheduled(state, decision.plan, {
        userText: latest.userText,
        document: latest.editorDocument,
        now: Date.now(),
        dedupeTuple: decision.dedupeTuple,
      })
      setAutoStatus(`自动${decision.plan.mode === 'go_deeper' ? ' Go Deeper' : ' Minds 评论'}：正在请求。`)
      void runWriting({
        kind: decision.plan.mode,
        trigger: 'automatic',
        ranges: decision.plan.ranges,
        presets: decision.plan.presets,
        dedupeTuple: decision.dedupeTuple,
      })
      return
    }
    setAutoStatus('')
    // 还在安静期/冷却期：按剩余时间再评估一次；其他原因等下一次输入或事件。
    if ((decision.reason === 'pausing' || decision.reason === 'cooling') && decision.readyInMs > 0) {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (mountedRef.current) setTickToken((value) => value + 1)
      }, Math.min(decision.readyInMs + 50, 5000))
    }
  }, [disabled, fileId, runWriting, sessionId, visible])

  useEffect(() => {
    evaluateNow()
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // userInputSeq 前进、保存状态变化、可见性变化或定时器触发时重新评估。
  }, [evaluateNow, tickToken, userInputSeq, saved, composing, visible])

  // 页面隐藏后再回来：只重新评估尚未执行的调度（已登记请求不受影响）。
  useEffect(() => {
    if (typeof document === 'undefined') return
    function handleVisibility(): void {
      if (document.visibilityState === 'visible') setTickToken((value) => value + 1)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])

  /* --------------------------------------------------------- 恢复 */

  const queryStatus = useCallback(async () => {
    const current = record
    if (current === null) return
    if (busyRef.current) return
    markBusy(true)
    try {
      const detail = await getAIRequest(current.requestId)
      if (!mountedRef.current) return
      const merged = mergeWritingDetail(current, detail, Date.now())
      setRecord(merged)
      setLastStatus(detail.status)
      const decision = decideRecovery(
        { requestId: current.requestId, kind: current.kind, fileId: current.fileId },
        detail,
      )
      if (decision.action === 'drop') persistIndex(removeWritingEntry(indexRef.current, current.requestId))
      if (decision.action === 'apply') notify('结果已就绪：点「写入正文」把它合进来。')
      if (detail.status === 'prepared') notify('这次请求已登记但从未执行：可以用同一个 request_id 继续，不会重复登记或重复计费。')
    } catch (error: unknown) {
      if (!mountedRef.current) return
      if (statusOf(error) === 404) {
        persistIndex(removeWritingEntry(indexRef.current, current.requestId))
        setLastStatus(null)
        setRecord({ ...current, phase: 'failed', message: '服务端没有这次请求的记录，已移除入口（不会自动重建）。' })
        return
      }
      setRecord({ ...current, message: `查询失败：${errorText(error, '请稍后重试')}` })
    } finally {
      markBusy(false)
    }
  }, [markBusy, notify, persistIndex, record])

  /** 手动把一条 `ready` 的结果写进正文（先保存屏障，再窄应用）。 */
  const applyCurrent = useCallback(async () => {
    const current = record
    if (current === null || busyRef.current) return
    markBusy(true)
    try {
      const ok = await applyReady(current.requestId, current.kind)
      setRecord(ok
        ? { ...current, phase: 'applied', applied: true, message: defaultMessage('applied', current.kind) }
        : { ...current, phase: 'conflict', message: '结果已生成但没能写入正文（源或占位已变化）。' })
    } finally {
      markBusy(false)
      if (mountedRef.current) setTickToken((value) => value + 1)
    }
  }, [applyReady, markBusy, record])

  /**
   * 同一 request_id 继续执行（只对 `prepared` 开放）。
   *
   * 服务端保证同一 ID 只执行一次，因此这里**不新建 ID**，也不会二次计费；
   * 执行完直接走同一条 apply 路径。
   */
  const resumeExecute = useCallback(async () => {
    const current = record
    if (current === null || busyRef.current) return
    markBusy(true)
    try {
      const result = await executeAIWriting(current.requestId)
      if (!mountedRef.current) return
      setLastStatus(result.body.status)
      const merged = mergeWritingDetail(current, result.body, Date.now())
      setRecord(merged)
      if (merged.phase !== 'ready') return
      const ok = await applyReady(current.requestId, current.kind)
      setRecord(ok
        ? { ...merged, phase: 'applied', applied: true, message: defaultMessage('applied', current.kind) }
        : { ...merged, phase: 'conflict', message: '结果已生成但没能写入正文（源或占位已变化）。' })
    } catch (error: unknown) {
      if (!mountedRef.current) return
      setLastStatus('unknown')
      setRecord({
        ...current,
        phase: 'unknown',
        mayHaveCharged: true,
        message: `没有拿到结果：${errorText(error, '调用失败')}。可能已消耗 Token，只查询不重发。`,
      })
    } finally {
      markBusy(false)
      if (mountedRef.current) setTickToken((value) => value + 1)
    }
  }, [applyReady, markBusy, record])

  const forget = useCallback(() => {
    if (record === null) return
    persistIndex(removeWritingEntry(indexRef.current, record.requestId))
    setRecord(null)
  }, [persistIndex, record])

  /* --------------------------------------------------------- 删除评论 */

  const removeComment = useCallback(async (comment: AIComment) => {
    if (fileId === null) return
    const session = sessionId === null ? null : store.getSession(sessionId)
    if (session === null || session.revision === null) {
      notify('还没读取到这篇的服务器版本，暂时不能删除评论。')
      return
    }
    try {
      await deleteAIComment(fileId, comment.id, session.revision)
      notify('已删除这条评论与它的正文标记；已消耗的 Token 不会回退。')
      void reloadComments(commentsPage)
    } catch (error: unknown) {
      notify(`删除评论失败：${errorText(error, '请先保存最新输入后重试')}`)
    }
  }, [commentsPage, fileId, notify, reloadComments, sessionId, store])

  /* --------------------------------------------------------- 渲染 */

  const available = sessionId !== null && fileId !== null
  const running = record !== null && record.phase === 'running'
  const scopeLabel = useMemo(() => {
    if (selection === null || selection.length === 0) return '整篇'
    return `已选 ${selection.length} 段（${selection.map((range) => `${range.start}-${range.end}`).join('、')}）`
  }, [selection])
  const presetList = useMemo(
    () => (settings === null ? presets : presets.filter((id) => MIND_PRESET_IDS.includes(id))),
    [presets, settings],
  )

  return (
    <section className="writing-ai" aria-label="AI 写作">
      <header className="writing-ai-head">
        <h3>AI 写作</h3>
        <span className="writing-ai-phase" role="status">
          {record === null ? '未调用' : phaseLabel(record.phase)}
        </span>
      </header>

      {!available && (
        <p className="writing-ai-hint">
          这篇还没有服务器版本：先写下有效正文并保存成功，AI 才能读取它。这里不会用空文件占位。
        </p>
      )}

      {available && (
        <>
          <div className="writing-ai-row">
            <label className="writing-ai-question">
              <span>Go Deeper（可选：单独问一句，不写进正文）</span>
              <textarea rows={2} value={question} disabled={disabled || running}
                placeholder="例如：我为什么老想着这件事？"
                onChange={(event) => setQuestion(event.target.value)} />
            </label>
            {questionError !== '' && <p className="writing-ai-error" role="alert">{questionError}</p>}
            <div className="writing-ai-buttons">
              <button type="button" className="writing-ai-primary"
                disabled={disabled || running}
                onClick={() => { void runWriting({ kind: 'go_deeper', trigger: 'manual' }) }}>
                {running ? 'AI 正在处理……' : 'Go Deeper（手动）'}
              </button>
              <span className="writing-ai-note">处理期间可以继续写、可以切页；结果回来会原位附着。</span>
            </div>
          </div>

          {record !== null && record.message !== '' && (
            <p className={`writing-ai-status writing-ai-status-${record.phase}`} role="status">{record.message}</p>
          )}
          {record !== null && (record.phase === 'unknown' || record.phase === 'failed') && record.mayHaveCharged && (
            <p className="writing-ai-warn" role="alert">
              这次可能已经消耗 Token。不会自动换新的 request_id 重发；需要时先查询，再手动决定。
            </p>
          )}
          {record !== null && record.phase === 'ready' && (
            <div className="writing-ai-buttons">
              <button type="button" className="writing-ai-primary"
                disabled={disabled || busy}
                onClick={() => { void applyCurrent() }}>
                写入正文
              </button>
              <button type="button" disabled={disabled} onClick={forget}>清除入口</button>
            </div>
          )}
          {record !== null && (record.phase === 'unknown' || record.phase === 'running'
            || record.phase === 'failed' || record.phase === 'conflict') && (
            <div className="writing-ai-buttons">
              <button type="button" disabled={disabled || busy} onClick={() => { void queryStatus() }}>
                查询状态
              </button>
              {record.phase === 'running' && lastStatus === 'prepared' && (
                <button type="button" disabled={disabled || busy} onClick={() => { void resumeExecute() }}>
                  继续执行（同一 request_id）
                </button>
              )}
              <button type="button" disabled={disabled} onClick={forget}>清除入口</button>
            </div>
          )}
          {autoStatus !== '' && <p className="writing-ai-note" role="status">{autoStatus}</p>}
        </>
      )}

      {available && (
        <MindsSidebar
          comments={comments}
          loading={commentsLoading}
          error={commentsError}
          disabled={disabled || running}
          presets={presetList}
          onPresetsChange={setPresets}
          onRequest={() => {
            void runWriting({
              kind: 'minds_comments',
              trigger: 'manual',
              ranges: selection,
              presets: presetList,
            })
          }}
          onDelete={(comment) => { void removeComment(comment) }}
          onReload={() => { void reloadComments(1) }}
          statusMessage={running && record?.kind === 'minds_comments' ? record.message : ''}
          scopeLabel={scopeLabel}
          total={commentsTotal}
          page={commentsPage}
          hasNext={commentsHasNext}
          onPageChange={(page) => { void reloadComments(page) }}
        />
      )}

      {notice !== '' && (
        <p className="writing-ai-note" role="status">{notice}</p>
      )}

      {settings !== null && (
        <p className="writing-ai-auto">
          自动开关：Go Deeper {settings.auto_go_deeper ? '已开启' : '关闭'}，
          Minds 评论 {settings.auto_minds_comments ? '已开启' : '关闭'}。
          参数：输入停稳 {Math.round(AUTO_AI_CONFIG.pause_ms / 1000)} 秒、
          新增 {AUTO_AI_CONFIG.min_increment_code_points} 字符、
          冷却 {Math.round(AUTO_AI_CONFIG.cooldown_ms / 1000)} 秒。可在设置页修改。
          {onReloadSettings !== undefined && (
            <button type="button" className="writing-ai-link" onClick={onReloadSettings}>
              重新读取设置
            </button>
          )}
        </p>
      )}
      {settings === null && onReloadSettings !== undefined && (
        <p className="writing-ai-auto">
          还没读到 AI 设置：自动 AI 状态未知（手动调用不受影响）。
          <button type="button" className="writing-ai-link" onClick={onReloadSettings}>
            重新读取设置
          </button>
        </p>
      )}
    </section>
  )
}

export default WritingAiPanel
