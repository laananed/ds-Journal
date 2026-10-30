import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  InsightApiError,
  deleteInsight,
  getInsight,
  listInsights,
  updateInsight,
} from '../api/insights'
import FileCard from '../components/FileCard'
import FolderSelect from '../components/FolderSelect'
import InsightDrafts from '../components/InsightDrafts'
import MarkdownContent from '../components/MarkdownContent'
import Pagination from '../components/Pagination'
import RichTextEditor from '../editor/RichTextEditor.tsx'
import type { Insight, InsightPage as InsightPageData } from '../types/insight'
import type { ContentDocument } from '../types/document'
import type { FlushResult } from '../hooks/useAutosave'
import { useEditSession, useEditSessionActions } from '../hooks/useEditSession'
import {
  displayStatus,
  editSessionStore,
  newKey,
  statusLabel,
  type DocumentDraft,
  type FileMutation,
} from '../state/editSessions'
import {
  INSIGHT_SESSION_TAB,
  findInsightSession,
  insightDraftSessionId,
  insightHasUnsavedInput,
  insightSessionId,
  insightToServerFile,
  insightTransport,
  legacyNodeIdFor,
} from '../state/insightSession'
import {
  blankInsightDraft,
  insightDraftIssue,
  insightDraftSavable,
  insightToDraft,
  isExactLegacyDocument,
  legacyTextDocument,
  seedInsightDraft,
} from '../utils/insightDraft'
import type { InsightDraftSeed } from '../utils/insightAiDraft'
import { formatServerTimestamp } from '../utils/journalDetail'
import { nearestValidPage } from '../utils/pagination'

/**
 * Insight 模块（Stage 2 / S2-T06 → Stage 4 / S04-T11）。
 *
 * T11 的适配边界：
 *
 * - **统一编辑器**：正文用 T03 的 `RichTextEditor`，保存进 T02 的应用级会话
 *   （`state/editSessions.ts` + `state/insightSession.ts`），不再由页面自建
 *   自动保存队列。切页/卸载不会丢在途请求，导航仍由 App 统一 flush。
 * - **只写 JSON**：创建与 PATCH 都只提交 `content_doc`，不发送旧 `content`
 *   或 `content_blocks`，因此不存在绕过 JSON 作者校验的写入口（API §2）。
 * - **旧格式不自动转换**：`document_format === "legacy"` 的记录先只读呈现原文，
 *   用户显式点「转换为富文本」才发出「单个 user legacyText、原文逐字相同」的
 *   等价转换；服务端只接受这一种转换，其余一律 409 `legacy_conversion_required`。
 * - **创建幂等**：AI 草稿种子带稳定 `createKey`，重试/重放回同一份文件；
 *   「另加一份」换新键（沿用 S3-T10 语义）。
 */
export interface InsightDraftRequest {
  seed: InsightDraftSeed
  key: number
}

interface InsightPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
  /** App：把当前编辑面板的 flush 交给导航前的保存检查。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  /** 其他模块（Folder 混合卡片）请求打开某条 Insight；同模块后续请求也消费。 */
  initialOpen?: { id: number; key: number } | null
  onOpenRequestConsumed?: () => void
  /** 父级（复盘预览 / App）已经在展示的草稿列表；查看本身零写入。 */
  drafts?: InsightDraftSeed[]
  /** 用户主动「添加为 Insight」的回调。 */
  onAddDraft?: (seed: InsightDraftSeed) => void
  /** 父级直接要求用这份草稿进入编辑器（已消费时传 null）。 */
  initialDraft?: InsightDraftRequest | null
  onAddDraftConsumed?: () => void
}

type InsightPanelShape =
  | { kind: 'create'; key: number; savedId?: number; seed?: InsightDraftSeed }
  | { kind: 'detail'; key: number; id: number }

/** 输入停稳多久后提交到服务器（与原页面级自动保存同一口径）。 */
const SAVE_DEBOUNCE_MS = 800

interface InsightPanelProps {
  panel: InsightPanelShape
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
  onCreated: (id: number) => void
  onChanged: () => void
  onDeleted: () => void
  onClose: () => void
}

