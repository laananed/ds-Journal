/**
 * 完整复盘页（Stage 3 / S3-T09）。
 *
 * 覆盖 `docs/stage3-tasks.md` §11 与 `docs/stage3-api.md` §5～§6 的授权范围：
 * 单篇入口、Journal/Inbox **跨分页**选源、去重计数与日期计数、显示实际文本量、
 * 生成 / 恢复 / 可编辑预览、默认保存目标、**一次确认**与正确的目标导航。
 *
 * 硬约束：
 * - 选源用 `type + id` 去重；最多 15 文件 / 7 个**不同**业务日期（非连续合法，
 *   同日多篇不误限）——判定在 `../utils/reviewSelection` 里，可被纯逻辑测试覆盖；
 * - 文本量按后端同一口径取**用户正文**（排除 AI 段），不用截断的卡片摘要冒充；
 * - 生成只发 `request_id` + typed sources（含 `expected_revision`），
 *   不自报日期/全文、不伪造 AI 块；
 * - 生成持久化预览但**不创建/修改目标文件**；取消不保存，ready 结果仍可由请求 ID 恢复；
 * - 保存只走 `POST /api/ai/reviews/{id}/save`，一次确认；响应丢失时用**同请求同 body**
 *   恢复，绝不制造第二个目标；保存成功后按返回的 target 导航；
 * - 源冲突不能保存旧总结；读取/列表刷新失败只重试读取。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AiApiError, getAIRequest, postAIReview, saveAIReview } from '../api/ai'
import { getInbox, listInboxes } from '../api/inboxes'
import { getJournal, listJournals } from '../api/journals'
import Pagination from '../components/Pagination'
import ReviewPreview from '../components/ReviewPreview'
import type { AIRequestDetail, AIReviewObject, AIReviewSaveRequest } from '../types/ai'
import {
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  addRecoveryEntry,
  newRequestId,
  readRecoveryIndex,
  removeRecoveryEntry,
  writeRecoveryIndex,
  type AiRecoveryEntry,
} from '../utils/aiRequestState'
import { validateContent } from '../utils/contentValidation'
import { defaultJournalDate } from '../utils/journalDate'
import {
  REVIEW_MAX_DATES,
  REVIEW_MAX_SOURCES,
  buildReviewRequest,
  buildTargetPayload,
  canAddEntry,
  initialTargetDraft,
  limitFor,
  limitMessage,
  parseReviewObject,
  reviewInFlight,
  reviewPhaseLabel,
  reviewRecoveryAction,
  reviewRecoveryEntries,
  selectionLabel,
  sourceKey,
  summarizeSelection,
  userCodePointsOf,
  validateTargetDraft,
  type ReviewEntry,
  type ReviewPhase,
  type ReviewSource,
  type ReviewSourceType,
  type ReviewTargetDraft,
} from '../utils/reviewSelection'

/** 选源列表只需要这几个字段（Journal/Inbox 列表项都带业务日期）。 */
interface SourceListItem {
  id: number
  display_title: string
  content: string
  journal_date?: string
  inbox_date?: string
}
interface SourceListPage {
  items: SourceListItem[]
  page: number
  total: number
  has_next: boolean
}

interface ReviewPageProps {
  /** 从详情页「复盘这篇」进入时预选的单篇源；`key` 变化代表一次新请求。 */
  initialSource?: ReviewSource | null
  initialSourceKey?: number
  onInitialSourceConsumed?: () => void
  /** 所有离开出口都走 App 的 flush 保护。 */
  onNavigate: (action: () => void) => void
  /** 保存成功后导航到后端返回的目标 Journal。 */
  onOpenJournal: (id: number) => void
  /** 生成/轮询/保存期间交给 App 的在途锁（阻止中途离开丢状态）。 */
  onAiLockChange?: (locked: boolean) => void
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function ReviewPage({
  initialSource = null,
  initialSourceKey = 0,
  onInitialSourceConsumed,
  onNavigate,
  onOpenJournal,
  onAiLockChange,
}: ReviewPageProps) {
  /* ------------------------------------------------------------ 选源 */
  const [selected, setSelected] = useState<ReviewEntry[]>([])
  /** 已读取的源详情：revision 与用户正文字数（详情是唯一可信来源）。 */
  const [details, setDetails] = useState<Record<string, { revision: number; userCodePoints: number; date: string }>>({})
  const loadingKeys = useRef<Set<string>>(new Set())

  const [browseType, setBrowseType] = useState<ReviewSourceType>('journal')
  const [page, setPage] = useState(1)
  const [listResult, setListResult] = useState<SourceListPage | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)

