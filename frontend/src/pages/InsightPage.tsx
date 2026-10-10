import { useEffect, useRef, useState } from 'react'
import {
  InsightApiError,
  createInsight,
  deleteInsight,
  getInsight,
  listInsights,
  updateInsight,
} from '../api/insights'
import FileCard from '../components/FileCard'
import FolderSelect from '../components/FolderSelect'
import MarkdownContent from '../components/MarkdownContent'
import Pagination from '../components/Pagination'
import type { Insight, InsightCreate, InsightPage as InsightPageData, InsightUpdate } from '../types/insight'
import { useAutosave, type AutosaveFile, type FlushResult } from '../hooks/useAutosave'
import {
  autosaveHint,
  draftToSnapshot,
  isSnapshotPatchEmpty,
  snapshotPatch,
  statusLabel,
  type DraftSnapshot,
} from '../utils/autosave'
import { formatServerTimestamp } from '../utils/journalDetail'
import { nearestValidPage } from '../utils/pagination'

interface InsightPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
  /** T02：把当前编辑面板的 flush 交给 App。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  /** 其他模块（Folder 混合卡片）请求打开某条 Insight；同模块后续请求也消费。 */
  initialOpen?: { id: number; key: number } | null
  onOpenRequestConsumed?: () => void
}

type InsightPanelShape =
  | { kind: 'create'; key: number; savedId?: number }
  | { kind: 'detail'; key: number; id: number }

function toSnapshot(insight: Insight): DraftSnapshot {
  // Insight 没有业务日期：归一化快照的 date 恒为空串。
  return draftToSnapshot(
    { title: insight.title ?? '', content: insight.content, folder_id: insight.folder_id },
    '',
  )
}

function toFile(insight: Insight): AutosaveFile {
  return { id: insight.id, revision: insight.revision, draft: toSnapshot(insight) }
}

/** 源码标题 + 正文输入；创建与编辑共用同一份字段，避免重复组件。 */
function InsightFields({ draft, disabled, onTitle, onContent, changeDraft, composing }: {
  draft: DraftSnapshot
  disabled: boolean
  onTitle: (value: string) => void
  onContent: (value: string) => void
  changeDraft: (update: Partial<DraftSnapshot>) => void
  composing: { start: () => void; end: () => void }
}) {
  return (
    <>
      <label className="editor-field"><span>标题（留空显示为“未命名 Insight”）</span>
        <input type="text" value={draft.title} disabled={disabled}
          onChange={(event) => onTitle(event.target.value)}
          onCompositionStart={composing.start} onCompositionEnd={composing.end} />
      </label>
      <label className="editor-field"><span>正文</span>
        <textarea value={draft.content} rows={8} disabled={disabled}
          onChange={(event) => onContent(event.target.value)}
          onCompositionStart={composing.start} onCompositionEnd={composing.end} />
      </label>
      <FolderSelect value={draft.folder_id} disabled={disabled}
        onChange={(folderId) => changeDraft({ folder_id: folderId })} />
    </>
  )
}

interface InsightPanelProps {
  panel: InsightPanelShape
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
  onCreated: (insight: Insight) => void
  onChanged: (insight: Insight) => void
  onDeleted: (insight: Insight) => void
  onClose: () => void
}

