import { useEffect, useRef, useState, type FormEvent } from 'react'
import { JournalApiError, deleteJournal, getJournal, updateJournal } from '../api/journals'
import FolderSelect from './FolderSelect'
import MarkdownContent from './MarkdownContent'
import { buildJournalUpdate, formatServerTimestamp, type JournalEditDraft } from '../utils/journalDetail'
import { isDraftDirty } from '../utils/dirtyState'
import { formatContentValidationErrors, hasContentValidationErrors, validateUpdateInput } from '../utils/contentValidation'
import type { Journal } from '../types/journal'

interface JournalDetailProps {
  journalId: number
  onBusyChange: (busy: boolean) => void
  onDirtyChange: (dirty: boolean) => void
  onNavigate: (action: () => void) => void
  onClose: () => void
  onDataChanged: () => void
  onDeleted: () => void
  onResolveLink: (title: string) => void
}
function toDraft(journal: Journal): JournalEditDraft {
  return { title: journal.title ?? '', content: journal.content, journal_date: journal.journal_date, folder_id: journal.folder_id }
}
function JournalDetail({ journalId, onBusyChange, onDirtyChange, onNavigate, onClose, onDataChanged, onDeleted, onResolveLink }: JournalDetailProps) {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [detail, setDetail] = useState<Journal | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [draft, setDraft] = useState<JournalEditDraft>({ title: '', content: '', journal_date: '', folder_id: null })
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [deleteError, setDeleteError] = useState('')
  const writing = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    getJournal(journalId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setDetail(data)
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

  const busy = saveStatus === 'saving' || deleteStage === 'deleting'
  const isDirty = mode === 'edit' && detail !== null && isDraftDirty(toDraft(detail), draft)
  function startEditing() {
    if (!detail) return
    setDraft(toDraft(detail))
    onDirtyChange(false)
    setSaveStatus('idle')
    setSaveError('')
    setDeleteStage('idle')
    setDeleteError('')
    setMode('edit')
  }
  function changeDraft(update: Partial<JournalEditDraft>) {
    const next = { ...draft, ...update }
    setDraft(next)
    if (detail) onDirtyChange(isDraftDirty(toDraft(detail), next))
    setSaveStatus('idle')
    setSaveError('')
  }
  function exitEditing() {
    onDirtyChange(false)
    setMode('view')
    setSaveStatus('idle')
    setSaveError('')
  }
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!detail || writing.current) return
    if (draft.journal_date === '') {
      setSaveStatus('invalid')
      setSaveError('日期不能为空。')
      return
    }
    const update = buildJournalUpdate(detail, draft)
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
      const updated = await updateJournal(detail.id, update)
      setDetail(updated)
      setDraft(toDraft(updated))
      onDirtyChange(false)
      setMode('view')
      setSaveStatus('saved')
      onDataChanged()
    } catch (error: unknown) {
      setSaveStatus('error')
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试')
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }
  async function confirmDelete() {
    if (!detail || writing.current) return
    writing.current = true
    onBusyChange(true)
    setDeleteStage('deleting')
    setDeleteError('')
    try {
      await deleteJournal(detail.id)
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
            <div className="detail-meta-row"><dt>日期</dt><dd>{detail.journal_date}</dd></div>
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(detail.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(detail.updated_at)}</dd></div>
          </dl>
          <MarkdownContent source={detail.content} onLink={onResolveLink} disabled={busy} />
          {saveStatus === 'saved' && <p className="detail-success" role="status">已保存。</p>}
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
        <form className="detail-form" onSubmit={handleSubmit}>
          <label className="editor-field"><span>日期</span>
            <input type="date" value={draft.journal_date} disabled={busy}
              onChange={(event) => changeDraft({ journal_date: event.target.value })} />
          </label>
          <label className="editor-field"><span>标题（留空表示没有标题）</span>
            <input type="text" value={draft.title} disabled={busy}
              onChange={(event) => changeDraft({ title: event.target.value })} />
          </label>
          <label className="editor-field"><span>正文</span>
            <textarea value={draft.content} rows={8} disabled={busy}
              onChange={(event) => changeDraft({ content: event.target.value })} />
          </label>
          <FolderSelect value={draft.folder_id} disabled={busy}
            onChange={(folderId) => changeDraft({ folder_id: folderId })} />
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
export default JournalDetail
