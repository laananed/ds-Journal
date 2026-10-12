import { useEffect, useRef, useState } from 'react'
import { createJournal, getJournal, listJournals, updateJournal } from '../api/journals'
import { WritingApiError, deleteAiBlock } from '../api/writing'
import AiWritingActions, { type AiPrepareResult } from './AiWritingActions'
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
import { parseAiFileDetail, type AiFileDetail } from '../utils/aiRequestState'
import { defaultJournalDate } from '../utils/journalDate'
import { nearestValidPage } from '../utils/pagination'
import type { Block } from '../types/writing'

interface JournalEditorProps {
  listFilterDate: string
  onSaved: (saved: Journal) => void
  externalRevision: number
  onOpen: (id: number) => void
  onClose: () => void
  onDirtyChange: (dirty: boolean) => void
  /** T02：把 flush 交给 App。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  /** T07：把 AI 处理中锁交给 App（与自动保存 busy 分开）。 */
  onAiLockChange?: (locked: boolean) => void
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

/** 后端完整文件详情 → `Journal`（蓝块已由后端附着，前端只读取）。 */
function toJournal(detail: AiFileDetail): Journal {
  return {
    type: 'journal',
    id: detail.id,
    revision: detail.revision,
    title: detail.title,
    display_title: detail.display_title,
    content: detail.content,
    content_blocks: detail.content_blocks as Block[] | null,
    journal_date: detail.date,
    folder_id: detail.folder_id,
    created_at: detail.created_at,
    updated_at: detail.updated_at,
    deleted_at: detail.deleted_at,
  }
}

function JournalEditor({
  listFilterDate, onSaved, externalRevision, onOpen, onClose, onDirtyChange, onFlushReady, onAiLockChange,
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
  /** 服务器最新版本：T07 调用 AI 必须用它做 expected_revision。 */
  const latestRevisionRef = useRef(0)
  /** T07：AI 处理中锁（与自动保存 busy 分开）。 */
  const [aiLocked, setAiLocked] = useState(false)
  /** T04：正在删除的 AI 段 id（禁用重复操作）；与 AI 处理中锁互不干扰。 */
  const [deletingBlockId, setDeletingBlockId] = useState<string | null>(null)
  const [blockError, setBlockError] = useState('')
  /** 删除自身的在途守卫：连续点击只在第一次通过。 */
  const deletingRef = useRef(false)

  function changeAiLock(locked: boolean): void {
    setAiLocked(locked)
    onAiLockChange?.(locked)
  }
  const rememberSaved = (saved: Journal): void => {
    lastSavedIdRef.current = saved.id
    latestRevisionRef.current = saved.revision
    setLastSaved(saved)
  }

  async function refetchSaved(): Promise<Journal> {
    if (lastSavedIdRef.current === 0) throw new Error('还没有创建成功，没有服务器版本可载入')
    const fresh = await getJournal(lastSavedIdRef.current)
    latestRevisionRef.current = fresh.revision
    return fresh
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

  /**
   * T07 调用前准备：新文件必须先**有效创建**取得 id 与 revision，再调用 AI。
   *
   * 这里不做「空文件占位」：草稿空白或超长时 `flush()` 返回 `blocked`，
   * 于是既不会创建空文件，也不会发出 AI 请求。
   */
  async function prepareAiCall(): Promise<AiPrepareResult> {
    const flushed = await autosave.flush()
    if (flushed === 'blocked') {
      return {
        ok: false,
        message: '还有未保存的输入、空白正文或版本冲突，已停止调用 AI（不会消耗 Token）。'
          + '请先写下有效正文并保存成功。',
      }
    }
    const revision = latestRevisionRef.current
    if (revision < 1 || lastSavedIdRef.current === 0) {
      return { ok: false, message: '还没有创建成功，无法调用 AI。请先写下有效正文让它保存。' }
    }
    return { ok: true, revision }
  }

  /**
   * 删除一个 AI 段（T04 要求的三入口，`docs/stage3-tasks.md` §6 步骤 6）。
   *
   * 新建流程同样必须补齐：这里按 `JournalDetail` 的既有实现照搬同一条链路——
   * ① 先 `flush()` 落库最新用户草稿；② 用**最新** revision 调专用接口；
   * ③ 重读详情，更新保存基线与身份。任何一步失败都保留用户输入，
   * 且绝不静默重复 DELETE。
   */
  async function requestDeleteAiBlock(blockId: string): Promise<void> {
    if (lastSavedIdRef.current === 0 || deletingRef.current || deletingBlockId !== null) return
    // AI 处理中不删除：菜单此时已被禁用，这里是同一约束的第二道闸门。
    if (aiLocked) return
    deletingRef.current = true
    setBlockError('')
    setDeletingBlockId(blockId)
    try {
      // 删除前先落库待保存输入；blocked（保存失败 / 冲突 / 输入不合法）就不发 DELETE。
      const flushed = await autosave.flush()
      if (flushed === 'blocked') {
        setBlockError('还有未保存的输入或版本冲突，已停止删除，避免与自动保存互相覆盖。请先处理保存状态。')
        return
      }
      // 必须用 flush 之后的最新 revision（缺 428 / 旧 409）。
      await deleteAiBlock('journal', lastSavedIdRef.current, blockId, latestRevisionRef.current)
      const fileId = lastSavedIdRef.current
      let refreshed: Journal
      try {
        refreshed = await getJournal(fileId)
      } catch {
        // DELETE 已经成功：不重复删除、不伪造，保留输入并如实说明需要手动刷新。
        setBlockError('该 AI 段已删除，但重新读取详情失败；当前输入已保留，可刷新页面或稍后再试。')
        return
      }
      rememberSaved(refreshed)
      autosave.syncFromServer(toFile(refreshed))
      onSaved(refreshed)
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
      deletingRef.current = false
      setDeletingBlockId(null)
    }
  }

  async function refreshAfterDeleteFailure(): Promise<void> {
    if (lastSavedIdRef.current === 0) return
    try {
      const refreshed = await getJournal(lastSavedIdRef.current)
      rememberSaved(refreshed)
      autosave.syncFromServer(toFile(refreshed))
    } catch { /* 重读失败：保留原草稿与错误提示，不覆盖用户输入。 */ }
  }

  /** 后端完整文件 → 刷新基线；蓝块与尾部空续写段都由后端给出。 */
  function applyAiFile(raw: unknown, origin: 'call' | 'recovery'): void {
    const parsed = parseAiFileDetail(raw)
    if (parsed === null) return
    const journal = toJournal(parsed)
    if (origin === 'call') {
      rememberSaved(journal)
      autosave.syncFromServer(toFile(journal))
      onSaved(journal)
      return
    }
    if (lastSavedIdRef.current === journal.id) {
      // recovery：采用后端最新文件作为保存基线（syncFromServer 自己区分
      // 「有未保存输入」与「没有未保存输入」两种情况，不会覆盖较新的草稿）。
      rememberSaved(journal)
      autosave.syncFromServer(toFile(journal))
    }
    onSaved(journal)
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
          <input type="date" value={draft.date} disabled={aiLocked}
            onChange={(event) => changeDate(event.target.value)} />
        </label>
        <label className="editor-field"><span>标题（可留空）</span>
          <input type="text" value={draft.title} disabled={aiLocked}
            onChange={(event) => autosave.changeDraft({ title: event.target.value })}
            onCompositionStart={autosave.onCompositionStart}
            onCompositionEnd={autosave.onCompositionEnd} />
        </label>
        <div className="editor-field">
          <span>正文</span>
          <WritingEditor
            blocks={draftBlocks}
            locked={aiLocked}
            onChange={(blocks) => autosave.changeDraft({ blocks, content: projectBlocks(blocks) })}
            onCompositionStart={autosave.onCompositionStart}
            onCompositionEnd={autosave.onCompositionEnd}
            onRequestDeleteAiBlock={(blockId) => void requestDeleteAiBlock(blockId)}
            deletingBlockId={deletingBlockId}
          />
        </div>
        <FolderSelect value={draft.folder_id} disabled={aiLocked}
          onChange={(folderId) => autosave.changeDraft({ folder_id: folderId })} />
        {blockError && <p className="detail-error" role="alert">{blockError}</p>}
        {invalidDraft && (
          <p className="detail-hint" role="status">
            空白或超长的输入不会提交，也不会创建空文件；内容保留在编辑器里。
          </p>
        )}
        {outsideFilter && (
          <p className="detail-hint">当前列表筛选的是 {listFilterDate}，这篇不在当前列表中。</p>
        )}
        <div className="editor-actions">
          <button type="submit" disabled={!autosave.dirty || aiLocked}>立即保存</button>
          <button type="button" onClick={onClose} disabled={aiLocked}>返回列表</button>
        </div>
      </form>
      {/* T07：新文件先有效创建取得 id 再调用 AI，不用空文件占位。 */}
      <AiWritingActions
        source={lastSaved === null ? null : { type: 'journal', id: lastSaved.id }}
        // 删除某个 AI 段期间禁用 AI 入口，避免两类在途操作互相竞争。
        disabled={deletingBlockId !== null}
        prepare={prepareAiCall}
        onServerFile={applyAiFile}
        onLockChange={changeAiLock}
        onActivity={() => { if (lastSaved !== null) onSaved(lastSaved) }}
      />
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
