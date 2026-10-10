import { useEffect, useRef, useState } from 'react'
import { JournalApiError, deleteJournal, getJournal, updateJournal } from '../api/journals'
import { WritingApiError, deleteAiBlock } from '../api/writing'
import FolderSelect from './FolderSelect'
import WritingContent from './WritingContent'
import WritingEditor from './WritingEditor'
import { formatServerTimestamp } from '../utils/journalDetail'
import { useAutosave, type AutosaveFile, type FlushResult } from '../hooks/useAutosave'
import {
  autosaveHint,
  draftToSnapshot,
  isSnapshotPatchEmpty,
  snapshotPatch,
  statusLabel,
  type DraftSnapshot,
} from '../utils/autosave'
import { legacyBlocksFromContent, projectBlocks } from '../utils/writingBlocks'
import type { Journal, JournalUpdate } from '../types/journal'
import type { Block } from '../types/writing'

interface JournalDetailProps {
  journalId: number
  onBusyChange: (busy: boolean) => void
  onDirtyChange: (dirty: boolean) => void
  /** T02：把 flush 交给 App，所有离开出口先落库再导航。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  onNavigate: (action: () => void) => void
  onClose: () => void
  onDataChanged: () => void
  onDeleted: () => void
  onResolveLink: (title: string) => void
}

const EMPTY_DRAFT: DraftSnapshot = { title: '', content: '', date: '', folder_id: null }

/**
 * 编辑态草稿：结构化写作**始终使用块**。
 *
 * - 已经是结构化文件（`content_blocks` 非 NULL）→ 直接用服务器块（id 稳定）；
 * - 历史 NULL 文件 → 用 `legacyBlocksFromContent` 包成**一个等价 user 段**，
 *   首次保存时投影与旧 `content` 逐字相同，后端走等价转换、不重新校验旧正文。
 */
function toSnapshot(journal: Journal): DraftSnapshot {
  const blocks: Block[] = journal.content_blocks != null && journal.content_blocks.length > 0
    ? journal.content_blocks
    : legacyBlocksFromContent(journal.content)
  return draftToSnapshot(
    { title: journal.title ?? '', content: journal.content, folder_id: journal.folder_id },
    journal.journal_date,
    blocks,
  )
}

function toFile(journal: Journal): AutosaveFile {
  return { id: journal.id, revision: journal.revision, draft: toSnapshot(journal) }
}

function JournalDetail({
  journalId, onBusyChange, onDirtyChange, onFlushReady, onNavigate, onClose, onDataChanged, onDeleted, onResolveLink,
}: JournalDetailProps) {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [detail, setDetail] = useState<Journal | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [deleteError, setDeleteError] = useState('')
  const [deletingBlockId, setDeletingBlockId] = useState<string | null>(null)
  const [blockError, setBlockError] = useState('')
  const writing = useRef(false)
  /** 服务器最新版本：AI 段删除必须用最新 revision（缺 428 / 旧 409）。 */
  const latestRevisionRef = useRef(0)

  function rememberServer(journal: Journal): void {
    latestRevisionRef.current = journal.revision
  }

  useEffect(() => {
    const controller = new AbortController()
    getJournal(journalId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setDetail(data)
      rememberServer(data)
      setStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setDetail(null)
      setNotFound(error instanceof JournalApiError && error.status === 404)
      setLoadError(error instanceof Error ? error.message : '读取失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [journalId, reloadToken])

  const autosave = useAutosave<Journal>({
    enabled: mode === 'edit',
    initialDraft: EMPTY_DRAFT,
    initialFile: null,
    create: async () => { throw new Error('详情页不创建新文件') },
    update: async (fileId, draft, baseline, expectedRevision) => {
      const patch = snapshotPatch(draft, baseline)
      if (isSnapshotPatchEmpty(patch)) {
        // 没有可提交字段：这是「响应丢失后的安全 no-op」，直接回读当前详情。
        return await getJournal(fileId)
      }
      const payload: JournalUpdate = { expected_revision: expectedRevision }
      if ('title' in patch) payload.title = patch.title
      if ('content' in patch) payload.content = patch.content
      if ('blocks' in patch) payload.content_blocks = patch.blocks
      if ('date' in patch) payload.journal_date = patch.date
      if ('folder_id' in patch) payload.folder_id = patch.folder_id
      return await updateJournal(fileId, payload)
    },
    toFile,
    refetch: async () => await getJournal(journalId),
    onSaved: (saved) => {
      setDetail(saved)
      rememberServer(saved)
      onDataChanged()
    },
    onDirtyChange,
    onFlushReady,
  })

  const busy = deleteStage === 'deleting' || deletingBlockId !== null
  const draft = autosave.draft
  const draftBlocks = draft.blocks ?? []

  function startEditing() {
    if (!detail) return
    // 只构造一次快照：草稿与基线必须共用同一批块 id。
    const snapshot = toSnapshot(detail)
    autosave.load({ id: detail.id, revision: detail.revision, draft: snapshot }, snapshot)
    setDeleteStage('idle')
    setDeleteError('')
    setBlockError('')
    setMode('edit')
  }
  function exitEditing() {
    autosave.load(null, EMPTY_DRAFT)
    setDeleteStage('idle')
    setDeleteError('')
    setBlockError('')
    setMode('view')
  }

  async function confirmDelete() {
    if (!detail || writing.current) return
    writing.current = true
    onBusyChange(true)
    setDeleteStage('deleting')
    setDeleteError('')
    try {
      // Stage 3 契约：删除必须携带当前 revision（缺 428 / 旧 409）。
      await deleteJournal(detail.id, detail.revision)
      onDirtyChange(false)
      setDetail(null)
      setDeleteStage('idle')
      onDeleted()
    } catch (error: unknown) {
      setDeleteStage('idle')
      if (error instanceof JournalApiError && error.status === 404) {
        setDetail(null)
        setNotFound(true)
        setStatus('error')
        onDataChanged()
      } else {
        setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  /**
   * 删除一个 AI 段（`docs/stage3-tasks.md` §6 步骤 6）：
   * ① 先 flush 待保存的用户输入；② 用最新 revision 调专用接口；
   * ③ 重读详情并安全更新基线。任何一步失败都保留用户输入。
   */
  async function requestDeleteAiBlock(blockId: string): Promise<void> {
    if (detail === null || writing.current || deletingBlockId !== null) return
    writing.current = true
    onBusyChange(true)
    setBlockError('')
    setDeletingBlockId(blockId)
    try {
      const flushed = await autosave.flush()
      if (flushed === 'blocked') {
        setBlockError('还有未保存的输入或版本冲突，已停止删除，避免与自动保存互相覆盖。请先处理保存状态。')
        return
      }
      await deleteAiBlock('journal', detail.id, blockId, latestRevisionRef.current)
      const refreshed = await getJournal(detail.id)
      setDetail(refreshed)
      rememberServer(refreshed)
      autosave.syncFromServer(toFile(refreshed))
      onDataChanged()
    } catch (error: unknown) {
      if (error instanceof WritingApiError && error.status === 409) {
        setBlockError('这条记录已在别处发生变化，已重新读取，请再确认一次。')
        await refreshAfterDeleteFailure()
      } else if (error instanceof WritingApiError && error.status === 404) {
        setBlockError('该 AI 段或文件已不存在；当前输入已保留。')
        await refreshAfterDeleteFailure()
      } else {
        setBlockError(error instanceof Error ? error.message : '删除该 AI 段失败，请稍后重试')
      }
    } finally {
      writing.current = false
      setDeletingBlockId(null)
      onBusyChange(false)
    }
  }

  async function refreshAfterDeleteFailure(): Promise<void> {
    if (detail === null) return
    try {
      const refreshed = await getJournal(detail.id)
      setDetail(refreshed)
      rememberServer(refreshed)
      autosave.syncFromServer(toFile(refreshed))
    } catch { /* 重读失败：保留原草稿与错误提示，不覆盖用户输入。 */ }
  }

  const invalidDraft = autosave.dirty && !autosave.savable
  return (
    <section className="journal-detail" aria-label="Journal 详情">
      <div className="detail-header">
        <h2>Journal 详情</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>
      {status === 'loading' && <p className="detail-state" role="status">正在读取详情……</p>}
      {status === 'error' && (
        <div className="detail-state detail-state-error" role="alert">
          <p>{notFound ? `该 Journal 不存在（id ${journalId}），可能已移入回收箱。` : `读取详情失败：${loadError}`}</p>
          <button type="button" disabled={busy} onClick={() => {
            setStatus('loading')
            setDetail(null)
            setNotFound(false)
            setLoadError('')
            setReloadToken((value) => value + 1)
          }}>重新读取</button>
        </div>
      )}
      {status === 'success' && detail && mode === 'view' && (
        <>
          <h3 className="detail-title">{detail.display_title}</h3>
          <dl className="detail-meta">
            <div className="detail-meta-row"><dt>id</dt><dd>{detail.id}</dd></div>
            <div className="detail-meta-row"><dt>版本</dt><dd>{detail.revision}</dd></div>
            <div className="detail-meta-row"><dt>日期</dt><dd>{detail.journal_date}</dd></div>
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(detail.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(detail.updated_at)}</dd></div>
          </dl>
          <WritingContent blocks={detail.content_blocks} content={detail.content}
            onLink={onResolveLink} disabled={busy} />
          <div className="detail-actions">
            <button type="button" onClick={startEditing} disabled={busy}>修改</button>
            {deleteStage === 'idle' && <button type="button" className="detail-danger"
              onClick={() => setDeleteStage('confirming')} disabled={busy}>移入回收箱</button>}
          </div>
          {deleteStage === 'confirming' && (
            <div className="detail-confirm">
              <p>这篇 Journal 将移入回收箱，可以恢复，也可在 Trash 页面永久删除。确定要移入回收箱吗？</p>
              <div className="detail-confirm-actions">
                <button type="button" className="detail-danger" onClick={confirmDelete} disabled={busy}>确认移入回收箱</button>
                <button type="button" onClick={() => setDeleteStage('idle')} disabled={busy}>取消</button>
              </div>
            </div>
          )}
          {deleteStage === 'deleting' && <p role="status">正在移入回收箱……</p>}
          {deleteError && <p className="detail-error" role="alert">删除失败：{deleteError}（详情保留，可稍后重试。）</p>}
        </>
      )}
      {status === 'success' && detail && mode === 'edit' && (
        <>
          <div className={`autosave-status autosave-${autosave.status}`} role="status" aria-live="polite">
            <span className="autosave-label">{statusLabel(autosave.status)}</span>
            <span className="autosave-hint">{autosave.status === 'failed' || autosave.status === 'conflict'
              ? autosave.error : autosaveHint(autosave.status)}</span>
            {autosave.status === 'failed' && (
              <button type="button" onClick={() => void autosave.retry()}>重试保存</button>
            )}
            {autosave.status === 'conflict' && (
              <>
                <button type="button" onClick={() => void autosave.resubmitAfterConflict()}>用我的草稿重试</button>
                <button type="button" onClick={() => void autosave.reloadServerVersion()}>重新载入服务器版本</button>
              </>
            )}
          </div>
          <form className="detail-form" onSubmit={(event) => { event.preventDefault(); void autosave.saveNow() }}>
            <label className="editor-field"><span>日期</span>
              <input type="date" value={draft.date}
                onChange={(event) => autosave.changeDraft({ date: event.target.value })} />
            </label>
            <label className="editor-field"><span>标题（留空表示没有标题）</span>
              <input type="text" value={draft.title}
                onChange={(event) => autosave.changeDraft({ title: event.target.value })}
                onCompositionStart={autosave.onCompositionStart}
                onCompositionEnd={autosave.onCompositionEnd} />
            </label>
            <div className="editor-field">
              <span>正文（用户文字与 AI 段分开显示）</span>
              <WritingEditor
                blocks={draftBlocks}
                onChange={(blocks) => autosave.changeDraft({ blocks, content: projectBlocks(blocks) })}
                onCompositionStart={autosave.onCompositionStart}
                onCompositionEnd={autosave.onCompositionEnd}
                onRequestDeleteAiBlock={(blockId) => void requestDeleteAiBlock(blockId)}
                deletingBlockId={deletingBlockId}
                onResolveLink={onResolveLink}
              />
            </div>
            <FolderSelect value={draft.folder_id}
              onChange={(folderId) => autosave.changeDraft({ folder_id: folderId })} />
            {blockError && <p className="detail-error" role="alert">{blockError}</p>}
            {invalidDraft && (
              <p className="detail-hint" role="status">
                当前输入为空或超出长度限制，暂不提交；内容会保留在编辑器里。
              </p>
            )}
            <div className="editor-actions">
              <button type="submit" disabled={!autosave.dirty}>立即保存</button>
              <button type="button" onClick={() => onNavigate(exitEditing)}>返回查看</button>
            </div>
          </form>
        </>
      )}
    </section>
  )
}
export default JournalDetail
