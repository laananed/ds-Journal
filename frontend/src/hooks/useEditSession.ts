/**
 * 应用级编辑会话的 React 接线（Stage 4 / S04-T02）。
 *
 * 这一层刻意很薄：会话状态、写队列、CAS、本地草稿判定全部在
 * `../state/editSessions.ts` 与 `../state/localJournalDrafts.ts` 的纯逻辑里，
 * 这里只做三件事：
 *
 * 1. `useSyncExternalStore` 订阅应用级会话表（页面卸载不销毁会话）；
 * 2. 把「输入 → 800ms 后写本地草稿」接成副作用，并如实回写本地状态；
 * 3. 提供 `useJournalDraftMirror`，让 T06 的 Writing/日记入口不必自己写存储逻辑。
 *
 * 本地写入与服务器提交是**两个独立状态**：`session.localState` 只表示
 * 「本机浏览器里有一份草稿」，`session.status` 才表示服务器是否已保存。
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  editSessionStore,
  type DocumentDraft,
  type EditSession,
  type EditSessionStore,
  type LocalDraftState,
  type SaveResult,
} from '../state/editSessions.ts'
import {
  createLocalDraftWriter,
  defaultDraftBackend,
  draftRecordKey,
  localDraftWriter,
  sortCandidates,
  type DraftCandidate,
  type JournalDraftKind,
  type LocalDraftWriter,
  type LocalJournalDraft,
} from '../state/localJournalDrafts.ts'
import type { JournalKind } from '../types/document.ts'

/** 订阅一个会话；会话不存在（未打开 / 已关闭）时返回 null。 */
export function useEditSession(
  sessionId: string | null,
  store: EditSessionStore = editSessionStore,
): EditSession | null {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getVersion(), [store])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return sessionId === null ? null : store.getSession(sessionId)
}

/** 订阅整张会话表（全局保存状态入口用）。 */
export function useEditSessionList(store: EditSessionStore = editSessionStore): EditSession[] {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getVersion(), [store])
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return store.listSessions()
}

/**
 * 会话的写操作集合。
 *
 * 返回的函数都是稳定引用（不随渲染变化），因此可以直接交给事件处理器；
 * 它们只转调应用级 store，不会因为本组件卸载而中断在途保存。
 */
export interface EditSessionActions {
  change: (draft: DocumentDraft, origin?: 'user_input' | 'system') => void
  save: () => Promise<SaveResult>
  retry: () => Promise<SaveResult>
  setComposing: (composing: boolean) => void
  close: () => void
}

export function useEditSessionActions(
  sessionId: string | null,
  store: EditSessionStore = editSessionStore,
): EditSessionActions {
  const change = useCallback((draft: DocumentDraft, origin: 'user_input' | 'system' = 'user_input') => {
    if (sessionId === null) return
    store.changeSession(sessionId, draft, origin)
  }, [sessionId, store])

  const save = useCallback(async () => {
    if (sessionId === null) return { kind: 'no_session' as const }
    return store.saveToSequence(sessionId)
  }, [sessionId, store])

  const retry = useCallback(async () => {
    if (sessionId === null) return { kind: 'no_session' as const }
    return store.retry(sessionId)
  }, [sessionId, store])

  const setComposing = useCallback((composing: boolean) => {
    if (sessionId === null) return
    store.setComposing(sessionId, composing)
  }, [sessionId, store])

  const close = useCallback(() => {
    if (sessionId === null) return
    store.closeSession(sessionId)
  }, [sessionId, store])

  return useMemo(
    () => ({ change, save, retry, setComposing, close }),
    [change, save, retry, setComposing, close],
  )
}

/* ------------------------------------------------------- 本地草稿镜像 */

export interface JournalDraftMirrorOptions {
  sessionId: string | null
  /** 本标签身份；由 `resolveTabId(sessionStorage, newLocalId())` 解析。 */
  tabId: string
  journalKind: JournalKind
  /** 打开草稿时捕获的带时区时刻（Ritual 的捕获日期依据）。 */
  draftStartedAt: string
  /** 草稿身份；默认与会话 id 相同（会话 id 在新建时就是稳定草稿身份）。 */
  draftId?: string
  /** 输入停稳多久后写本地（默认 400ms：比服务器 800ms 更早落本地）。 */
  delayMs?: number
  enabled?: boolean
  writer?: LocalDraftWriter
  store?: EditSessionStore
}

export interface JournalDraftMirrorState {
  localState: LocalDraftState
  localError: string
  /** 立即把当前草稿写入本地（切页 / 隐藏 / 关页前调用）。 */
  flushLocal: () => void
  /** 用户明确丢弃本地记录（不清服务器内容）。 */
  discardLocal: () => void
}

