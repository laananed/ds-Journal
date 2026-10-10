import { useEffect, useRef, useState } from 'react'
import { createJournal, getJournal, listJournals, updateJournal } from '../api/journals'
import JournalList from './JournalList'
import FolderSelect from './FolderSelect'
import Pagination from './Pagination'
import WritingEditor from './WritingEditor'
import type { Journal, JournalCreate, JournalPage, JournalUpdate } from '../types/journal'
import { useAutosave, type AutosaveFile, type FlushResult } from '../hooks/useAutosave'
import {
  autosaveHint,
  draftToSnapshot,
  isSnapshotPatchEmpty,
  isSavable,
  snapshotPatch,
  statusLabel,
  type DraftSnapshot,
} from '../utils/autosave'
import { legacyBlocksFromContent, newUserBlock, projectBlocks } from '../utils/writingBlocks'
import { defaultJournalDate } from '../utils/journalDate'
import { nearestValidPage } from '../utils/pagination'

interface JournalEditorProps {
  listFilterDate: string
  onSaved: (saved: Journal) => void
  externalRevision: number
  onOpen: (id: number) => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  /** T02：把 flush 交给 App。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
}

/** 编辑态草稿：结构化写作统一使用块；历史 NULL 正文包成等价 user 段。 */
function toSnapshot(journal: Journal): DraftSnapshot {
  const blocks = journal.content_blocks != null && journal.content_blocks.length > 0
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

function JournalEditor({
  listFilterDate, onSaved, externalRevision, onOpen, onClose, onDirtyChange, onFlushReady,
}: JournalEditorProps) {
  const [lastSaved, setLastSaved] = useState<Journal | null>(null)
  const [dayPage, setDayPage] = useState(1)
  const [dayResult, setDayResult] = useState<JournalPage | null>(null)
  const [dayStatus, setDayStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [dayError, setDayError] = useState('')
  const [dayReloadToken, setDayReloadToken] = useState(0)

  // 只构造一次初始草稿：块 id 必须跨渲染稳定。
  const [initialDraft] = useState<DraftSnapshot>(() => ({
    title: '',
    content: '',
    date: defaultJournalDate(),
    folder_id: null,
    blocks: [newUserBlock('')],
  }))

  // 已创建文件 id 的同步副本：供 create/update/refetch 闭包读取（避免闭包拿到旧 state）。
  const lastSavedIdRef = useRef(0)
  const rememberSaved = (saved: Journal): void => {
    lastSavedIdRef.current = saved.id
    setLastSaved(saved)
  }

  async function refetchSaved(): Promise<Journal> {
    if (lastSavedIdRef.current === 0) throw new Error('还没有创建成功，没有服务器版本可载入')
    return await getJournal(lastSavedIdRef.current)
  }

  const autosave = useAutosave<Journal>({
    enabled: true,
    initialDraft,
    initialFile: null,
    // 新建必须带日期；空白正文不提交，也不会创建空文件。
    savable: (draft, context) => isSavable(draft, { ...context, requireDate: true }),
    create: async (draft, createKey) => {
      const payload: JournalCreate = {
        title: draft.title === '' ? null : draft.title,
        journal_date: draft.date,
        folder_id: draft.folder_id,
        client_create_id: createKey,
        // 结构化写作只提交 content_blocks，绝不与 content 同时提交。
        content_blocks: draft.blocks ?? [],
      }
      return await createJournal(payload)
    },
    update: async (fileId, draft, baseline, expectedRevision) => {
      const patch = snapshotPatch(draft, baseline)
      // 空补丁 = 响应丢失后的安全 no-op：只回读，不写。
      if (isSnapshotPatchEmpty(patch)) return await getJournal(fileId)
      const payload: JournalUpdate = { expected_revision: expectedRevision }
      if ('title' in patch) payload.title = patch.title
      if ('content' in patch) payload.content = patch.content
      if ('blocks' in patch) payload.content_blocks = patch.blocks
      if ('date' in patch) payload.journal_date = patch.date
      if ('folder_id' in patch) payload.folder_id = patch.folder_id
      return await updateJournal(fileId, payload)
    },
    toFile,
    refetch: refetchSaved,
    onSaved: (saved) => {
      rememberSaved(saved)
      onSaved(saved)
    },
    onDirtyChange,
    onFlushReady,
  })

  const draft = autosave.draft
  const draftBlocks = draft.blocks ?? []

  const requestKey = `${draft.date}:${dayPage}:${dayReloadToken}:${externalRevision}`
  const [dayLoadedKey, setDayLoadedKey] = useState('')
  const visibleDayStatus = dayLoadedKey === requestKey ? dayStatus : 'loading'

  useEffect(() => {
    const controller = new AbortController()
    if (draft.date === '') return () => controller.abort()
    listJournals(draft.date, dayPage, controller.signal).then((data) => {
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
  }, [draft.date, dayPage, dayReloadToken, externalRevision, requestKey])

  function changeDate(value: string) {
    autosave.changeDraft({ date: value })
    if (value !== draft.date) {
      setDayPage(1)
      setDayResult(null)
      setDayStatus('loading')
    }
  }

  const invalidDraft = autosave.dirty && !autosave.savable
  const outsideFilter = lastSaved !== null && listFilterDate !== '' && listFilterDate !== lastSaved.journal_date

  return (
    <section className="journal-editor" aria-label="新建 Journal">
      <div className="detail-header">
        <h2>新建 Journal</h2>
        <button type="button" onClick={onClose}>返回列表</button>
      </div>
      <div className={`autosave-status autosave-${autosave.status}`} role="status" aria-live="polite">
        <span className="autosave-label">{statusLabel(autosave.status)}</span>
        <span className="autosave-hint">{autosave.status === 'failed' || autosave.status === 'conflict'
          ? autosave.error : autosaveHint(autosave.status)}</span>
        {autosave.status === 'saved' && lastSaved !== null && (
          <span className="autosave-hint">已保存：{lastSaved.display_title}</span>
        )}
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
      <form className="editor-form" onSubmit={(event) => { event.preventDefault(); void autosave.saveNow() }}>
        <label className="editor-field"><span>日期</span>
          <input type="date" value={draft.date}
            onChange={(event) => changeDate(event.target.value)} />
        </label>
        <label className="editor-field"><span>标题（可留空）</span>
          <input type="text" value={draft.title}
            onChange={(event) => autosave.changeDraft({ title: event.target.value })}
            onCompositionStart={autosave.onCompositionStart}
            onCompositionEnd={autosave.onCompositionEnd} />
        </label>
        <div className="editor-field">
          <span>正文</span>
          <WritingEditor
            blocks={draftBlocks}
            onChange={(blocks) => autosave.changeDraft({ blocks, content: projectBlocks(blocks) })}
            onCompositionStart={autosave.onCompositionStart}
            onCompositionEnd={autosave.onCompositionEnd}
          />
        </div>
        <FolderSelect value={draft.folder_id}
          onChange={(folderId) => autosave.changeDraft({ folder_id: folderId })} />
        {invalidDraft && (
          <p className="detail-hint" role="status">
            空白或超长的输入不会提交，也不会创建空文件；内容保留在编辑器里。
          </p>
        )}
        {outsideFilter && (
          <p className="detail-hint">当前列表筛选的是 {listFilterDate}，这篇不在当前列表中。</p>
        )}
        <div className="editor-actions">
          <button type="submit" disabled={!autosave.dirty}>立即保存</button>
          <button type="button" onClick={onClose}>返回列表</button>
        </div>
      </form>
      <div className="editor-day" aria-label="当天已有记录">
        <p className="editor-day-title">
          {draft.date === '' ? '先选择日期，才能查看该日期已有记录。'
            : visibleDayStatus === 'loading' ? '正在读取该日期已有记录……'
            : visibleDayStatus === 'error' ? `读取该日期已有记录失败：${dayError}`
            : `该日期已有 ${dayResult?.total ?? 0} 篇记录。`}
        </p>
        {draft.date !== '' && visibleDayStatus === 'error' && (
          <button type="button" onClick={() => setDayReloadToken((value) => value + 1)}>重试</button>
        )}
        {draft.date !== '' && visibleDayStatus === 'success' && dayResult && (
          <>
            <JournalList journals={dayResult.items} onOpen={onOpen} openDisabled={false} />
            <Pagination page={dayResult.page} total={dayResult.total} hasNext={dayResult.has_next}
              onPageChange={(value) => {
                setDayResult(null)
                setDayStatus('loading')
                setDayPage(value)
              }} disabled={false} label="当天已有记录分页" />
          </>
        )}
      </div>
    </section>
  )
}

export default JournalEditor
