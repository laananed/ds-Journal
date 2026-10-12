/**
 * Journal / Inbox 的局部陪伴写作入口（Stage 3 / S3-T07）。
 *
 * 职责边界（`docs/stage3-tasks.md` §9、`docs/stage3.md` §3、§7）：
 *
 * - **点击才调用**：不逐键调用、不做边写边响应、不做流式 UI；
 * - **点击先 flush**：调用前由页面 `prepare()` 落库最新有效草稿，失败就**不**发 AI；
 * - **独立问题栏**：问题作为单独对话信息随请求发送，**不**写进日记正文；
 * - **处理中锁**：`preparing/sending/polling` 期间锁定当前文件的编辑、删除与导航，
 *   最长 90 秒；这个锁与自动保存的 busy 完全分开，不会误解锁或死锁；
 * - **后端权威**：蓝块由后端附着，组件只用后端返回的完整文件刷新页面基线，
 *   自己绝不插入或伪造 AI 段；
 * - **恢复**：发送前把 `request_id` / `kind` / 源 typed 身份写进 localStorage，
 *   关页重开先 `GET /api/ai/requests/{id}`；404 移除失效入口且不自动重建，
 *   unknown 明确「可能已消耗 Token」且不自动换新 UUID 重发；
 * - **计量**：本次 Token 用后端返回的同一 `request_id` 全部模型子调用合计，
 *   unknown 不显示成 0，搜索请求数单列，前端不另存一份累计计数。
 *
 * 纯逻辑（状态机 / 恢复索引 / 轮询策略 / 引用安全 / 计量文案）在
 * `../utils/aiRequestState.ts`，可以被 `node --experimental-strip-types` 直接测试。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AiApiError, getAIRequest, postAILocal } from '../api/ai'
import TokenUsage from './TokenUsage'
import type { AILocalResponse, AIRequestDetail } from '../types/ai'
import {
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  addRecoveryEntry,
  aiCallLocksFile,
  aiPhaseLabel,
  applyAiQuery,
  applyAiResponse,
  applyAiTransportError,
  beginAiCall,
  beginAiPreparation,
  canStartAiCall,
  clearCallResult,
  findRecoveryEntry,
  formatCallUsage,
  initialAiCallState,
  newRequestId,
  nextPollDelay,
  normalizeQuestion,
  readRecoveryIndex,
  removeRecoveryEntry,
  shouldPoll,
  tickAiPolling,
  expirePolling,
  webStatusLabel,
  writeRecoveryIndex,
  type AiCallState,
  type AiSourceRef,
} from '../utils/aiRequestState'

/** 调用前的准备结论：`ok=false` 时页面已给出阻止原因，组件不发送请求。 */
export type AiPrepareResult = { ok: true; revision: number } | { ok: false; message: string }

export interface AiWritingActionsProps {
  /** 文件身份；为 null（新建尚未成功保存）时不能调用 AI。 */
  source: AiSourceRef | null
  /** 外部忙碌（例如正在删除某个 AI 段）：禁用入口，但不改变 AI 自身状态机。 */
  disabled?: boolean
  /**
   * 调用前：flush 最新有效草稿并返回**当前服务器版本**。
   * 失败（保存失败 / 版本冲突 / 输入不合法 / 尚无文件）返回 `ok:false`，不发 AI。
   */
  prepare: () => Promise<AiPrepareResult>
  /**
   * 后端返回的**完整文件**（AI 块已附着）→ 页面安全刷新保存基线。
   * `origin='recovery'` 表示来自关页重开后的查询，页面应避免覆盖正在编辑的草稿。
   */
  onServerFile: (file: unknown, origin: 'call' | 'recovery') => void
  /** 处理中锁变化；由 App 用它阻止导航。 */
  onLockChange?: (locked: boolean) => void
  /** 调用到达终态后刷新列表 / 计量（与 AI 结果分开，失败不影响结果）。 */
  onActivity?: () => void
}

