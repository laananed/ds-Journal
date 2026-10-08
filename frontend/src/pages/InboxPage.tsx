import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  InboxApiError,
  createInbox,
  deleteInbox,
  getDailyInbox,
  getInbox,
  listInboxes,
  updateInbox,
} from '../api/inboxes'
import FileCard from '../components/FileCard'
import FolderSelect from '../components/FolderSelect'
import Pagination from '../components/Pagination'
import type { Inbox, InboxPage as InboxPageData } from '../types/inbox'
import {
  formatContentValidationErrors,
  hasContentValidationErrors,
  validateCreateInput,
  validateUpdateInput,
} from '../utils/contentValidation'
import { formatServerTimestamp } from '../utils/journalDetail'
import { defaultJournalDate } from '../utils/journalDate'
import {
  buildInboxCreate,
  buildInboxUpdate,
  planDailyEntry,
  toInboxDraft,
  type InboxEditDraft,
} from '../utils/inboxDraft'
import { isDraftDirty } from '../utils/dirtyState'
import { nearestValidPage } from '../utils/pagination'

interface InboxPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onNavigate: (action: () => void) => void
  /** 其他模块（Folder 混合卡片）请求打开某条 Inbox；仅在挂载时生效一次。 */
  initialOpen?: { id: number; key: number } | null
  onOpenRequestConsumed?: () => void
}

type InboxPanelShape =
  | { kind: 'create'; key: number; isDaily: boolean; inboxDate: string }
  | { kind: 'detail'; key: number; id: number }

/** Daily 身份由 `is_daily` 决定，与标题无关。 */
function identityLabel(isDaily: boolean): string {
  return isDaily ? '当日 Daily Inbox' : '普通 Inbox'
}