function InsightPanel({
  panel, onDirtyChange, onBusyChange, onFlushReady, onResolveLink, onNavigate, onCreated, onChanged, onDeleted, onClose,
}: InsightPanelProps) {
  const insightId = panel.kind === 'detail' ? panel.id : null

  const [status, setStatus] = useState<'ready' | 'loading' | 'success' | 'error'>(panel.kind === 'create' ? 'ready' : 'loading')
  const [file, setFile] = useState<Insight | null>(null)
  // Creation changes identity in this session; never replace its hook or input DOM.
  const isCreate = panel.kind === 'create' && file === null
  const createdRef = useRef(false)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>(panel.kind === 'create' ? 'edit' : 'view')
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [deleteError, setDeleteError] = useState('')
  const writing = useRef(false)

  // 打开已有 Insight 时真实读取详情；创建面板不发任何读请求。
  useEffect(() => {
    if (insightId === null) return
    const controller = new AbortController()
    getInsight(insightId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setFile(data)
      setStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setFile(null)
      setNotFound(error instanceof InsightApiError && error.status === 404)
      setLoadError(error instanceof Error ? error.message : '读取失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [insightId, reloadToken])

  const autosave = useAutosave<Insight>({
    enabled: mode === 'edit',
    initialDraft: { title: '', content: '', date: '', folder_id: null },
    initialFile: null,
    create: async (draft, createKey) => {
      const payload: InsightCreate = {
        content: draft.content,
        title: draft.title === '' ? null : draft.title,
        folder_id: draft.folder_id,
        client_create_id: createKey,
      }
      return await createInsight(payload)
    },
    update: async (fileId, draft, baseline, expectedRevision) => {
      const patch = snapshotPatch(draft, baseline)
      // 空补丁 = 响应丢失后的安全 no-op：只回读，不写。
      if (isSnapshotPatchEmpty(patch)) return await getInsight(fileId)
      const payload: InsightUpdate = { expected_revision: expectedRevision }
      if ('title' in patch) payload.title = patch.title
      if ('content' in patch) payload.content = patch.content
      if ('folder_id' in patch) payload.folder_id = patch.folder_id
      return await updateInsight(fileId, payload)
    },
    toFile,
    refetch: async () => {
      if (file === null) throw new Error('还没有创建成功，没有服务器版本可载入')
      return await getInsight(file.id)
    },
    onSaved: (saved) => {
      setFile(saved)
      setStatus('success')
      if (panel.kind === 'create' && !createdRef.current) {
        createdRef.current = true
        onCreated(saved)
      } else onChanged(saved)
    },
    onDirtyChange,
    onFlushReady,
  })

  const busy = deleteStage === 'deleting'
  const draft = autosave.draft

  function startEditing() {
    if (!file) return
    autosave.load(toFile(file), toSnapshot(file))
    setDeleteStage('idle')
    setDeleteError('')
    setMode('edit')
  }
  function exitEditing() {
    autosave.load(null, { title: '', content: '', date: '', folder_id: null })
    setDeleteStage('idle')
    setDeleteError('')
    setMode('view')
  }

  async function confirmDelete() {
    if (file === null || writing.current) return
    writing.current = true
    onBusyChange(true)
    setDeleteStage('deleting')
    setDeleteError('')
    try {
      // Stage 3 契约：软删除必须携带当前 revision（缺 428 / 旧 409）。
      await deleteInsight(file.id, file.revision)
      onDirtyChange(false)
      onDeleted(file)
    } catch (error: unknown) {
      if (error instanceof InsightApiError && error.status === 404) {
        onDirtyChange(false)
        onDeleted(file)
      } else if (error instanceof InsightApiError && error.status === 409) {
        setDeleteStage('idle')
        setDeleteError('这条记录已在别处发生变化，已重新读取，请再确认一次。')
        setReloadToken((value) => value + 1)
      } else {
        setDeleteStage('idle')
        setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  const invalidDraft = autosave.dirty && !autosave.savable

  const statusBanner = (
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
  )

  return (
    <section className="journal-editor" aria-label={isCreate ? '新建 Insight' : 'Insight 详情'}>
      <div className="detail-header">
        <h2>{isCreate ? '新建 Insight' : 'Insight 详情'}</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>

      {mode === 'edit' && (panel.kind === 'create' || (status === 'success' && file)) && (
        <>
          <p className="detail-hint">Insight 没有所属日期，也不需要来源或 AI 信息，只有标题与正文。</p>
          {statusBanner}
          <form className="editor-form" onSubmit={(event) => { event.preventDefault(); void autosave.saveNow() }}>
            <InsightFields draft={draft} disabled={false}
              onTitle={(value) => autosave.changeDraft({ title: value })}
              onContent={(value) => autosave.changeDraft({ content: value })}
              changeDraft={autosave.changeDraft}
              composing={{ start: autosave.onCompositionStart, end: autosave.onCompositionEnd }} />
            {invalidDraft && (
              <p className="detail-hint" role="status">
                空白或超长的输入不会提交，也不会创建空记录；内容保留在编辑器里。
              </p>
            )}
            <div className="editor-actions">
              <button type="submit" disabled={!autosave.dirty}>立即保存</button>
              <button type="button" onClick={() => isCreate ? onClose() : onNavigate(exitEditing)} disabled={busy}>
                {isCreate ? '取消新建' : '返回查看'}
              </button>
            </div>
          </form>
        </>
      )}

      {!isCreate && status === 'loading' && <p className="detail-state" role="status">正在读取详情……</p>}
      {!isCreate && status === 'error' && (
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

      {!isCreate && status === 'success' && file && mode === 'view' && (
        <>
          <h3 className="detail-title">{file.display_title}</h3>
          <dl className="detail-meta">
            <div className="detail-meta-row"><dt>id</dt><dd>{file.id}</dd></div>
            <div className="detail-meta-row"><dt>版本</dt><dd>{file.revision}</dd></div>
            {file.folder_id !== null && (
              <div className="detail-meta-row"><dt>所属 Folder</dt><dd>{file.folder_id}</dd></div>
            )}
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(file.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(file.updated_at)}</dd></div>
          </dl>
          <MarkdownContent source={file.content} onLink={onResolveLink} disabled={busy} />
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
          {deleteError && <p className="detail-error" role="alert">删除失败：{deleteError}（记录仍保留，可稍后重试。）</p>}
        </>
      )}

    </section>
  )
}

function InsightPage({
  onDirtyChange, onBusyChange, onResolveLink, onNavigate, onFlushReady, initialOpen = null, onOpenRequestConsumed,
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
  function changePage(value: number) {
    onNavigate(() => {
      showList()
      beginListLoading()
      setListPage(value)
    })
  }

  function handleCreated(insight: Insight) {
    // List identity only; Dirty and the live save queue remain owned by the panel.
    setPanel((current) => current.kind === 'create'
      ? { ...current, savedId: insight.id } : current)
    refreshList()
  }
  function handleChanged() {
    // 面板自身在查看态刷新；这里只负责刷新列表。
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