function isVisible(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 把后端响应（或查询结果）交给状态机；noop 不登记恢复索引。 */
function reduceResponse(state: AiCallState, body: AILocalResponse | AIRequestDetail): AiCallState {
  return applyAiResponse(state, body)
}

function AiWritingActions({
  source, disabled = false, prepare, onServerFile, onLockChange, onActivity,
}: AiWritingActionsProps) {
  const [state, setState] = useState<AiCallState>(initialAiCallState)
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState('')

  const stateRef = useRef(state)
  const mountedRef = useRef(true)
  const busyRef = useRef(false)
  const prepareRef = useRef(prepare)
  const onServerFileRef = useRef(onServerFile)
  const onActivityRef = useRef(onActivity)
  const recoveredRef = useRef<string | null>(null)

  // 每次提交后把最新实现收进 ref：异步回调永远读到最新值，又不会重建状态机。
  useEffect(() => {
    stateRef.current = state
    prepareRef.current = prepare
    onServerFileRef.current = onServerFile
    onActivityRef.current = onActivity
  })

  const locked = aiCallLocksFile(state)
  const callDisabled = disabled || locked

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // 处理中锁：独立于自动保存 busy，卸载或结束都会解锁。
  useEffect(() => {
    onLockChange?.(locked)
    return () => { onLockChange?.(false) }
  }, [locked, onLockChange])

  /* --------------------------------------------------- 关页重开后的恢复 */

  useEffect(() => {
    if (source === null) return
    const key = `${source.type}:${source.id}`
    if (recoveredRef.current === key) return
    recoveredRef.current = key
    const entry = findRecoveryEntry(readRecoveryIndex(storage()), { type: source.type, id: source.id })
    if (entry === null) return
    // 只登记「有待查询的入口」，真正的结果由下面的有限轮询取回。
    setState({
      ...initialAiCallState(),
      phase: 'polling',
      requestId: entry.requestId,
      source: { type: entry.source.type, id: entry.source.id },
      message: '上次离开时这次调用还没有结果，正在向后端查询状态……',
      recovered: true,
    })
  }, [source])

  /* ------------------------------------------------------- 有限轮询 */

  useEffect(() => {
    if (state.phase !== 'polling' || state.requestId === null) return
    const requestId = state.requestId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const controller = new AbortController()

    const clear = (): void => {
      if (timer !== null) { clearTimeout(timer); timer = null }
    }
    const schedule = (delay: number): void => {
      if (cancelled) return
      clear()
      timer = setTimeout(() => { timer = null; void step() }, delay)
    }
    /** 同一时刻只允许一个状态查询在途（可见性变化可能重新调度）。 */
    let querying = false
    const step = async (): Promise<void> => {
      if (cancelled || querying) return
      const current = stateRef.current
      if (current.phase !== 'polling') return
      if (current.attempts >= POLL_MAX_ATTEMPTS) { setState((value) => expirePolling(value)); return }
      // 页面隐藏 / 组件卸载停止轮询；回到可见时由 visibilitychange 重新调度。
      if (!shouldPoll(current, { visible: isVisible(), mounted: true })) return
      querying = true
      setState((value) => tickAiPolling(value))
      let result: AIRequestDetail | 'missing'
      try {
        result = await getAIRequest(requestId, controller.signal)
      } catch (error: unknown) {
        querying = false
        if (cancelled) return
        if (error instanceof AiApiError && error.status === 404) result = 'missing'
        else if (error instanceof AiApiError && error.status >= 500) { schedule(POLL_INTERVAL_MS); return }
        else { setState((value) => applyAiQuery(value, 'missing')); return }
      }
      querying = false
      if (cancelled) return
      setState((value) => applyAiQuery(value, result))
      // 恢复查询拿到 applied：把后端**完整文件**交给页面刷新保存基线。
      // 少了这一步，页面只知道「结果已附着」，草稿基线却停在旧版本，下一次
      // 自动保存会被后端按「删除了 AI 段」拒绝（422/409）。
      if (result !== 'missing' && result.status === 'applied'
        && result.file !== null && result.file !== undefined) {
        onServerFileRef.current(result.file, 'recovery')
      }
      // 关键：一次查询仍是 pending 时**自己重排下一轮**。
      // 只靠 effect 依赖（phase/requestId）重建循环是不够的——pending 结果不会
      // 改变这两者，只排一次定时器就等于只查询一次，页面会永远停在等待结果。
      const delay = nextPollDelay(result)
      if (delay !== null) schedule(delay)
    }

    schedule(stateRef.current.attempts === 0 ? 0 : POLL_INTERVAL_MS)
    const onVisibility = (): void => {
      if (cancelled || timer !== null || querying) return
      if (isVisible() && stateRef.current.phase === 'polling') schedule(0)
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      clear()
      controller.abort()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
    // 只在进入/离开轮询或换 request_id 时重建循环；attempts 更新不重建，
    // 下一轮由 step 自己重排（见上面 nextPollDelay）。
  }, [state.phase, state.requestId])

  /* ------------------------------------------------ 轮询拿到终态后的收尾 */

  // 任何终态都各自刷新一次列表 / 计量；刷新失败不影响已经拿到的 AI 结果。
  const settledRef = useRef<string | null>(null)
  useEffect(() => {
    const phase = state.phase
    if (phase === 'idle' || phase === 'preparing' || phase === 'sending' || phase === 'polling') return
    const marker = `${phase}:${state.requestId ?? ''}`
    if (settledRef.current === marker) return
    settledRef.current = marker
    onActivityRef.current?.()
  }, [state.phase, state.requestId])

  /* ----------------------------------------------------------- 发起调用 */

  const runCall = useCallback(async (): Promise<void> => {
    if (busyRef.current) return
    const current = stateRef.current
    if (source === null || !canStartAiCall(current)) return

    const rawQuestion = question
    const trimmed = rawQuestion.trim()
    const normalizedQuestion = normalizeQuestion(rawQuestion)
    if (trimmed !== '' && normalizedQuestion === null) {
      setQuestionError('问题太长（最多 2,000 字）。请缩短后再发送，内容会保留在输入框里。')
      return
    }
    setQuestionError('')
    busyRef.current = true
    setState(beginAiPreparation(current, source))

    let prepared: AiPrepareResult
    try {
      prepared = await prepareRef.current()
    } catch {
      prepared = { ok: false, message: '保存草稿时出错，已停止调用 AI；输入仍保留在编辑器里。' }
    }
    if (!mountedRef.current) { busyRef.current = false; return }
    if (!prepared.ok) {
      busyRef.current = false
      setState((value) => ({
        ...value, phase: 'failed', requestId: null, message: prepared.message, mayHaveCharged: false,
      }))
      return
    }

    // UUID 在发送前创建，并**立刻**登记恢复索引（只写身份，不写正文/问题/Key）。
    const requestId = newRequestId()
    const activeSource = { type: source.type, id: source.id }
    writeRecoveryIndex(storage(), addRecoveryEntry(readRecoveryIndex(storage()), {
      requestId, kind: 'local', source: activeSource,
    }))
    setState(beginAiCall(stateRef.current, { requestId, source: activeSource }))

    let body: AILocalResponse | null = null
    try {
      const result = await postAILocal({
        request_id: requestId,
        source: { type: activeSource.type, id: activeSource.id, expected_revision: prepared.revision },
        ...(normalizedQuestion === null ? {} : { question: normalizedQuestion }),
      })
      body = result.body
    } catch (error: unknown) {
      busyRef.current = false
      if (!mountedRef.current) return
      const status = error instanceof AiApiError ? error.status : null
      const requestIdFromError = error instanceof AiApiError && 'requestId' in error
        ? (error as { requestId: string | null }).requestId : null
      if (status === 409 || status === 503 || status === 429 || status === 404
        || status === 422 || status === 428) {
        // 这些失败都发生在模型调用之前：移除刚登记的入口，避免误当「可能已计费」。
        writeRecoveryIndex(storage(), removeRecoveryEntry(readRecoveryIndex(storage()), requestId))
      }
      const message = error instanceof Error ? error.message : '请求失败'
      setState((value) => applyAiTransportError(value, { status, message, requestId: requestIdFromError }))
      return
    }
    busyRef.current = false
    if (!mountedRef.current) return
    const next = reduceResponse(stateRef.current, body)
    setState(next)
    if (next.phase === 'noop') {
      writeRecoveryIndex(storage(), removeRecoveryEntry(readRecoveryIndex(storage()), requestId))
      setQuestion('')
      return
    }
    if (next.phase === 'applied' || next.phase === 'ready' || next.phase === 'polling') {
      setQuestion('') // 已成功登记：问题是独立对话信息，不进正文。
    }
    const file = (body as AIRequestDetail).file
    if (next.phase === 'applied' && file !== null && file !== undefined) {
      onServerFileRef.current(file, 'call')
    }
  }, [question, source])

  const queryStatus = useCallback(async (): Promise<void> => {
    const requestId = stateRef.current.requestId
    if (requestId === null || busyRef.current) return
    busyRef.current = true
    setState((value) => ({ ...value, message: '正在查询这次调用的状态……' }))
    try {
      const detail = await getAIRequest(requestId)
      if (!mountedRef.current) { busyRef.current = false; return }
      setState((value) => applyAiQuery(value, detail))
      if (detail.status === 'applied' && detail.file !== null && detail.file !== undefined) {
        onServerFileRef.current(detail.file, 'recovery')
      }
    } catch (error: unknown) {
      if (!mountedRef.current) { busyRef.current = false; return }
      if (error instanceof AiApiError && error.status === 404) {
        writeRecoveryIndex(storage(), removeRecoveryEntry(readRecoveryIndex(storage()), requestId))
        setState((value) => applyAiQuery(value, 'missing'))
      } else {
        setState((value) => ({
          ...value,
          message: error instanceof Error ? error.message : '查询失败，请稍后重试',
        }))
      }
    } finally {
      busyRef.current = false
    }
  }, [])

  const clearEntry = useCallback((): void => {
    const requestId = stateRef.current.requestId
    if (requestId !== null) {
      writeRecoveryIndex(storage(), removeRecoveryEntry(readRecoveryIndex(storage()), requestId))
    }
    setState(clearCallResult(stateRef.current))
  }, [])

  const webInfo = useMemo(() => webStatusLabel(state.webStatus), [state.webStatus])
  const showQuery = state.phase === 'polling' || state.phase === 'unknown' || state.phase === 'failed'
  const showResend = state.phase === 'unknown' || state.phase === 'failed' || state.phase === 'conflict'
    || state.phase === 'blocked' || state.phase === 'applied' || state.phase === 'ready' || state.phase === 'noop'

  return (
    <section className="ai-actions" aria-label="AI 陪伴写作">
      <div className="ai-actions-head">
        <h4 className="ai-actions-title">AI 陪伴写作</h4>
        <span className={`ai-phase ai-phase-${state.phase}`} role="status">{aiPhaseLabel(state.phase)}</span>
      </div>

      {source === null ? (
        <p className="ai-actions-hint">
          这篇还没有服务器版本：先写下有效正文并保存成功，AI 才能读取它。
          这里不会用空文件占位。
        </p>
      ) : (
        <>
          {locked && (
            <p className="ai-actions-lock" role="status">
              处理中：该文件的编辑、删除与导航已临时锁定（最长 90 秒）。锁定与自动保存分开，不会误解锁。
            </p>
          )}
          {state.message !== '' && <p className="ai-actions-message" role="status">{state.message}</p>}

          <label className="ai-question">
            <span>单独问一句（独立对话，不会写进日记正文）</span>
            <textarea
              className="ai-question-input"
              rows={2}
              value={question}
              disabled={callDisabled}
              placeholder="例如：我为什么老想着这件事？"
              aria-label="单独问一句"
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          {questionError !== '' && <p className="ai-actions-error" role="alert">{questionError}</p>}

          <div className="ai-actions-buttons">
            <button type="button" onClick={() => void runCall()}
              disabled={callDisabled || !canStartAiCall(state)}>
              {locked ? '处理中……' : '让 AI 看看'}
            </button>
            {showQuery && (
              <button type="button" onClick={() => void queryStatus()} disabled={callDisabled}>
                查询状态
              </button>
            )}
            {showResend && (
              <button type="button" onClick={() => void runCall()} disabled={callDisabled}
                title="会创建一个新的 request_id，可能产生新的计费">
                重新提问（新的付费调用）
              </button>
            )}
            {state.recovered && (
              <button type="button" onClick={clearEntry} disabled={callDisabled}>清除恢复入口</button>
            )}
          </div>

          {state.recovered && state.reply !== null && (
            <div className="ai-actions-reply">
              <p className="ai-actions-reply-title">上次调用的结果（正文蓝块中已由后端附着）</p>
              <p className="ai-actions-reply-text">{state.reply}</p>
            </div>
          )}

          <p className="ai-actions-usage">
            本次计量（同一 request_id 的全部模型子调用）：{formatCallUsage(state.usage)}
          </p>
          <p className="ai-actions-web">
            联网状态：{webInfo.label}——{webInfo.hint}
          </p>

          {state.citations.length > 0 && (
            <ul className="ai-actions-citations">
              {state.citations.map((citation) => (
                <li key={citation.url}>
                  <a href={citation.url} target="_blank" rel="noreferrer noopener">{citation.title}</a>
                </li>
              ))}
            </ul>
          )}

          <p className="ai-actions-hint">
            蓝块由后端在调用边界插入，前端不自行插入；失败、冲突或状态不明都不会假装成功。
          </p>

          {/*
            历史调用消耗：复用 T03 的只读组件直接读后端，前端不另存一份累计计数。
            每次阶段变化重挂载一次，让刚完成的调用立即出现在列表里。
          */}
          <TokenUsage
            key={`${state.requestId ?? 'none'}:${state.phase}`}
            source={source}
            disabled={locked}
          />
        </>
      )}
    </section>
  )
}

export default AiWritingActions