/** 源码标题 + 正文输入；创建与编辑共用同一份字段，避免重复组件。 */
function InboxFields({ draft, disabled, onTitle, onContent }: {
  draft: InboxEditDraft
  disabled: boolean
  onTitle: (value: string) => void
  onContent: (value: string) => void
}) {
  return (
    <>
      <label className="editor-field"><span>标题（留空则用业务日期作为默认标题）</span>
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

interface InboxPanelProps {
  panel: InboxPanelShape
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onNavigate: (action: () => void) => void
  onCreated: (inbox: Inbox) => void
  onChanged: (inbox: Inbox) => void
  onDeleted: (inbox: Inbox) => void
  onClose: () => void
  onOpenRecord: (id: number) => void
}

function InboxPanel({
  panel, onDirtyChange, onBusyChange, onNavigate, onCreated, onChanged, onDeleted, onClose, onOpenRecord,
}: InboxPanelProps) {
  const isCreate = panel.kind === 'create'
  const inboxId = panel.kind === 'detail' ? panel.id : null

  const [status, setStatus] = useState<'ready' | 'loading' | 'success' | 'error'>(isCreate ? 'ready' : 'loading')
  const [file, setFile] = useState<Inbox | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>(isCreate ? 'edit' : 'view')
  const [draft, setDraft] = useState<InboxEditDraft>({ title: '', content: '', folder_id: null })
  const [initial, setInitial] = useState<InboxEditDraft>({ title: '', content: '', folder_id: null })
  const [titleEdited, setTitleEdited] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [deleteError, setDeleteError] = useState('')
  const [conflict, setConflict] = useState<{ id: number | null; message: string } | null>(null)
  const writing = useRef(false)

  // 打开已有 Inbox 时真实读取详情；创建面板不发任何读请求。
  useEffect(() => {
    if (inboxId === null) return
    const controller = new AbortController()
    getInbox(inboxId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setFile(data)
      setStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setFile(null)
      setNotFound(error instanceof InboxApiError && error.status === 404)
      setLoadError(error instanceof Error ? error.message : '读取失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [inboxId, reloadToken])

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
    setConflict(null)
  }
  function changeTitle(value: string) {
    setDraft((current) => ({ ...current, title: value }))
    setTitleEdited(true)
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
    const next = toInboxDraft(file)
    setDraft(next)
    setInitial(next)
    setTitleEdited(false)
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
    const { inboxDate, isDaily } = panel
    const errors = validateCreateInput({
      title: draft.title === '' ? null : draft.title,
      content: draft.content,
    })
    if (hasContentValidationErrors(errors)) {
      setSaveStatus('invalid')
      setSaveError(formatContentValidationErrors(errors))
      return
    }
    const payload = buildInboxCreate(draft, { inboxDate, isDaily, titleEdited })
    writing.current = true
    onBusyChange(true)
    setSaveStatus('saving')
    setSaveError('')
    setConflict(null)
    try {
      const created = await createInbox(payload)
      setSaveStatus('saved')
      onDirtyChange(false)
      onCreated(created)
    } catch (error: unknown) {
      setSaveStatus('error')
      if (error instanceof InboxApiError && error.status === 409 && isDaily) {
        // 同一业务日期已存在 Daily：重读身份，保留当前输入，绝不覆盖已有正文。
        setSaveError('该日期已存在 Daily Inbox，未覆盖已有内容。')
        try {
          const state = await getDailyInbox(inboxDate)
          const plan = planDailyEntry(state)
          setConflict({
            id: plan.kind === 'existing' ? plan.id : null,
            message: '已重新查询到该日期的 Daily。可打开已有记录查看；当前未保存的输入仍保留。',
          })
        } catch {
          setConflict({ id: null, message: '重新查询该日期 Daily 失败，请返回列表后重试。' })
        }
      } else {
        setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试')
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  async function submitUpdate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writing.current || file === null) return
    const update = buildInboxUpdate(file, draft)
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
      const updated = await updateInbox(file.id, update)
      const next = toInboxDraft(updated)
      setFile(updated)
      setDraft(next)
      setInitial(next)
      setTitleEdited(false)
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
      await deleteInbox(file.id)
      onDirtyChange(false)
      onDeleted(file)
    } catch (error: unknown) {
      if (error instanceof InboxApiError && error.status === 404) {
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

  const heading = isCreate ? (panel.kind === 'create' && panel.isDaily ? '新建当日 Daily Inbox' : '新建 Inbox') : 'Inbox 详情'

  return (
    <section className="journal-editor" aria-label={heading}>
      <div className="detail-header">
        <h2>{heading}</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>

      {panel.kind === 'create' && (
        <>
          <p className="inbox-identity">
            身份：{identityLabel(panel.isDaily)} · 业务日期 {panel.inboxDate}
          </p>
          <p className="detail-hint">日期与 Daily 身份在创建后不可修改。</p>
          <form className="editor-form" onSubmit={submitCreate}>
            <InboxFields draft={draft} disabled={busy}
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
          {conflict && (
            <div className="detail-confirm" role="alert">
              <p>{conflict.message}</p>
              {conflict.id !== null && (
                <div className="detail-confirm-actions">
                  <button type="button" onClick={() => onOpenRecord(conflict.id as number)} disabled={busy}>
                    打开已有的 Daily
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!isCreate && status === 'loading' && <p className="detail-state" role="status">正在读取详情……</p>}
      {!isCreate && status === 'error' && (
        <div className="detail-state detail-state-error" role="alert">
          <p>{notFound ? `该 Inbox 不存在（id ${inboxId}），可能已被永久删除。` : `读取详情失败：${loadError}`}</p>
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
            <div className="detail-meta-row"><dt>身份</dt><dd>{identityLabel(file.is_daily)}</dd></div>
            <div className="detail-meta-row"><dt>业务日期</dt><dd>{file.inbox_date}</dd></div>
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(file.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(file.updated_at)}</dd></div>
          </dl>
          <p className="detail-content">{file.content}</p>
          {saveStatus === 'saved' && <p className="detail-success" role="status">已保存。</p>}
          <div className="detail-actions">
            <button type="button" onClick={startEditing} disabled={busy}>修改</button>
            {deleteStage === 'idle' && (
              <button type="button" className="detail-danger"
                onClick={() => setDeleteStage('confirming')} disabled={busy}>永久删除</button>
            )}
          </div>
          {deleteStage === 'confirming' && (
            <div className="detail-confirm">
              <p>这篇 Inbox 将被永久删除，无法恢复，也不会进入回收箱。确定要删除吗？</p>
              <div className="detail-confirm-actions">
                <button type="button" className="detail-danger" onClick={confirmDelete} disabled={busy}>确认永久删除</button>
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
          <p className="inbox-identity">
            身份：{identityLabel(file.is_daily)} · 业务日期 {file.inbox_date}（创建后不可修改）
          </p>
          <InboxFields draft={draft} disabled={busy}
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

function InboxPage({ onDirtyChange, onBusyChange, onNavigate, initialOpen = null, onOpenRequestConsumed }: InboxPageProps) {
  // Folder 混合卡片的打开请求只在挂载时消费一次：初始即进入详情面板。
  const [panel, setPanel] = useState<InboxPanelShape | { kind: 'list' }>(
    initialOpen ? { kind: 'detail', id: initialOpen.id, key: initialOpen.key } : { kind: 'list' },
  )
  // 从外部初始打开的序号继续递增，避免首次模块内切换复用旧 Panel。
  const keyRef = useRef(initialOpen?.key ?? 0)
  function nextKey() {
    keyRef.current += 1
    return keyRef.current
  }

  const [listFilter, setListFilter] = useState('')
  const [listPage, setListPage] = useState(1)
  const [listResult, setListResult] = useState<InboxPageData | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)

  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const [dailyInfo, setDailyInfo] = useState<{ date: string; state: 'missing' | 'active' } | null>(null)
  const [dailyRevision, setDailyRevision] = useState(0)

  const [busy, setBusy] = useState(false)
  const dailyToken = useRef(0)

  // 打开请求已消费：通知 App 清空，避免下次挂载重复打开同一条记录。
  useEffect(() => {
    if (initialOpen === null) return
    onOpenRequestConsumed?.()
  }, [initialOpen, onOpenRequestConsumed])

  function updateBusy(value: boolean) {
    setBusy(value)
    onBusyChange(value)
  }

  useEffect(() => {
    const controller = new AbortController()
    listInboxes(listFilter || undefined, listPage, controller.signal).then((data) => {
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
  }, [listFilter, listPage, listRevision])

  // 只读查询当日 Daily 是否存在，供工具栏状态提示；绝不会创建空记录。
  useEffect(() => {
    const controller = new AbortController()
    const date = defaultJournalDate()
    getDailyInbox(date, controller.signal).then((state) => {
      if (controller.signal.aborted) return
      setDailyInfo({ date, state: state.state })
    }).catch(() => {
      if (!controller.signal.aborted) setDailyInfo(null)
    })
    return () => controller.abort()
  }, [dailyRevision])

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
  function openInbox(id: number) {
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setActionError('')
      setPanel({ kind: 'detail', id, key: nextKey() })
    })
  }
  function newInbox() {
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setActionError('')
      setPanel({ kind: 'create', isDaily: false, inboxDate: defaultJournalDate(), key: nextKey() })
    })
  }
  function openDaily() {
    onNavigate(() => { void runDailyEntry() })
  }
  async function runDailyEntry() {
    const token = dailyToken.current + 1
    dailyToken.current = token
    updateBusy(true)
    setActionError('')
    try {
      // 业务日期在进入时重新计算：跨过 04:00 不会改变已打开的编辑器，但新进入会用新日期。
      const date = defaultJournalDate()
      const state = await getDailyInbox(date)
      if (token !== dailyToken.current) return
      onDirtyChange(false)
      setNotice('')
      const plan = planDailyEntry(state)
      if (plan.kind === 'existing') {
        setPanel({ kind: 'detail', id: plan.id, key: nextKey() })
      } else {
        // missing：打开默认日期 + 空编辑器，不 POST、不创建空记录。
        setPanel({ kind: 'create', isDaily: true, inboxDate: date, key: nextKey() })
      }
    } catch (error: unknown) {
      if (token !== dailyToken.current) return
      setActionError(`打开今日 Daily 失败：${error instanceof Error ? error.message : '请稍后重试'}`)
    } finally {
      if (token === dailyToken.current) updateBusy(false)
    }
  }
  function changeFilter(value: string) {
    if (value === listFilter) return
    onNavigate(() => {
      showList()
      beginListLoading()
      setListFilter(value)
      setListPage(1)
    })
  }
  function changePage(value: number) {
    onNavigate(() => {
      showList()
      beginListLoading()
      setListPage(value)
    })
  }

  function handleCreated(inbox: Inbox) {
    onDirtyChange(false)
    setNotice(`已保存：${inbox.display_title}`)
    setPanel({ kind: 'detail', id: inbox.id, key: nextKey() })
    refreshList()
    setDailyRevision((value) => value + 1)
  }
  function handleChanged() {
    // 面板自身在查看态显示“已保存。”；这里只负责刷新列表与 Daily 状态。
    refreshList()
    setDailyRevision((value) => value + 1)
  }
  function handleDeleted() {
    onDirtyChange(false)
    setNotice('已永久删除，不可恢复。')
    setPanel({ kind: 'list' })
    refreshList()
    setDailyRevision((value) => value + 1)
  }

  return (
    <section className="inbox-page" aria-label="Inbox 模块">
      <section className="app-toolbar" aria-label="Inbox 工具">
        <button type="button" onClick={newInbox} disabled={busy}>新建 Inbox</button>
        <button type="button" onClick={openDaily} disabled={busy}>打开今日 Daily</button>
        <button type="button" onClick={() => onNavigate(showList)} disabled={busy}>Inbox 列表</button>
        <label className="app-filter">
          <span>按日期查看</span>
          <input type="date" value={listFilter} disabled={busy}
            onChange={(event) => changeFilter(event.target.value)} />
        </label>
        <button type="button" onClick={() => changeFilter('')} disabled={busy || listFilter === ''}>清除筛选</button>
      </section>

      {dailyInfo && (
        <p className="inbox-daily-status">
          今日 Daily（{dailyInfo.date}）：{dailyInfo.state === 'active' ? '已创建' : '尚未创建'}
          {dailyInfo.state === 'missing' ? '，保存有效正文后才会创建。' : '，点击“打开今日 Daily”查看。'}
        </p>
      )}
      {notice && <p className="detail-success" role="status">{notice}</p>}
      {actionError && <p className="detail-error" role="alert">{actionError}</p>}

      {panel.kind === 'create' && (
        <InboxPanel key={`create-${panel.key}`} panel={panel}
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onNavigate={onNavigate}
          onCreated={handleCreated} onChanged={handleChanged} onDeleted={handleDeleted}
          onClose={() => onNavigate(showList)} onOpenRecord={openInbox} />
      )}
      {panel.kind === 'detail' && (
        <InboxPanel key={`detail-${panel.key}`} panel={panel}
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onNavigate={onNavigate}
          onCreated={handleCreated} onChanged={handleChanged} onDeleted={handleDeleted}
          onClose={() => onNavigate(showList)} onOpenRecord={openInbox} />
      )}

      <section className="journal-results" aria-label="Inbox 列表">
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
              ? <p className="app-state">{listFilter ? '该日期没有 Inbox 记录。' : '还没有任何 Inbox 记录。'}</p>
              : (
                <ul className="journal-list">
                  {listResult.items.map((inbox) => (
                    <li key={`${inbox.type}:${inbox.id}`}>
                      <FileCard file={inbox} onOpen={(file) => openInbox(file.id)}
                        selected={panel.kind === 'detail' && panel.id === inbox.id} disabled={busy} />
                    </li>
                  ))}
                </ul>
              )}
            <Pagination page={listResult.page} total={listResult.total} hasNext={listResult.has_next}
              onPageChange={changePage} disabled={busy} label="Inbox 列表分页" />
          </>
        )}
      </section>
    </section>
  )
}

export default InboxPage