/** 补齐默认值之后的镜像参数（`draftId` / `delayMs` / `enabled` 必有值）。 */
type MirrorResolved = JournalDraftMirrorOptions & { draftId: string; delayMs: number; enabled: boolean }

function toRecord(
  session: EditSession,
  options: MirrorResolved,
  writeSeq: number,
): LocalJournalDraft {
  const firstRequest = session.firstRequest === null
    ? null
    : {
        client_create_id: session.firstRequest.client_create_id,
        payload: {
          title: session.firstRequest.draft.title,
          content_doc: session.firstRequest.draft.content_doc,
          journal_date: session.firstRequest.draft.date,
          folder_id: session.firstRequest.draft.folder_id,
          ...(session.firstRequest.extras ?? {}),
        },
        // 首次请求自己的序号，与下面的 `input_seq`（最新输入）分开保存。
        seq: session.firstRequest.seq,
      }
  return {
    schema: 1,
    draft_id: options.draftId,
    tab_id: options.tabId,
    file_id: session.fileId,
    base_revision: session.revision,
    journal_kind: options.journalKind as JournalDraftKind,
    business_date: session.draft.date,
    draft_started_at: options.draftStartedAt,
    title: session.draft.title,
    content_doc: session.draft.content_doc,
    folder_id: session.draft.folder_id,
    input_seq: session.inputSeq,
    // 写入序号只用于「较旧异步写不能覆盖较新」的排序：它必须能独立前进，
    // 否则「首次请求被冻结」这种不改输入的重写会被判成旧写入而丢弃。
    write_seq: writeSeq,
    first_request: firstRequest,
    updated_at: new Date().toISOString(),
  }
}

/** 仅供 `toRecord` 使用的必填化类型。 */

/**
 * 文档里有没有任何用户可见文字（只看 `type: 'text'` 的 `text`）。
 *
 * 不能直接遍历所有字符串：段落的 `attrs.id` 也是字符串，会把空文档判成有内容。
 */
function documentHasText(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false
  const record = node as Record<string, unknown>
  if (record.type === 'text') return typeof record.text === 'string' && record.text.trim() !== ''
  if (Array.isArray(record.content)) return record.content.some(documentHasText)
  return false
}

/**
 * 空草稿（无标题、无正文、也没有已发出的创建请求）不写本地记录。
 *
 * 编辑器挂载时会把初始文档同步进会话（`system` 来源），这会推进输入序号；
 * 若照写不误，每次打开写作页都会留下一份「空的本机草稿」，
 * 恢复面板会把它们当成待恢复内容，用户也不知道该恢复什么。
 */
function isEmptyDraft(session: EditSession): boolean {
  if (session.firstRequest !== null) return false
  if (session.draft.title.trim() !== '') return false
  return !documentHasText(session.draft.content_doc)
}
/**
 * 把会话草稿镜像到浏览器本地。
 *
 * 只在**用户输入**推进序号后写；服务器确认且没有更新输入时删除记录
 * （API §10：确认序号之前的旧响应不能清除更新草稿）。
 * 写失败时保留内存内容，并把 `localState` 置为 failed 让 UI 如实提示。
 */