function InsightPanel({
  panel, onDirtyChange, onBusyChange, onFlushReady, onResolveLink, onNavigate, onCreated, onChanged, onDeleted, onClose,
}: InsightPanelProps) {
  const insightId = panel.kind === 'detail' ? panel.id : null
  // T10：来自 AI 草稿的首次创建；种子只用于初始化编辑内容与创建键。
  const seed = panel.kind === 'create' ? panel.seed : undefined

  // 稳定草稿身份：面板首次渲染时确定，之后不随渲染/输入变化（新建后不重建编辑器）。
  const [draftId] = useState(() => (seed ? `seed-${seed.createKey}` : newKey()))
  /** 请求键：新建草稿键或 `insight:<id>`，只用于「打开会话」这一步。 */
  const requestedSessionId = insightId !== null ? insightSessionId(insightId) : insightDraftSessionId(draftId)
  /**
   * 实际绑定会话（D1）：创建成功后会话仍在 `insight:draft:<key>` 下（会话核心按
   * 同一草稿 / 同一文件去重），因此除了请求键还要按草稿与文件身份解析；
   * 订阅、写操作、关闭与冲突恢复都用解析结果，不再二次假设 `insight:<id>`。
   */
  const requestedSession = useEditSession(requestedSessionId)
  const session = requestedSession ?? findInsightSession(editSessionStore, { fileId: insightId, draftId })
  const sessionId = session?.sessionId ?? requestedSessionId
  // 卸载清理必须拿到「当时」的绑定键：清理不能在依赖变化时提前关会话。
  const sessionIdRef = useRef(sessionId)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  const [file, setFile] = useState<Insight | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(insightId === null ? 'ready' : 'loading')
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>(panel.kind === 'create' ? 'edit' : 'view')
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [writeError, setWriteError] = useState('')
  const [notice, setNotice] = useState('')
  const [converting, setConverting] = useState(false)
  /** 最近一次服务器响应：只用于同步详情与列表，不冒充「已保存」状态。 */
  const [lastSaved, setLastSaved] = useState<Insight | null>(null)

  const writing = useRef(false)
  const reported = useRef('')
  const createdRef = useRef(false)
  // 父级回调每次渲染都会换引用：放进 ref，避免把「服务器确认一次」变成重复通知。
  const notifyRef = useRef({ onCreated, onChanged })
  useEffect(() => { notifyRef.current = { onCreated, onChanged } }, [onCreated, onChanged])

  // 传输层只建一次：会话凭对象身份判断是否需要在重新打开时更新它。
  const transport = useMemo(() => insightTransport({ onSaved: setLastSaved }), [])

  const actions = useEditSessionActions(sessionId)

  const fallbackDraft = useMemo<DocumentDraft>(
    () => (seed ? seedInsightDraft(seed) : blankInsightDraft()),
    [seed],
  )
  const draft = session?.draft ?? fallbackDraft
  const saveStatus = session === null ? 'saved' : displayStatus(session)
  const issue = insightDraftIssue(draft)
  const legacyLocked = file !== null && file.document_format === 'legacy'
  const isCreate = session === null ? panel.kind === 'create' : session.fileId === null
  const busy = deleteStage === 'deleting' || converting

  // ---- 会话登记 -------------------------------------------------------
  // 创建面板只登记会话，不发任何请求；首次有效保存才创建文件。
  useEffect(() => {
    if (panel.kind !== 'create') return
    editSessionStore.openSession({
      sessionId: requestedSessionId,
      type: 'insight',
      tabId: INSIGHT_SESSION_TAB,
      draft: seed ? seedInsightDraft(seed) : blankInsightDraft(),
      createKey: seed?.createKey,
      transport,
      isSavable: insightDraftSavable,
    })
  }, [panel.kind, seed, requestedSessionId, transport])

  // 已有 Insight：真实读取详情后再登记会话（legacy 用等价转换文档作基线）。
  // 初值已是 `loading`；重读入口在事件处理里显式改状态，避免在 effect 内同步 setState。
  useEffect(() => {
    if (insightId === null) return
    const controller = new AbortController()
    getInsight(insightId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setFile(data)
      setNotFound(false)
      setLoadError('')
      editSessionStore.openSession({
        sessionId: requestedSessionId,
        type: 'insight',
        tabId: INSIGHT_SESSION_TAB,
        draft: insightToDraft(data, legacyNodeIdFor(data.id)),
        file: insightToServerFile(data),
        transport,
        isSavable: insightDraftSavable,
      })
      setStatus('ready')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setFile(null)
      setNotFound(error instanceof InsightApiError && error.status === 404)
      setLoadError(error instanceof Error ? error.message : '读取失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [insightId, reloadToken, requestedSessionId, transport])

  // ---- 保存 -----------------------------------------------------------

  const guardedSave = useCallback(async (): Promise<FlushResult> => {
    // 没有未提交输入（刚打开就走 / 内容已同步 / 空草稿）不拦住导航，
    // 避免把「空白草稿」误报成「最新改动还没保存成功」。
    if (!insightHasUnsavedInput(editSessionStore.getSession(sessionId))) return 'clean'
    // 空白/超长不提交，由界面说明原因；不制造空记录。
    if (issue !== '') return 'blocked'
    const result = await actions.save()
    return result.kind === 'blocked' ? 'blocked' : 'clean'
  }, [actions, issue, sessionId])

  const saveRef = useRef(guardedSave)
  useEffect(() => { saveRef.current = guardedSave }, [guardedSave])

  // 导航前的统一 flush：由 App 在离开任何出口前调用。
  useEffect(() => {
    onFlushReady?.(guardedSave)
    return () => onFlushReady?.(null)
  }, [guardedSave, onFlushReady])

  // 只有真实用户输入才调度自动保存；载入/系统回填不触发提交。
  useEffect(() => {
    if (session === null || session.userInputSeq === 0) return
    if (session.status === 'conflict' || session.status === 'failed' || session.status === 'missing') return
    const timer = setTimeout(() => { void saveRef.current() }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [session])

  // 面板卸载：尽力提交一次（会话是应用级的，请求不会因卸载被取消）；
  // 从未输入、也没有服务器身份的空草稿会话直接关闭，避免残留空会话。
  useEffect(() => () => {
    const key = sessionIdRef.current
    const current = editSessionStore.getSession(key)
    if (current !== null && current.fileId === null && current.inputSeq === 0) {
      editSessionStore.closeSession(key)
      return
    }
    void saveRef.current()
  }, [])

  // 服务器确认后同步详情与列表：只用真实响应，不把「已排队」当成已保存。
  useEffect(() => {
    if (lastSaved === null || session === null) return
    if (session.status !== 'saved' || session.fileId === null) return
    if (lastSaved.id !== session.fileId) return
    const marker = `${lastSaved.id}:${lastSaved.revision}`
    if (reported.current === marker) return
    reported.current = marker
    setFile(lastSaved)
    if (panel.kind === 'create' && !createdRef.current) {
      createdRef.current = true
      notifyRef.current.onCreated(lastSaved.id)
    } else notifyRef.current.onChanged()
  }, [lastSaved, session, panel.kind])

  const dirty = saveStatus !== 'saved'
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  // ---- 编辑动作 -------------------------------------------------------

  function startEditing() {
    if (file === null) return
    setDeleteStage('idle')
    setWriteError('')
    setNotice('')
    setMode('edit')
  }
  function exitEditing() {
    setDeleteStage('idle')
    setWriteError('')
    setNotice('')
    // 先让 App 的导航 flush 把最新草稿落库，再切回只读视图。
    onNavigate(() => {
      void (async () => {
        await saveRef.current()
        if (lastSaved !== null && lastSaved.id === file?.id) setFile(lastSaved)
        setMode('view')
      })()
    })
  }
  function changeTitle(value: string) {
    actions.change({ ...draft, title: value })
  }
  function changeFolder(folderId: number | null) {
    actions.change({ ...draft, folder_id: folderId })
  }
  function changeContent(document: ContentDocument) {
    actions.change({ ...draft, content_doc: document })
  }

  /**
   * 旧格式 → 富文本的显式等价转换。
   *
   * 走应用级写队列（`runFileCommand`）：先落库待保存输入，再在队列内发这一次
   * PATCH，最后用服务器响应更新会话基线与详情。旧 `content` 原值不被清空，
   * 检查点/引用/编辑时间由服务端保留（API §2「T01 过渡选择」）。
   */
  async function convertLegacy() {
    if (file === null || converting) return
    const converted = legacyTextDocument(file.content, legacyNodeIdFor(file.id))
    if (!isExactLegacyDocument(converted, file.content)) {
      setWriteError('旧格式原文与转换文档不一致，已停止转换；正文没有被修改。')
      return
    }
    setConverting(true)
    onBusyChange(true)
    setWriteError('')
    setNotice('')
    try {
      const mutation = await editSessionStore.runFileCommand(sessionId, async (): Promise<FileMutation> => {
        const current = editSessionStore.getSession(sessionId)
        const baseRevision = current?.revision ?? file.revision
        const saved = await updateInsight(file.id, {
          expected_revision: baseRevision,
          content_doc: converted,
          document_schema_version: 1,
        })
        setLastSaved(saved)
        return {
          files: [{ type: 'insight', file: insightToServerFile(saved) }],
          effects: [{
            type: 'insight',
            id: saved.id,
            base_revision: baseRevision,
            revision: saved.revision,
            ops: [],
          }],
          request_id: null,
        }
      })
      if (mutation === null) {
        setWriteError('转换失败：当前会话不可用，请重新打开这条 Insight 后再试。')
        return
      }
      // 详情与会话基线由「服务器确认」effect 统一同步（这里不读可能已过期的 lastSaved）。
      setNotice('已把旧格式正文按原文逐字转换为富文本，现在可以编辑；旧 content 原值由服务端保留。')
    } catch (error: unknown) {
      setWriteError(error instanceof Error ? error.message : '转换失败，请稍后重试')
    } finally {
      setConverting(false)
      onBusyChange(false)
    }
  }

  /** 冲突处理：读服务器最新版本后，选择保留本地草稿或采用服务器内容。 */
  async function resync(choice: 'keep' | 'take') {
    if (insightId === null) return
    setWriteError('')
    try {
      const server = await getInsight(insightId)
      const target = insightToServerFile(server)
      if (choice === 'take') {
        editSessionStore.resolveTakeServer(sessionId, target)
        setFile(server)
        return
      }
      editSessionStore.resolveKeepLocal(sessionId, target)
      await actions.save()
    } catch (error: unknown) {
      setWriteError(error instanceof Error ? error.message : '读取服务器版本失败，请稍后重试')
    }
  }

  async function confirmDelete() {
    if (file === null || writing.current) return
    writing.current = true
    onBusyChange(true)
    setDeleteStage('deleting')
    setWriteError('')
    try {
      // 契约：软删除必须携带当前 revision（缺 428 / 旧 409）。
      await deleteInsight(file.id, file.revision)
      // 用户明确删除：关闭会话，避免内存草稿把已删除的文件"复活"成本地待保存内容。
      actions.close()
      onDirtyChange(false)
      onDeleted()
    } catch (error: unknown) {
      if (error instanceof InsightApiError && error.status === 404) {
        actions.close()
        onDirtyChange(false)
        onDeleted()
      } else if (error instanceof InsightApiError && error.status === 409) {
        setDeleteStage('idle')
        setWriteError('这条记录已在别处发生变化，已重新读取，请再确认一次。')
        setReloadToken((value) => value + 1)
      } else {
        setDeleteStage('idle')
        setWriteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  const statusBanner = (
    <div className={`autosave-status autosave-${saveStatus}`} role="status" aria-live="polite">
      <span className="autosave-label">{statusLabel(saveStatus)}</span>
      <span className="autosave-hint">
        {saveStatus === 'conflict' || saveStatus === 'failed' || saveStatus === 'missing'
          ? (session?.error ?? '')
          : saveStatus === 'unsaved' ? '仍在编辑器中，尚未提交到服务器。' : '内容已同步到服务器。'}
      </span>
      {saveStatus === 'failed' && (
        <button type="button" onClick={() => { void actions.retry() }}>重试保存</button>
      )}
      {saveStatus === 'conflict' && (
        <>
          <button type="button" onClick={() => { void resync('keep') }}>用我的草稿重试</button>
          <button type="button" onClick={() => { void resync('take') }}>采用服务器版本</button>
        </>
      )}
      {saveStatus === 'missing' && (
        <button type="button" onClick={() => { void resync('take') }}>重新读取服务器状态</button>
      )}
    </div>
  )

  return (
    <section className="journal-editor" aria-label={isCreate ? '新建 Insight' : 'Insight 详情'}>
      <div className="detail-header">
        <h2>{isCreate ? (seed ? '添加 AI 草稿为 Insight' : '新建 Insight') : 'Insight 详情'}</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>

      {mode === 'edit' && status === 'ready' && (
        <>
          <p className="detail-hint">
            Insight 没有所属日期，也不需要来源或 AI 信息；正文以统一富文本 JSON 保存。
            正文里的 <code>[[标题]]</code> 在阅读态可直接点击；编辑时按住 Ctrl（⌘）再点击。
          </p>
          {seed && (
            <p className="detail-hint" role="status">
              这份内容来自复盘的 AI 草稿，只包含一个观点和它的依据。你可以先改观点、补事实、换 Folder，
              也可以直接放弃；只有第一次有效内容保存成功后才会创建文件。
            </p>
          )}
          {statusBanner}
          {legacyLocked && (
            <div className="detail-confirm" role="status">
              <p>
                这篇 Insight 仍是旧格式正文（纯文本）。为避免未经等价验证的覆盖，编辑器暂不开放：
                转换会保留原文逐字（服务端只在「单个旧文段、原文完全相同」时接受），旧 content 原值不被清空。
              </p>
              <div className="detail-confirm-actions">
                <button type="button" onClick={() => { void convertLegacy() }} disabled={busy}>
                  {converting ? '转换中……' : '转换为富文本'}
                </button>
                <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
              </div>
            </div>
          )}
          <form className="editor-form" onSubmit={(event) => { event.preventDefault(); void saveRef.current() }}>
            <label className="editor-field"><span>标题（留空显示为“未命名 Insight”）</span>
              <input type="text" value={draft.title} disabled={busy}
                onChange={(event) => changeTitle(event.target.value)} />
            </label>
            {!legacyLocked && (
              <div className="editor-field"><span>正文</span>
                <RichTextEditor doc={draft.content_doc as ContentDocument} label="Insight 正文"
                  onUserChange={changeContent} onLink={onResolveLink} />
              </div>
            )}
            {legacyLocked && <MarkdownContent source={file?.content ?? ''} onLink={onResolveLink} disabled={busy} />}
            <FolderSelect value={draft.folder_id} disabled={busy}
              onChange={(folderId) => changeFolder(folderId)} />
            {issue !== '' && (
              <p className="detail-hint" role="status">
                {issue === 'blank'
                  ? '空白输入不会提交，也不会创建空记录；内容保留在编辑器里。'
                  : '正文超过 50,000 个字符，暂不提交；内容保留在编辑器里。'}
              </p>
            )}
            <div className="editor-actions">
              <button type="submit" disabled={busy || issue !== ''}>立即保存</button>
              <button type="button" onClick={() => (isCreate ? onClose() : exitEditing())} disabled={busy}>
                {isCreate ? (seed ? '放弃这份草稿' : '取消新建') : '返回查看'}
              </button>
            </div>
          </form>
          {notice && <p className="detail-success" role="status">{notice}</p>}
          {writeError && <p className="detail-error" role="alert">{writeError}</p>}
        </>
      )}

      {status === 'loading' && <p className="detail-state" role="status">正在读取详情……</p>}
      {status === 'error' && (
        <div className="detail-state detail-state-error" role="alert">
          <p>{notFound ? `该 Insight 不存在（id ${insightId}），可能已移入回收箱。` : `读取详情失败：${loadError}`}</p>
          <button type="button" disabled={busy} onClick={() => {
            setStatus('loading')
            setFile(null)
            setNotFound(false)
            setLoadError('')
            setReloadToken((value) => value + 1)
          }}>重新读取</button>
        </div>
      )}

      {status === 'ready' && file && mode === 'view' && (
        <>
          <h3 className="detail-title">
            {session !== null && insightHasUnsavedInput(session) && draft.title.trim() !== ''
              ? draft.title
              : file.display_title}
          </h3>
          <dl className="detail-meta">
            <div className="detail-meta-row"><dt>id</dt><dd>{file.id}</dd></div>
            <div className="detail-meta-row"><dt>版本</dt><dd>{file.revision}</dd></div>
            <div className="detail-meta-row"><dt>正文格式</dt>
              <dd>{legacyLocked ? '旧格式（纯文本，未转换）' : '统一富文本（JSON schema 1）'}</dd></div>
            {file.folder_id !== null && (
              <div className="detail-meta-row"><dt>所属 Folder</dt><dd>{file.folder_id}</dd></div>
            )}
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(file.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(file.updated_at)}</dd></div>
          </dl>
          {/* 阅读态：有 JSON 正文就用统一只读编辑器（与编辑态同一 schema）；
              本地还有未提交输入时优先显示本地草稿，避免「看起来丢字」；
              legacy 记录只呈现服务器投影的原文，不做任何自动转换。 */}
          {session !== null && insightHasUnsavedInput(session) && (
            <p className="detail-hint" role="status">
              当前显示本地尚未提交到服务器的输入（服务器版本 v{file.revision}）。
              返回列表或切页前会先尝试保存，保存失败时不会丢弃这些改动。
            </p>
          )}
          {file.content_doc
            ? (
              <div className="writing-reading">
                <RichTextEditor
                  doc={session !== null && insightHasUnsavedInput(session)
                    ? draft.content_doc as ContentDocument
                    : file.content_doc}
                  readOnly label="Insight 正文（只读）" onLink={onResolveLink} />
              </div>
            )
            : <MarkdownContent source={file.content} onLink={onResolveLink} disabled={busy} />}
          <div className="detail-actions">
            <button type="button" onClick={startEditing} disabled={busy}>修改</button>
            {deleteStage === 'idle' && (
              <button type="button" className="detail-danger"
                onClick={() => setDeleteStage('confirming')} disabled={busy}>移入回收箱</button>
            )}
          </div>
          {deleteStage === 'confirming' && (
            <div className="detail-confirm">
              <p>这篇 Insight 将移入回收箱，可以恢复。确定要移入回收箱吗？</p>
              <div className="detail-confirm-actions">
                <button type="button" className="detail-danger" onClick={confirmDelete} disabled={busy}>确认移入回收箱</button>
                <button type="button" onClick={() => setDeleteStage('idle')} disabled={busy}>取消</button>
              </div>
            </div>
          )}
          {deleteStage === 'deleting' && <p className="detail-state" role="status">正在删除……</p>}
          {writeError && <p className="detail-error" role="alert">{writeError}（记录仍保留，可稍后重试。）</p>}
        </>
      )}
    </section>
  )
}

function InsightPage({
  onDirtyChange, onBusyChange, onResolveLink, onNavigate, onFlushReady, initialOpen = null, onOpenRequestConsumed,
  drafts = [], onAddDraft = undefined, initialDraft = null, onAddDraftConsumed,
}: InsightPageProps) {
  // 初始外部请求直接进入详情；后续同模块链接由下面的 effect 消费。
  const [panel, setPanel] = useState<InsightPanelShape | { kind: 'list' }>(
    initialOpen ? { kind: 'detail', id: initialOpen.id, key: initialOpen.key } : { kind: 'list' },
  )
  // 从外部初始打开的序号继续递增，避免首次模块内切换复用旧 Panel。
  const keyRef = useRef(initialOpen?.key ?? 0)
  const consumedOpenKey = useRef(initialOpen?.key)
  function nextKey() {
    keyRef.current += 1
    return keyRef.current
  }

  const [listPage, setListPage] = useState(1)
  const [listResult, setListResult] = useState<InsightPageData | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)

  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')

  const [busy, setBusy] = useState(false)

  function updateBusy(value: boolean) {
    setBusy(value)
    onBusyChange(value)
  }

  // 打开请求已消费：通知 App 清空，避免下次挂载重复打开同一条记录。
  useEffect(() => {
    if (initialOpen === null) return
    if (consumedOpenKey.current !== initialOpen.key) {
      consumedOpenKey.current = initialOpen.key
      keyRef.current = Math.max(keyRef.current, initialOpen.key) + 1
      setPanel({ kind: 'detail', id: initialOpen.id, key: keyRef.current })
    }
    onOpenRequestConsumed?.()
  }, [initialOpen, onOpenRequestConsumed])

  // 父级（复盘预览）要求用某份草稿进入编辑器；同 key 只消费一次。
  const consumedDraftKey = useRef<number | null>(null)
  useEffect(() => {
    if (!initialDraft) return
    if (consumedDraftKey.current !== initialDraft.key) {
      consumedDraftKey.current = initialDraft.key
      keyRef.current += 1
      setNotice('')
      setActionError('')
      setPanel({ kind: 'create', key: keyRef.current, seed: initialDraft.seed })
    }
    onAddDraftConsumed?.()
  }, [initialDraft, onAddDraftConsumed])

  useEffect(() => {
    const controller = new AbortController()
    listInsights(undefined, listPage, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setListPage(validPage)
        return
      }
      setListResult(data)
      setListStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setListResult(null)
      setListError(error instanceof Error ? error.message : '加载失败，请稍后重试')
      setListStatus('error')
    })
    return () => controller.abort()
  }, [listPage, listRevision])

  function beginListLoading() {
    setListStatus('loading')
    setListError('')
    setListResult(null)
  }
  function refreshList() {
    beginListLoading()
    setListRevision((value) => value + 1)
  }
  function showList() {
    onDirtyChange(false)
    setNotice('')
    setActionError('')
    setPanel({ kind: 'list' })
  }
  function openInsight(id: number) {
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setActionError('')
      setPanel({ kind: 'detail', id, key: nextKey() })
    })
  }
  function newInsight() {
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setActionError('')
      setPanel({ kind: 'create', key: nextKey() })
    })
  }
  /** T10：用 AI 草稿进入既有 Insight 编辑器；查看草稿本身零写入。 */
  function addDraftInsight(draftSeed: InsightDraftSeed) {
    onAddDraft?.(draftSeed)
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setActionError('')
      setPanel({ kind: 'create', key: nextKey(), seed: draftSeed })
    })
  }
  function changePage(value: number) {
    onNavigate(() => {
      showList()
      beginListLoading()
      setListPage(value)
    })
  }

  function handleCreated(id: number) {
    // 列表身份只用于高亮；Dirty 与写队列仍归面板内的会话。
    setPanel((current) => current.kind === 'create' ? { ...current, savedId: id } : current)
    refreshList()
  }
  function handleChanged() {
    refreshList()
  }
  function handleDeleted() {
    onDirtyChange(false)
    setNotice('已移入回收箱，可以恢复。可到 Trash 页面查看或恢复。')
    setPanel({ kind: 'list' })
    refreshList()
  }

  return (
    <section className="insight-page" aria-label="Insight 模块">
      <section className="app-toolbar" aria-label="Insight 工具">
        <button type="button" onClick={newInsight} disabled={busy}>新建 Insight</button>
        <button type="button" onClick={() => onNavigate(showList)} disabled={busy}>Insight 列表</button>
      </section>

      {notice && <p className="detail-success" role="status">{notice}</p>}
      {actionError && <p className="detail-error" role="alert">{actionError}</p>}

      {/* 父级（复盘预览 / App）已提供草稿时才展示；列表态才展示，避免与编辑器抢注意力。 */}
      {panel.kind === 'list' && drafts.length > 0 && (
        <InsightDrafts drafts={drafts} busy={busy}
          onAddInsight={addDraftInsight}
          onOpenFile={(file) => openInsight(file.id)}
          onDismiss={() => onNavigate(showList)} />
      )}

      {panel.kind === 'create' && (
        <InsightPanel key={`create-${panel.key}`} panel={panel}
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onFlushReady={onFlushReady}
          onNavigate={onNavigate} onResolveLink={onResolveLink}
          onCreated={handleCreated} onChanged={handleChanged} onDeleted={handleDeleted}
          onClose={() => onNavigate(showList)} />
      )}
      {panel.kind === 'detail' && (
        <InsightPanel key={`detail-${panel.key}`} panel={panel}
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onFlushReady={onFlushReady}
          onNavigate={onNavigate} onResolveLink={onResolveLink}
          onCreated={handleCreated} onChanged={handleChanged} onDeleted={handleDeleted}
          onClose={() => onNavigate(showList)} />
      )}

      <section className="journal-results" aria-label="Insight 列表">
        {listStatus === 'loading' && <p className="app-state" role="status">加载中……</p>}
        {listStatus === 'error' && (
          <div className="app-state app-state-error" role="alert">
            <p>列表加载失败：{listError}</p>
            <button type="button" onClick={refreshList} disabled={busy}>重试</button>
          </div>
        )}
        {listStatus === 'success' && listResult && (
          <>
            {listResult.items.length === 0
              ? <p className="app-state">还没有任何 Insight 记录。</p>
              : (
                <ul className="journal-list">
                  {listResult.items.map((insight) => (
                    <li key={`${insight.type}:${insight.id}`}>
                      <FileCard file={insight} onOpen={(value) => openInsight(value.id)}
                        selected={(panel.kind === 'detail' && panel.id === insight.id) || (panel.kind === 'create' && panel.savedId === insight.id)} disabled={busy} />
                    </li>
                  ))}
                </ul>
              )}
            <Pagination page={listResult.page} total={listResult.total} hasNext={listResult.has_next}
              onPageChange={changePage} disabled={busy} label="Insight 列表分页" />
          </>
        )}
      </section>
    </section>
  )
}

export default InsightPage
