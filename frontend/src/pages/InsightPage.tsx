import { useEffect, useRef, useState, type FormEvent } from 'react'
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
import Pagination from '../components/Pagination'
import type { Insight, InsightPage as InsightPageData } from '../types/insight'
import {
  formatContentValidationErrors,
  hasContentValidationErrors,
  validateCreateInput,
  validateUpdateInput,
} from '../utils/contentValidation'
import { formatServerTimestamp } from '../utils/journalDetail'
import {
  buildInsightCreate,
  buildInsightUpdate,
  toInsightDraft,
  type InsightEditDraft,
} from '../utils/insightDraft'
import { isDraftDirty } from '../utils/dirtyState'
import { nearestValidPage } from '../utils/pagination'

interface InsightPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onNavigate: (action: () => void) => void
  /** 其他模块（Folder 混合卡片）请求打开某条 Insight；仅在挂载时生效一次。 */
  initialOpen?: { id: number; key: number } | null
  onOpenRequestConsumed?: () => void
}

type InsightPanelShape =
  | { kind: 'create'; key: number }
  | { kind: 'detail'; key: number; id: number }

/** 源码标题 + 正文输入；创建与编辑共用同一份字段，避免重复组件。 */
function InsightFields({ draft, disabled, onTitle, onContent }: {
  draft: InsightEditDraft
  disabled: boolean
  onTitle: (value: string) => void
  onContent: (value: string) => void
}) {
  return (
    <>
      <label className="editor-field"><span>标题（留空显示为“未命名 Insight”）</span>
        <input type="text" value={draft.title} disabled={disabled}
          onChange={(event) => onTitle(event.target.value)} />
      </label>
      <label className="editor-field"><span>正文</span>
        <textarea value={draft.content} rows={8} disabled={disabled}
          onChange={(event) => onContent(event.target.value)} />
      </label>
    </>
  )
}

interface InsightPanelProps {
  panel: InsightPanelShape
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onNavigate: (action: () => void) => void
  onCreated: (insight: Insight) => void
  onChanged: (insight: Insight) => void
  onDeleted: (insight: Insight) => void
  onClose: () => void
}

