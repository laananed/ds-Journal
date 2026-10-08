import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createJournal, listJournals } from '../api/journals'
import JournalList from './JournalList'
import FolderSelect from './FolderSelect'
import Pagination from './Pagination'
import type { Journal, JournalPage } from '../types/journal'
import { formatContentValidationErrors, hasContentValidationErrors, validateCreateInput } from '../utils/contentValidation'
import { defaultJournalDate } from '../utils/journalDate'
import { isDraftDirty } from '../utils/dirtyState'
import { nearestValidPage } from '../utils/pagination'
import type { JournalEditDraft } from '../utils/journalDetail'

interface JournalEditorProps {
  listFilterDate: string
  onSaved: () => void
  externalRevision: number
  onOpen: (id: number) => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
}
function JournalEditor({ listFilterDate, onSaved, externalRevision, onOpen, onClose, onDirtyChange, onBusyChange }: JournalEditorProps) {
  const [initial, setInitial] = useState<JournalEditDraft>(() => ({ title: '', content: '', journal_date: defaultJournalDate(), folder_id: null }))
  const [draft, setDraft] = useState(initial)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'invalid' | 'error'>('idle')
  const [saveError, setSaveError] = useState('')
  const [lastSaved, setLastSaved] = useState<Journal | null>(null)
  const writing = useRef(false)
  const [dayPage, setDayPage] = useState(1)
  const [dayResult, setDayResult] = useState<JournalPage | null>(null)
  const [dayStatus, setDayStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [dayError, setDayError] = useState('')
  const [dayReloadToken, setDayReloadToken] = useState(0)

  const requestKey = `${draft.journal_date}:${dayPage}:${dayReloadToken}:${externalRevision}`
  const [dayLoadedKey, setDayLoadedKey] = useState('')
  const visibleDayStatus = dayLoadedKey === requestKey ? dayStatus : 'loading'

  useEffect(() => {
    const controller = new AbortController()
    if (draft.journal_date === '') return () => controller.abort()
    listJournals(draft.journal_date, dayPage, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setDayPage(validPage)
        return
      }
      setDayResult(data)
      setDayLoadedKey(requestKey)
      setDayStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setDayResult(null)
      setDayError(error instanceof Error ? error.message : '读取失败，请稍后重试')
      setDayLoadedKey(requestKey)
      setDayStatus('error')
    })
    return () => controller.abort()
  }, [draft.journal_date, dayPage, dayReloadToken, externalRevision, requestKey])

  function changeDraft(update: Partial<JournalEditDraft>) {
    const next = { ...draft, ...update }
    setDraft(next)
    onDirtyChange(isDraftDirty(initial, next))
    setSaveStatus('idle')
    setSaveError('')
    if (update.journal_date !== undefined && update.journal_date !== draft.journal_date) {
      setDayPage(1)
      setDayResult(null)
      setDayStatus('loading')
    }
  }
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (writing.current) return
    if (draft.journal_date === '') {
      setSaveStatus('invalid')
      setSaveError('请先选择日期。')
      return
    }
    const payload = { title: draft.title === '' ? null : draft.title, content: draft.content, journal_date: draft.journal_date, folder_id: draft.folder_id }
    const errors = validateCreateInput(payload)
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
      const created = await createJournal(payload)
      setLastSaved(created)
      // 成功后开始下一篇空表单，保留服务器回读日期作为新的默认基线。
      const next = { title: '', content: '', journal_date: created.journal_date, folder_id: null }
      setDraft(next)
      setInitial(next)
      onDirtyChange(false)
      setSaveStatus('saved')
      setDayReloadToken((value) => value + 1)
      onSaved()
    } catch (error: unknown) {
      setSaveStatus('error')
      setSaveError(error instanceof Error ? error.message : '保存失败，请稍后重试')
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }
  const isSaving = saveStatus === 'saving'
  const outsideFilter = lastSaved && listFilterDate !== '' && listFilterDate !== lastSaved.journal_date
  return (
    <section className="journal-editor" aria-label="新建 Journal">
      <div className="detail-header">
        <h2>新建 Journal</h2>
        <button type="button" onClick={onClose} disabled={isSaving}>返回列表</button>
      </div>
      <form className="editor-form" onSubmit={handleSubmit}>
        <label className="editor-field"><span>日期</span>
          <input type="date" value={draft.journal_date} disabled={isSaving}
            onChange={(event) => changeDraft({ journal_date: event.target.value })} />
        </label>
        <label className="editor-field"><span>标题（可留空）</span>
          <input type="text" value={draft.title} disabled={isSaving}
            onChange={(event) => changeDraft({ title: event.target.value })} />
        </label>
        <label className="editor-field"><span>正文</span>
          <textarea value={draft.content} rows={6} disabled={isSaving}
            onChange={(event) => changeDraft({ content: event.target.value })} />
        </label>
        <FolderSelect value={draft.folder_id} disabled={isSaving}
          onChange={(folderId) => changeDraft({ folder_id: folderId })} />
        <div className="editor-actions">
          <button type="submit" disabled={isSaving}>{isSaving ? '保存中……' : '保存'}</button>
          <button type="button" onClick={onClose} disabled={isSaving}>取消新建</button>
        </div>
      </form>
      {saveStatus === 'saved' && lastSaved && (
        <p className="editor-success" role="status">
          已保存：{lastSaved.display_title}。
          {outsideFilter ? `当前列表筛选的是 ${listFilterDate}，这篇不在当前列表中。` : ''}
        </p>
      )}
      {(saveStatus === 'error' || saveStatus === 'invalid') && (
        <p className="editor-error" role="alert">
          {saveStatus === 'error' ? '保存失败' : '输入不合法'}：{saveError}
          （输入已保留{saveStatus === 'invalid' ? '，未发送保存请求' : ''}，可修改后再次保存。）
        </p>
      )}
      <div className="editor-day" aria-label="当天已有记录">
        <p className="editor-day-title">
          {draft.journal_date === '' ? '先选择日期，才能查看该日期已有记录。'
            : visibleDayStatus === 'loading' ? '正在读取该日期已有记录……'
            : visibleDayStatus === 'error' ? `读取该日期已有记录失败：${dayError}`
            : `该日期已有 ${dayResult?.total ?? 0} 篇记录。`}
        </p>
        {draft.journal_date !== '' && visibleDayStatus === 'error' && (
          <button type="button" onClick={() => setDayReloadToken((value) => value + 1)} disabled={isSaving}>重试</button>
        )}
        {draft.journal_date !== '' && visibleDayStatus === 'success' && dayResult && (
          <>
            <JournalList journals={dayResult.items} onOpen={onOpen} openDisabled={isSaving} />
            <Pagination page={dayResult.page} total={dayResult.total} hasNext={dayResult.has_next}
              onPageChange={(value) => {
                setDayResult(null)
                setDayStatus('loading')
                setDayPage(value)
              }} disabled={isSaving} label="当天已有记录分页" />
          </>
        )}
      </div>
    </section>
  )
}
export default JournalEditor