export function useJournalDraftMirror(options: JournalDraftMirrorOptions): JournalDraftMirrorState {
  const store = options.store ?? editSessionStore
  const writer = options.writer ?? localDraftWriter
  const delayMs = options.delayMs ?? 400
  const enabled = options.enabled ?? true
  const session = useEditSession(options.sessionId, store)
  const resolved = useMemo<MirrorResolved>(() => ({
    ...options,
    draftId: options.draftId ?? options.sessionId ?? '',
    delayMs,
    enabled,
  }), [options, delayMs, enabled])

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastWrittenSeq = useRef(0)
  const lastWriteSeq = useRef(0)
  const lastFirstRequestKey = useRef<string | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const writeNow = useCallback(async (force = false) => {
    const sessionId = resolved.sessionId
    if (!enabled || sessionId === null) return
    const current = store.getSession(sessionId)
    if (current === null) return
    if (current.inputSeq === 0 && current.localState === 'idle') return
    if (isEmptyDraft(current)) return
    if (!force && current.inputSeq <= lastWrittenSeq.current && current.localState === 'saved') return

    store.setLocalState(sessionId, 'pending')
    const writeSeq = Math.max(lastWriteSeq.current + 1, current.inputSeq)
    const result = await writer.save(toRecord(current, resolved, writeSeq))
    const after = store.getSession(sessionId)
    if (after === null) return
    if (result.ok) {
      lastWriteSeq.current = writeSeq
      lastWrittenSeq.current = after.inputSeq
      store.setLocalState(sessionId, 'saved')
      return
    }
    store.setLocalState(sessionId, 'failed', result.message)
  }, [enabled, resolved, store, writer])

  const flushLocal = useCallback(() => {
    clearTimer()
    void writeNow()
  }, [clearTimer, writeNow])

  const discardLocal = useCallback(() => {
    clearTimer()
    const sessionId = resolved.sessionId
    if (sessionId === null) return
    void writer.remove(resolved.tabId, resolved.draftId)
    lastWrittenSeq.current = 0
    lastWriteSeq.current = 0
    lastFirstRequestKey.current = null
    store.setLocalState(sessionId, 'idle')
  }, [clearTimer, resolved, store, writer])

  // 输入停稳后写本地；只有输入序号真的前进才重新计时。
  useEffect(() => {
    if (!enabled || resolved.sessionId === null || session === null) return
    if (session.inputSeq === 0 || isEmptyDraft(session)) return
    if (session.inputSeq <= lastWrittenSeq.current) return
    clearTimer()
    timerRef.current = setTimeout(() => { void writeNow() }, delayMs)
    return clearTimer
  }, [clearTimer, delayMs, enabled, resolved.sessionId, session, writeNow])

  /**
   * 首次创建请求被冻结时补写一次本地记录。
   *
   * 本地镜像（400ms）比创建请求（800ms）更早，所以「首次 payload」出现时
   * 序号并没有前进；如果不补写，响应丢失后记录里 `first_request` 仍是 null，
   * 重新打开就只能当新草稿再创建一次——正是要避免的重复记录。
   * 只有从无到有时的这一下，不会在成功后（变成 null）再写一次。
   */
  useEffect(() => {
    if (!enabled || resolved.sessionId === null || session === null) return
    const key = session.firstRequest?.client_create_id ?? null
    if (key === null || key === lastFirstRequestKey.current) return
    if (session.inputSeq === 0) return
    lastFirstRequestKey.current = key
    clearTimer()
    void writeNow(true)
  }, [clearTimer, enabled, resolved.sessionId, session, writeNow])

  // 服务器确认且没有更新输入：清理本地记录（不删别人、不删更新过的）。
  useEffect(() => {
    if (!enabled || resolved.sessionId === null || session === null) return
    if (session.status !== 'saved' || session.fileId === null) return
    if (session.inputSeq !== session.ackedSeq) return
    // 已经清理过（本地序号归零且没有待写状态）就不再重复删除。
    if (lastWrittenSeq.current === 0 && session.localState === 'idle') return
    clearTimer()
    void writer.remove(resolved.tabId, resolved.draftId)
    lastWrittenSeq.current = 0
    lastWriteSeq.current = 0
    lastFirstRequestKey.current = null
    store.setLocalState(resolved.sessionId, 'idle')
  }, [clearTimer, enabled, resolved, session, store, writer])

  // 切页 / 隐藏 / 关页：尽力立即写一次（beforeunload 只作辅助，不作承诺）。
  useEffect(() => {
    if (!enabled || resolved.sessionId === null) return
    function handleHidden(): void {
      if (document.visibilityState === 'hidden') flushLocal()
    }
    window.addEventListener('pagehide', flushLocal)
    document.addEventListener('visibilitychange', handleHidden)
    return () => {
      window.removeEventListener('pagehide', flushLocal)
      document.removeEventListener('visibilitychange', handleHidden)
    }
  }, [enabled, flushLocal, resolved.sessionId])

  return {
    localState: session?.localState ?? 'idle',
    localError: session?.localError ?? '',
    flushLocal,
    discardLocal,
  }
}

/** 恢复候选读取：供 T06 在 Writing/日记入口列出可恢复草稿。 */
export async function listLocalDraftCandidates(
  writer: LocalDraftWriter = localDraftWriter,
): Promise<{ ok: boolean; candidates: DraftCandidate[]; error: string }> {
  const result = await writer.list()
  if (!result.ok) return { ok: false, candidates: [], error: result.message }
  return { ok: true, candidates: sortCandidates(result.records), error: '' }
}

/** 清理本应用的本地草稿（用户明确操作）。 */
export async function clearLocalDrafts(writer: LocalDraftWriter = localDraftWriter): Promise<string> {
  const result = await writer.clearAll()
  return result.ok ? '' : result.message
}

export { createLocalDraftWriter, defaultDraftBackend, draftRecordKey }