function InsightPanel({
  panel, onDirtyChange, onBusyChange, onNavigate, onCreated, onChanged, onDeleted, onClose,
}: InsightPanelProps) {
  const isCreate = panel.kind === 'create'
  const insightId = panel.kind === 'detail' ? panel.id : null

  const [status, setStatus] = useState<'ready' | 'loading' | 'success' | 'error'>(isCreate ? 'ready' : 'loading')
  const [file, setFile] = useState<Insight | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>(isCreate ? 'edit' : 'view')
  const [draft, setDraft] = useState<InsightEditDraft>({ title: '', content: '', folder_id: null })
  const [initial, setInitial] = useState<InsightEditDraft>({ title: '', content: '', folder_id: null })
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
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

  // 统一把当前草稿是否 Dirty 交给 App 的离开检查；查看态永远不脏。
  useEffect(() => {
    if (mode !== 'edit') {
      onDirtyChange(false)
      return
    }
    onDirtyChange(isDraftDirty(initial, draft))
  }, [mode, initial, draft, onDirtyChange])

  const busy = saveStatus === 'saving' || deleteStage === 'deleting'
  const isDirty = mode === 'edit' && isDraftDirty(initial, draft)

  function resetSaveState() {
    setSaveStatus('idle')
    setSaveError('')
  }
  function changeTitle(value: string) {
    setDraft((current) => ({ ...current, title: value }))
    resetSaveState()
  }
  function changeContent(value: string) {
    setDraft((current) => ({ ...current, content: value }))
    resetSaveState()
  }
  function changeFolder(folderId: number | null) {
    setDraft((current) => ({ ...current, folder_id: folderId }))
    resetSaveState()
  }
  function startEditing() {
    if (!file) return
    const next = toInsightDraft(file)
    setDraft(next)
    setInitial(next)
    setDeleteStage('idle')
    setDeleteError('')
    resetSaveState()
    onDirtyChange(false)
    setMode('edit')
  }
  function exitEditing() {
    onDirtyChange(false)
    setMode('view')
    resetSaveState()
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writing.current || panel.kind !== 'create') return
    const payload = buildInsightCreate(draft)
    const errors = validateCreateInput({ title: payload.title ?? null, content: payload.content })
    if (hasContentValidationErrors(errors)) {
      setSaveStatus('invalid')
      setSaveError(formatContentValidationErrors(errors))
      return
    }
    writing.current = true
    onBusyChange(true)
    setSaveStatus('saving')
    setSaveError('')
    try {
      const created = await createInsight(payload)
      setSaveStatus('saved')
      onDirtyChange(false)
      onCreated(created)
    } catch (error: unknown) {
      setSaveStatus('error')
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试')
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  async function submitUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writing.current || file === null) return
    const update = buildInsightUpdate(file, draft)
    const errors = validateUpdateInput(update)
    if (hasContentValidationErrors(errors)) {
      setSaveStatus('invalid')
      setSaveError(formatContentValidationErrors(errors))
      return
    }
    writing.current = true
    onBusyChange(true)
    setSaveStatus('saving')
    setSaveError('')
    try {
      const updated = await updateInsight(file.id, update)
      const next = toInsightDraft(updated)
      setFile(updated)
      setDraft(next)
      setInitial(next)
      onDirtyChange(false)
      setMode('view')
      setSaveStatus('saved')
      onChanged(updated)
    } catch (error: unknown) {
      setSaveStatus('error')
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试')
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  async function confirmDelete() {
    if (file === null || writing.current) return
    writing.current = true
    onBusyChange(true)
    setDeleteStage('deleting')
    setDeleteError('')
    try {
      await deleteInsight(file.id)
      onDirtyChange(false)
      onDeleted(file)
    } catch (error: unknown) {
      if (error instanceof InsightApiError && error.status === 404) {
        // 目标已经不在了：与删除成功等价处理，刷新走正常路径。
        onDirtyChange(false)
        onDeleted(file)
      } else {
        setDeleteStage('idle')
        setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试')
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  return (
    <section className="journal-editor" aria-label={isCreate ? '新建 Insight' : 'Insight 详情'}>
      <div className="detail-header">
        <h2>{isCreate ? '新建 Insight' : 'Insight 详情'}</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>

      {isCreate && (
        <>
          <p className="detail-hint">Insight 没有所属日期，也不需要来源或 AI 信息，只有标题与正文。</p>
          <form className="editor-form" onSubmit={submitCreate}>
            <InsightFields draft={draft} disabled={busy}
              onTitle={changeTitle} onContent={changeContent} />
            <FolderSelect value={draft.folder_id} disabled={busy}
              onChange={changeFolder} />
            <div className="editor-actions">
              <button type="submit" disabled={busy}>{busy ? '保存中……' : '保存'}</button>
              <button type="button" onClick={onClose} disabled={busy}>取消新建</button>
            </div>
          </form>
          {(saveStatus === 'error' || saveStatus === 'invalid') && (
            <p className="detail-error" role="alert">
              {saveStatus === 'error' ? '保存失败' : '输入不合法'}：{saveError}
              （输入已保留{saveStatus === 'invalid' ? '，未发送保存请求' : ''}，可修改后再次保存。）
            </p>
          )}
        </>
      )}

      {!isCreate && status === 'loading' && <p className="detail-state" role="status">正在读取详情……</p>}
      {!isCreate && status === 'error' && (
        <div className="detail-state detail-state-error" role="alert">
          <p>{notFound ? `该 Insight 不存在（id ${insightId}），可能已被移入回收箱。` : `读取详情失败：${loadError}`}</p>
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
            {file.folder_id !== null && (
              <div className="detail-meta-row"><dt>所属 Folder</dt><dd>{file.folder_id}</dd></div>
            )}
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(file.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(file.updated_at)}</dd></div>
          </dl>
          <p className="detail-content">{file.content}</p>
          {saveStatus === 'saved' && <p className="detail-success" role="status">已保存。</p>}
          <div className="detail-actions">
            <button type="button" onClick={startEditing} disabled={busy}>修改</button>
            {deleteStage === 'idle' && (
              <button type="button" className="detail-danger"
                onClick={() => setDeleteStage('confirming')} disabled={busy}>移入回收箱</button>
            )}
          </div>
          {deleteStage === 'confirming' && (
            <div className="detail-confirm">
              <p>这篇 Insight 将被移入回收箱，不再出现在列表与详情中。确定要移入回收箱吗？</p>
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

      {!isCreate && status === 'success' && file && mode === 'edit' && (
        <form className="detail-form" onSubmit={submitUpdate}>
          <p className="detail-hint">Insight 没有所属日期；保存时只提交改过的字段。</p>
          <InsightFields draft={draft} disabled={busy}
            onTitle={changeTitle} onContent={changeContent} />
          <FolderSelect value={draft.folder_id} disabled={busy}
            onChange={changeFolder} />
          <div className="editor-actions">
            <button type="submit" disabled={busy}>{saveStatus === 'saving' ? '保存中……' : '保存修改'}</button>
            <button type="button" onClick={() => onNavigate(exitEditing)} disabled={busy}>取消</button>
          </div>
          <p className="detail-hint">{isDirty ? '保存时只提交改过的字段。' : '没有任何改动，保存将按空更新处理。'}</p>
          {(saveStatus === 'error' || saveStatus === 'invalid') && (
            <p className="detail-error" role="alert">
              {saveStatus === 'error' ? '保存失败' : '输入不合法'}：{saveError}
              （输入已保留{saveStatus === 'invalid' ? '，未发送保存请求' : ''}，可修改后再次保存。）
            </p>
          )}
        </form>
      )}
    </section>
  )
}

function InsightPage({ onDirtyChange, onBusyChange, onNavigate, initialOpen = null, onOpenRequestConsumed }: InsightPageProps) {
  // Folder 混合卡片的打开请求只在挂载时消费一次：初始即进入详情面板。
  const [panel, setPanel] = useState<InsightPanelShape | { kind: 'list' }>(
    initialOpen ? { kind: 'detail', id: initialOpen.id, key: initialOpen.key } : { kind: 'list' },
  )
  // 从外部初始打开的序号继续递增，避免首次模块内切换复用旧 Panel。
  const keyRef = useRef(initialOpen?.key ?? 0)
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
    onDirtyChange(false)
    setNotice(`已保存：${insight.display_title}`)
    setPanel({ kind: 'detail', id: insight.id, key: nextKey() })
    refreshList()
  }
  function handleChanged() {
    // 面板自身在查看态显示“已保存。”；这里只负责刷新列表。
    refreshList()
  }
  function handleDeleted() {
    onDirtyChange(false)
    setNotice('已移入回收箱，可以恢复。回收箱页面尚未开放。')
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
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onNavigate={onNavigate}
          onCreated={handleCreated} onChanged={handleChanged} onDeleted={handleDeleted}
          onClose={() => onNavigate(showList)} />
      )}
      {panel.kind === 'detail' && (
        <InsightPanel key={`detail-${panel.key}`} panel={panel}
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onNavigate={onNavigate}
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
                      <FileCard file={insight} onOpen={(file) => openInsight(file.id)}
                        selected={panel.kind === 'detail' && panel.id === insight.id} disabled={busy} />
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