  /* -------------------------------------------------------- 生成/保存 */
  const [phase, setPhase] = useState<ReviewPhase>('idle')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [sources, setSources] = useState<ReviewSource[]>([])
  const [review, setReview] = useState<AIReviewObject | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [target, setTarget] = useState<ReviewTargetDraft | null>(null)
  const [message, setMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  /** 响应丢失后要原样重放的 save body（同请求、同内容 ⇒ 不会制造新目标）。 */
  const [pendingSave, setPendingSave] = useState<AIReviewSaveRequest | null>(null)
  const [recoverables, setRecoverables] = useState<AiRecoveryEntry[]>([])

  const busyRef = useRef(false)
  const saveBusyRef = useRef(false)
  const mountedRef = useRef(true)
  const consumedSeed = useRef<number | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 在途锁：生成 / 轮询 / 保存期间由 App 阻止导航；卸载时释放。
  useEffect(() => {
    onAiLockChange?.(reviewInFlight(phase))
  }, [phase, onAiLockChange])
  useEffect(() => () => { onAiLockChange?.(false) }, [onAiLockChange])

  const refreshRecoverables = useCallback(() => {
    setRecoverables(reviewRecoveryEntries(readRecoveryIndex(storage())))
  }, [])
  useEffect(() => { refreshRecoverables() }, [refreshRecoverables])

  function dropRecovery(id: string): void {
    writeRecoveryIndex(storage(), removeRecoveryEntry(readRecoveryIndex(storage()), id))
    refreshRecoverables()
  }

  /* ------------------------------------------------ 详情载入（文本量/版本） */

  const entries = useMemo<ReviewEntry[]>(() => selected.map((item) => {
    const detail = details[sourceKey(item.source)]
    if (detail === undefined) return item
    return { source: item.source, date: detail.date !== '' ? detail.date : item.date, userCodePoints: detail.userCodePoints }
  }), [selected, details])

  const summary = useMemo(() => summarizeSelection(entries), [entries])

  useEffect(() => {
    const missing = selected.filter((item) => {
      const key = sourceKey(item.source)
      return details[key] === undefined && !loadingKeys.current.has(key)
    })
    if (missing.length === 0) return
    for (const item of missing) loadingKeys.current.add(sourceKey(item.source))
    let cancelled = false
    void (async () => {
      const results = await Promise.all(missing.map(async (item) => {
        try {
          const file = item.source.type === 'journal'
            ? await getJournal(item.source.id)
            : await getInbox(item.source.id)
          const date = 'journal_date' in file ? file.journal_date : file.inbox_date
          return {
            key: sourceKey(item.source),
            value: { revision: file.revision, userCodePoints: userCodePointsOf(file), date },
          }
        } catch {
          return { key: sourceKey(item.source), value: null }
        }
      }))
      if (cancelled) return
      setDetails((prev) => {
        const next = { ...prev }
        for (const result of results) {
          if (result.value !== null) next[result.key] = result.value
        }
        return next
      })
    })()
    return () => { cancelled = true }
  }, [selected, details])

  /* ---------------------------------------------------------- 列表读取 */

  useEffect(() => {
    const controller = new AbortController()
    setListStatus('loading')
    setListError('')
    setListResult(null)
    void (async () => {
      try {
        const data: SourceListPage = browseType === 'journal'
          ? await listJournals(undefined, page, controller.signal)
          : await listInboxes(undefined, page, controller.signal)
        if (controller.signal.aborted) return
        setListResult(data)
        setListStatus('success')
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        setListError(errorText(error))
        setListStatus('error')
      }
    })()
    return () => controller.abort()
  }, [browseType, page, listRevision])

  /* --------------------------------------------------- 预选源（详情页进入） */

  useEffect(() => {
    if (initialSource === null) return
    if (consumedSeed.current === initialSourceKey) {
      onInitialSourceConsumed?.()
      return
    }
    consumedSeed.current = initialSourceKey
    setSelected((prev) => prev.some((item) => sourceKey(item.source) === sourceKey(initialSource))
      ? prev
      : [...prev, { source: initialSource, date: '' }])
    onInitialSourceConsumed?.()
  }, [initialSource, initialSourceKey, onInitialSourceConsumed])

  /* -------------------------------------------------------- 恢复入口展示 */

  /* ------------------------------------------------------------ 选源动作 */

  function toggleItem(type: ReviewSourceType, id: number, date: string): void {
    if (reviewInFlight(phase)) return
    const source: ReviewSource = { type, id }
    const key = `${type}:${id}`
    if (selected.some((item) => sourceKey(item.source) === key)) {
      setSelected((prev) => prev.filter((item) => sourceKey(item.source) !== key))
      loadingKeys.current.delete(key)
      setDetails((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      setActionError('')
      return
    }
    const candidate: ReviewEntry = { source, date }
    const limits = canAddEntry(entries, candidate)
    if (!limits.ok) {
      setActionError(limitMessage(limits.reason ?? 'too_many_sources'))
      return
    }
    setActionError('')
    setSelected((prev) => [...prev, candidate])
  }

  function clearSelection(): void {
    setSelected([])
    setDetails({})
    loadingKeys.current.clear()
    setActionError('')
  }

  function resetReview(): void {
    setPhase('idle')
    setRequestId(null)
    setSources([])
    setReview(null)
    setMarkdown('')
    setTarget(null)
    setMessage('')
    setSaveError('')
    setPendingSave(null)
    busyRef.current = false
  }

  function removeAllFromSelection(): void {
    resetReview()
    clearSelection()
    setMessage('')
    refreshRecoverables()
  }

  /* -------------------------------------------------------- 结果应用 */

  function applyReviewDetail(detail: AIRequestDetail, businessDate: string): void {
    setRequestId(detail.request_id)
    if (detail.status === 'pending') {
      setPhase('polling')
      setMessage('后端仍在生成复盘，正在等待结果……')
      return
    }
    if (detail.status === 'applied') {
      dropRecovery(detail.request_id)
      setPhase('applied')
      setMessage('这次复盘已经保存过，不会再次创建目标。')
      const targetId = detail.saved_target !== null && detail.saved_target !== undefined
        ? detail.saved_target.id : null
      if (targetId !== null) onOpenJournal(targetId)
      return
    }
    if (detail.status === 'conflict') {
      const parsed = parseReviewObject(detail.review)
      if (parsed !== null) {
        setReview(parsed)
        setMarkdown(parsed.markdown)
      }
      const frozen = (detail.sources ?? []).map((item) => ({ type: item.type, id: item.id })) as ReviewSource[]
      setSources(frozen)
      setTarget(initialTargetDraft(frozen, businessDate))
      setPhase('conflict')
      setMessage('源文件在生成之后发生了变化，已保留预览但**不能**保存这份过期总结；请重新发起复盘。')
      return
    }
    if (detail.status === 'failed' || detail.status === 'unknown') {
      setPhase(detail.status === 'failed' ? 'failed' : 'unknown')
      const fallback = detail.status === 'failed'
        ? '复盘生成失败，结果未保存；可调整所选源后重试。'
        : '请求状态不明，可能已消耗 Token；请勿自动重发，可先点「查询状态」核对。'
      setMessage(detail.error?.message !== null && detail.error?.message !== undefined && detail.error.message !== ''
        ? detail.error.message : fallback)
      return
    }
    // ready
    const parsed = parseReviewObject(detail.review)
    if (parsed === null) {
      setPhase('failed')
      setMessage('后端返回的复盘结果无法解析，未展示预览，也**不会**写入任何目标文件。')
      return
    }
    const frozen = (detail.sources ?? []).map((item) => ({ type: item.type, id: item.id })) as ReviewSource[]
    setSources(frozen)
    setReview(parsed)
    setMarkdown(parsed.markdown)
    setTarget(initialTargetDraft(frozen, businessDate))
    setPhase('ready')
    setMessage(`复盘已生成：${detail.sources.length} 篇源。核对依据并编辑正文后，确认保存只会有一次。`)
  }

  /* ---------------------------------------------------------- 生成 */

  async function generate(): Promise<void> {
    if (busyRef.current || reviewInFlight(phase)) return
    if (selected.length === 0) {
      setActionError('先选择要复盘的 Journal 或 Inbox。')
      return
    }
    const limits = limitFor(entries)
    if (!limits.ok) {
      setActionError(limitMessage(limits.reason ?? 'too_many_sources'))
      return
    }
    busyRef.current = true
    setActionError('')
    setSaveError('')
    setMessage('')
    setPhase('generating')
    // 默认日期在**发起复盘时**捕获（04:00 业务日期规则），之后显式随保存参数发送。
    const businessDate = defaultJournalDate()

    // 冻结源：并发读取最新详情，取得 revision 与用户正文量；失效源在此暴露。
    let frozen: { source: ReviewSource; revision: number }[]
    try {
      const results = await Promise.all(selected.map(async (item) => {
        const file = item.source.type === 'journal'
          ? await getJournal(item.source.id)
          : await getInbox(item.source.id)
        const date = 'journal_date' in file ? file.journal_date : file.inbox_date
        return { source: item.source, revision: file.revision, date, userCodePoints: userCodePointsOf(file) }
      }))
      if (!mountedRef.current) { busyRef.current = false; return }
      setDetails((prev) => {
        const next = { ...prev }
        for (const result of results) {
          next[sourceKey(result.source)] = {
            revision: result.revision, userCodePoints: result.userCodePoints, date: result.date,
          }
        }
        return next
      })
      frozen = results.map((result) => ({ source: result.source, revision: result.revision }))
    } catch (error: unknown) {
      busyRef.current = false
      if (!mountedRef.current) return
      setPhase('idle')
      setActionError(`读取所选源失败（可能有源已被删除或移入回收箱）：${errorText(error)}。没有发起复盘。`)
      return
    }

    const id = newRequestId()
    const payload = buildReviewRequest(id, frozen)
    const anchor = [...frozen].sort((a, b) => (a.source.type === b.source.type
      ? a.source.id - b.source.id
      : (a.source.type < b.source.type ? -1 : 1)))[0].source
    writeRecoveryIndex(storage(), addRecoveryEntry(readRecoveryIndex(storage()), {
      requestId: id, kind: 'review', source: anchor,
    }))
    refreshRecoverables()
    setRequestId(id)
    setSources(frozen.map((item) => item.source))

    try {
      const result = await postAIReview(payload)
      busyRef.current = false
      if (!mountedRef.current) return
      applyReviewDetail(result.body, businessDate)
    } catch (error: unknown) {
      busyRef.current = false
      if (!mountedRef.current) return
      const status = error instanceof AiApiError ? error.status : null
      if (status !== null && status < 500) {
        // 校验类失败发生在模型调用之前：移除刚登记的入口，避免误报「可能已计费」。
        dropRecovery(id)
      }
      if (status === null || status >= 500) {
        setPhase('polling')
        setMessage('没有正常拿到生成结果，可能已消耗 Token；正在按请求 ID 查询这次复盘的状态……')
        return
      }
      setPhase(status === 409 ? 'conflict' : 'failed')
      setActionError(`复盘生成被拒绝（HTTP ${status}）：${errorText(error)}。没有消耗模型调用。`)
    }
  }

  /* -------------------------------------------------------- 有限轮询 */

  useEffect(() => {
    if (phase !== 'polling' || requestId === null) return
    const id = requestId
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = (delay: number): void => {
      if (cancelled) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void step() }, delay)
    }
    const step = async (): Promise<void> => {
      if (cancelled) return
      if (attempts >= POLL_MAX_ATTEMPTS) {
        setPhase('unknown')
        setMessage('等待超过 90 秒仍未拿到结果，状态不明，可能已消耗 Token；请勿自动重发。')
        return
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      attempts += 1
      try {
        const detail = await getAIRequest(id)
        if (cancelled) return
        if (reviewRecoveryAction(detail.status) === 'drop') {
          dropRecovery(id)
          setPhase('failed')
          setMessage('没有查到这次复盘请求（可能未成功登记）。已移除恢复入口，不会自动重发。')
          return
        }
        if (detail.status === 'pending') { schedule(POLL_INTERVAL_MS); return }
        applyReviewDetail(detail, defaultJournalDate())
      } catch (error: unknown) {
        if (cancelled) return
        if (error instanceof AiApiError && error.status === 404) {
          dropRecovery(id)
          setPhase('failed')
          setMessage('没有查到这次复盘请求，已移除恢复入口（不会自动重发）。')
          return
        }
        schedule(POLL_INTERVAL_MS)
      }
    }
    schedule(0)
    const onVisibility = (): void => {
      if (cancelled || timer !== null) return
      if (document.visibilityState !== 'hidden') schedule(0)
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
    // 只在进入/离开轮询或换 request_id 时重建；attempts 与下一轮由 step 自己重排。
  }, [phase, requestId])

  /* -------------------------------------------------------- 恢复查询 */

  async function restoreEntry(entry: AiRecoveryEntry): Promise<void> {
    if (busyRef.current || reviewInFlight(phase)) return
    busyRef.current = true
    setActionError('')
    setSaveError('')
    setMessage('')
    setPhase('generating')
    try {
      const detail = await getAIRequest(entry.requestId)
      if (!mountedRef.current) return
      busyRef.current = false
      if (reviewRecoveryAction(detail.status) === 'drop') {
        dropRecovery(entry.requestId)
        setPhase('failed')
        setMessage('没有查到这次复盘请求（可能未成功登记）。')
        return
      }
      setRequestId(entry.requestId)
      applyReviewDetail(detail, defaultJournalDate())
    } catch (error: unknown) {
      busyRef.current = false
      if (!mountedRef.current) return
      if (error instanceof AiApiError && error.status === 404) {
        dropRecovery(entry.requestId)
        setPhase('failed')
        setMessage('没有查到这次复盘请求，已移除恢复入口（不会自动重发）。')
        return
      }
      setPhase('failed')
      setMessage(`恢复查询失败：${errorText(error)}`)
    }
  }

  /* -------------------------------------------------------- 一次确认 */

  async function confirmSave(): Promise<void> {
    // 防双击：React 的 saving 状态要等下一次渲染才生效，同步 ref 才是真正的闸门。
    if (review === null || target === null || saveBusyRef.current || phase !== 'ready') return
    saveBusyRef.current = true
    const targetError = validateTargetDraft(target)
    if (targetError !== null) { saveBusyRef.current = false; setSaveError(targetError); return }
    const contentError = validateContent(markdown)
    if (contentError !== undefined) { saveBusyRef.current = false; setSaveError(`复盘正文不能保存：${contentError}`); return }
    const frozenRequestId = requestId
    if (frozenRequestId === null) { saveBusyRef.current = false; setSaveError('缺少请求 ID，无法保存；请重新生成一次复盘。'); return }

    // 冻结 body：一旦发出，重试必须**同请求、同 body**，后端才会回同一 target。
    const body: AIReviewSaveRequest = pendingSave ?? { markdown, target: buildTargetPayload(target) }
    setPendingSave(body)
    setSaveError('')
    setSaving(true)
    setPhase('saving')
    try {
      const result = await saveAIReview(frozenRequestId, body)
      if (!mountedRef.current) return
      setSaving(false)
      setPendingSave(null)
      dropRecovery(frozenRequestId)
      setPhase('applied')
      resetReview()
      clearSelection()
      const targetId = typeof result.target.id === 'number' ? result.target.id : null
      setMessage(`复盘已保存到 Journal ${targetId ?? '（目标未知）'}。`)
      // 同步释放在途锁，否则 App 会把「导航到目标」当成处理中而拦下。
      onAiLockChange?.(false)
      if (targetId !== null) onOpenJournal(targetId)
      return
    } catch (error: unknown) {
      if (!mountedRef.current) return
      setSaving(false)
      const status = error instanceof AiApiError ? error.status : null
      if (status === 409) {
        setPendingSave(null)
        setPhase('conflict')
        setSaveError('源文件在生成之后发生变化，不能把这份过期总结写进目标。请重新发起复盘。')
        return
      }
      if (status !== null && status < 500) {
        setPendingSave(null)
        setPhase('ready')
        setSaveError(`保存被拒绝（HTTP ${status}）：${errorText(error)}。预览已保留。`)
        return
      }
      setPhase('ready')
      setSaveError('没有收到服务器确认，可能已经保存成功。请点「用刚才的内容重试保存」——同请求、同内容会回到同一个目标，不会重复创建。')
    } finally {
      saveBusyRef.current = false
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  const lockInFlight = reviewInFlight(phase)
  const appendAllowed = sources.length === 1 && sources[0].type === 'journal'
  const previewDisabled = saving || phase === 'conflict'
  const generateDisabled = lockInFlight || selected.length === 0 || summary.limits.ok === false

  function sourceDate(item: SourceListItem): string {
    return browseType === 'journal' ? (item.journal_date ?? '') : (item.inbox_date ?? '')
  }

  return (
    <section className="review-page" aria-label="复盘模块">
      <div className="detail-header">
        <h2>完整复盘</h2>
        <span className={`ai-phase ai-phase-${phase}`} role="status">{reviewPhaseLabel(phase)}</span>
      </div>
      <p className="detail-hint">
        选择 1～{REVIEW_MAX_SOURCES} 个 Journal / Inbox（最多 {REVIEW_MAX_DATES} 个不同业务日期，非连续也可以，
        同一天多篇不重复占名额）。生成只创建可编辑预览，**不会**改动任何原文件；确认保存只会有一次。
      </p>

      {recoverables.length > 0 && (
        <section className="review-recovery" aria-label="可恢复的复盘请求">
          <h3 className="review-section-title">上次未完成的复盘</h3>
          <ul className="review-recovery-list">
            {recoverables.map((entry) => (
              <li key={entry.requestId} className="review-recovery-item">
                <span className="review-recovery-id">
                  请求 {entry.requestId.slice(0, 8)}…（锚点源 {entry.source.type}:{entry.source.id}）
                </span>
                <button type="button" disabled={lockInFlight}
                  onClick={() => void restoreEntry(entry)}>查询并恢复</button>
                <button type="button" disabled={lockInFlight}
                  onClick={() => dropRecovery(entry.requestId)}>移除入口</button>
              </li>
            ))}
          </ul>
          <p className="detail-hint">只持久化了请求 ID / kind / 源身份，不含正文；404 会移除入口且不自动重发。</p>
        </section>
      )}

      <section className="review-picker" aria-label="选择复盘源">
        <div className="review-tabs" role="group" aria-label="源类型">
          <button type="button" aria-pressed={browseType === 'journal'} disabled={lockInFlight}
            onClick={() => { setBrowseType('journal'); setPage(1) }}>Journal</button>
          <button type="button" aria-pressed={browseType === 'inbox'} disabled={lockInFlight}
            onClick={() => { setBrowseType('inbox'); setPage(1) }}>Inbox</button>
          <button type="button" onClick={() => setListRevision((value) => value + 1)} disabled={lockInFlight}>刷新列表</button>
        </div>

        {listStatus === 'loading' && <p className="app-state" role="status">加载中……</p>}
        {listStatus === 'error' && (
          <div className="app-state app-state-error" role="alert">
            <p>列表加载失败：{listError}</p>
            <button type="button" onClick={() => setListRevision((value) => value + 1)} disabled={lockInFlight}>重试读取</button>
          </div>
        )}
        {listStatus === 'success' && listResult && (
          <>
            {listResult.items.length === 0
              ? <p className="app-state">这里还没有可复盘的记录。</p>
              : (
                <ul className="review-source-list">
                  {listResult.items.map((item) => {
                    const isSelected = selected.some((entry) => sourceKey(entry.source) === `${browseType}:${item.id}`)
                    return (
                      <li key={`${browseType}:${item.id}`}>
                        <button type="button" className="review-source-item"
                          aria-pressed={isSelected} disabled={lockInFlight}
                          onClick={() => toggleItem(browseType, item.id, sourceDate(item))}>
                          <span className="journal-item-title">{isSelected ? '✓ ' : ''}{item.display_title}</span>
                          <span className="journal-item-date">{sourceDate(item) || '（无日期）'}</span>
                          <span className="journal-item-content">{item.content}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            <Pagination page={listResult.page} total={listResult.total} hasNext={listResult.has_next}
              onPageChange={setPage} disabled={lockInFlight} label="可复盘源分页" />
          </>
        )}

        <div className="review-selection-bar">
          <p className="review-selection-summary" role="status">
            已选 <strong>{summary.count}</strong> 篇 · {summary.dateCount} 个不同日期 · 用户正文
            <strong> {summary.totalCodePoints} </strong>字
            {summary.pendingTextCount > 0 ? `（${summary.pendingTextCount} 篇字数待载入）` : ''}
          </p>
          <div className="review-selection-actions">
            <button type="button" className="review-generate" onClick={() => void generate()} disabled={generateDisabled}>
              {selectionLabel(summary)}
            </button>
            <button type="button" onClick={clearSelection} disabled={lockInFlight || selected.length === 0}>清空选择</button>
          </div>
        </div>
        {actionError !== '' && <p className="detail-error" role="alert">{actionError}</p>}
      </section>

      {message !== '' && <p className="detail-success" role="status">{message}</p>}

      {review !== null && target !== null && (
        <ReviewPreview
          review={review}
          markdown={markdown}
          onMarkdownChange={(value) => { setMarkdown(value); setPendingSave(null) }}
          target={target}
          onTargetChange={(update) => { setTarget((prev) => (prev === null ? prev : { ...prev, ...update })); setPendingSave(null) }}
          appendAllowed={appendAllowed}
          disabled={previewDisabled}
          saving={saving}
          error={saveError}
          onConfirm={() => void confirmSave()}
          onCancel={() => onNavigate(removeAllFromSelection)}
        />
      )}

      {pendingSave !== null && review !== null && (
        <div className="review-retry" role="alert">
          <p>上一次确认没有收到服务器响应。请用**同样的内容**重试：同请求、同 body 只会回到同一个目标，不会创建第二篇。</p>
          <button type="button" onClick={() => void confirmSave()} disabled={saving}>用刚才的内容重试保存</button>
        </div>
      )}

      {review === null && phase !== 'idle' && (
        <p className="detail-hint" role="status">
          当前阶段：{reviewPhaseLabel(phase)}。生成过程中编辑、删除与导航已锁定；结束后即可继续。
        </p>
      )}
    </section>
  )
}

export default ReviewPage
