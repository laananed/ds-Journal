import { useEffect, useRef, useState } from 'react'
import {
  InboxApiError,
  createInbox,
  deleteInbox,
  getDailyInbox,
  getInbox,
  listInboxes,
  updateInbox,
} from '../api/inboxes'
import { WritingApiError, deleteAiBlock } from '../api/writing'
import FileCard from '../components/FileCard'
import FolderSelect from '../components/FolderSelect'
import WritingContent from '../components/WritingContent'
import WritingEditor from '../components/WritingEditor'
import Pagination from '../components/Pagination'
import type { Inbox, InboxCreate, InboxPage as InboxPageData, InboxUpdate } from '../types/inbox'
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
import { formatServerTimestamp } from '../utils/journalDetail'
import { defaultJournalDate } from '../utils/journalDate'
import { planDailyEntry } from '../utils/inboxDraft'
import { nearestValidPage } from '../utils/pagination'
import type { Block } from '../types/writing'

interface InboxPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
  /** T02：把当前编辑面板的 flush 交给 App。 */
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  /** Folder/Search/内部链接请求打开真实 Inbox；也支持同模块的新请求。 */
  initialOpen?: { id: number; key: number } | null
  onOpenRequestConsumed?: () => void
}

type InboxPanelShape =
  | { kind: 'create'; key: number; isDaily: boolean; inboxDate: string; savedId?: number }
  | { kind: 'detail'; key: number; id: number }

/** Daily 身份由 `is_daily` 决定，与标题无关。 */
function identityLabel(isDaily: boolean): string {
  return isDaily ? '当日 Daily Inbox' : '普通 Inbox'
}

/** 编辑态草稿：结构化写作统一使用块；历史 NULL 正文包成等价 user 段。 */
function toSnapshot(inbox: Inbox): DraftSnapshot {
  const blocks: Block[] = inbox.content_blocks != null && inbox.content_blocks.length > 0
    ? inbox.content_blocks
    : legacyBlocksFromContent(inbox.content)
  return draftToSnapshot(
    { title: inbox.title ?? '', content: inbox.content, folder_id: inbox.folder_id },
    inbox.inbox_date,
    blocks,
  )
}

function toFile(inbox: Inbox): AutosaveFile {
  return { id: inbox.id, revision: inbox.revision, draft: toSnapshot(inbox) }
}

/** 源码标题 + 结构化正文输入；创建与编辑共用同一份字段，避免重复组件。 */
function InboxFields({ draft, blocks, disabled, onTitle, changeDraft, composing, onBlocks, onRequestDeleteAiBlock, deletingBlockId, onResolveLink }: {
  draft: DraftSnapshot
  blocks: Block[]
  disabled: boolean
  onTitle: (value: string) => void
  changeDraft: (update: Partial<DraftSnapshot>) => void
  composing: { start: () => void; end: () => void }
  onBlocks: (blocks: Block[]) => void
  onRequestDeleteAiBlock?: (blockId: string) => void
  deletingBlockId?: string | null
  onResolveLink?: (title: string) => void
}) {
  return (
    <>
      <label className="editor-field"><span>标题（留空则用业务日期作为默认标题）</span>
        <input type="text" value={draft.title}
          onChange={(event) => onTitle(event.target.value)}
          onCompositionStart={composing.start} onCompositionEnd={composing.end} />
      </label>
      <div className="editor-field">
        <span>正文（用户文字与 AI 段分开显示）</span>
        <WritingEditor
          blocks={blocks}
          disabled={disabled}
          onChange={onBlocks}
          onCompositionStart={composing.start}
          onCompositionEnd={composing.end}
          onRequestDeleteAiBlock={onRequestDeleteAiBlock}
          deletingBlockId={deletingBlockId}
          onResolveLink={onResolveLink}
        />
      </div>
      <FolderSelect value={draft.folder_id}
        onChange={(folderId) => changeDraft({ folder_id: folderId })} />
    </>
  )
}

interface InboxPanelProps {
  panel: InboxPanelShape
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onFlushReady?: (flush: (() => Promise<FlushResult>) | null) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
  onCreated: (inbox: Inbox) => void
  onChanged: (inbox: Inbox) => void
  onDeleted: (inbox: Inbox) => void
  onClose: () => void
  onOpenRecord: (id: number) => void
}

function InboxPanel({
  panel, onDirtyChange, onBusyChange, onFlushReady, onResolveLink, onNavigate, onCreated, onChanged, onDeleted, onClose, onOpenRecord,
}: InboxPanelProps) {
  const inboxDate = panel.kind === 'create' ? panel.inboxDate : ''
  const inboxId = panel.kind === 'detail' ? panel.id : null

  const [status, setStatus] = useState<'ready' | 'loading' | 'success' | 'error'>(panel.kind === 'create' ? 'ready' : 'loading')
  const [file, setFile] = useState<Inbox | null>(null)
  // Creation changes identity in this session; never replace its hook or input DOM.
  const isCreate = panel.kind === 'create' && file === null
  const createdRef = useRef(false)
  const isDaily = file?.is_daily ?? (panel.kind === 'create' && panel.isDaily)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [mode, setMode] = useState<'view' | 'edit'>(panel.kind === 'create' ? 'edit' : 'view')
  const [deleteStage, setDeleteStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [deleteError, setDeleteError] = useState('')
  const [deletingBlockId, setDeletingBlockId] = useState<string | null>(null)
  const [blockError, setBlockError] = useState('')
  // Daily 冲突后重读到的已有 Daily 身份（null 表示该日期确实没有可打开的 Daily）。
  const [dailyConflict, setDailyConflict] = useState<{ id: number | null } | null>(null)
  const writing = useRef(false)
  /** 服务器最新版本：AI 段删除必须用最新 revision（缺 428 / 旧 409）。 */
  const latestRevisionRef = useRef(0)
  // 用户在标题框里真正打过字；决定创建请求是省略 title（用日期做默认标题）还是显式提交。
  const titleEditedRef = useRef(false)
  /**
   * 首次创建请求冻结的标题编辑标志（null = 尚未发出创建请求）。
   *
   * 后端创建幂等按**完整 payload** 比对：`title` 省略与显式 `null` 是两个不同 payload
   * （`docs/stage3-api.md` §1、§2）。若在响应丢失后用户才输入标题，重放必须仍用
   * **首次 payload**，否则会变成同键异体 409；那些新输入只进入最新草稿，
   * 由重放成功后的 PATCH 提交。
   */
  const createTitleEditedRef = useRef<boolean | null>(null)

  // 只构造一次初始草稿：新建面板给出一个空 user 段，块 id 跨渲染稳定。
  const [initialDraft] = useState<DraftSnapshot>(() => ({
    title: '', content: '', date: inboxDate, folder_id: null,
    blocks: isCreate ? [newUserBlock('')] : null,
  }))

  function rememberServer(inbox: Inbox): void {
    latestRevisionRef.current = inbox.revision
  }

  // 打开已有 Inbox 时真实读取详情；创建面板不发任何读请求。
  useEffect(() => {
    if (inboxId === null) return
    const controller = new AbortController()
    getInbox(inboxId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setFile(data)
      rememberServer(data)
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

  const autosave = useAutosave<Inbox>({
    enabled: mode === 'edit',
    initialDraft,
    initialFile: null,
    savable: (draft, context) => isSavable(draft, { ...context, requireDate: true }),
    create: async (draft, createKey) => {
      // 首次创建请求一旦发出即冻结「标题是否编辑过」：重放要发出与首次完全一致的 payload。
      if (createTitleEditedRef.current === null) createTitleEditedRef.current = titleEditedRef.current
      const payload: InboxCreate = {
        inbox_date: draft.date,
        is_daily: isDaily,
        folder_id: draft.folder_id,
        client_create_id: createKey,
        // 结构化写作只提交 content_blocks，绝不与 content 同时提交。
        content_blocks: draft.blocks ?? [],
      }
      // 没编辑过标题就省略 title：Daily / 普通 Inbox 都沿用后端「用业务日期做默认标题」。
      if (createTitleEditedRef.current) payload.title = draft.title === '' ? null : draft.title
      return await createInbox(payload)
    },
    update: async (fileId, draft, baseline, expectedRevision) => {
      const patch = snapshotPatch(draft, baseline)
      // 空补丁 = 响应丢失后的安全 no-op：只回读，不写。
      if (isSnapshotPatchEmpty(patch)) return await getInbox(fileId)
      const payload: InboxUpdate = { expected_revision: expectedRevision }
      if ('title' in patch) payload.title = patch.title
      if ('content' in patch) payload.content = patch.content
      if ('blocks' in patch) payload.content_blocks = patch.blocks
      if ('folder_id' in patch) payload.folder_id = patch.folder_id
      return await updateInbox(fileId, payload)
    },
    toFile,
    refetch: async () => {
      if (file === null) throw new Error('还没有创建成功，没有服务器版本可载入')
      return await getInbox(file.id)
    },
    onSaved: (saved) => {
      setFile(saved)
      rememberServer(saved)
      setStatus('success')
      if (panel.kind === 'create' && !createdRef.current) {
        createdRef.current = true
        createTitleEditedRef.current = null
        onCreated(saved)
      } else onChanged(saved)
    },
    onDirtyChange,
    onFlushReady,
  })

  // Daily 创建撞上 409：只重读该日期的 Daily 身份，绝不把当前草稿覆盖到已有记录。
  useEffect(() => {
    if (!autosave.conflict || !isDaily || !isCreate) return
    let cancelled = false
    getDailyInbox(inboxDate).then((state) => {
      if (cancelled) return
      const plan = planDailyEntry(state)
      setDailyConflict({ id: plan.kind === 'existing' ? plan.id : null })
    }).catch(() => {
      if (cancelled) return
      setDailyConflict({ id: null })
    })
    return () => { cancelled = true }
  }, [autosave.conflict, isDaily, isCreate, inboxDate])

  const busy = deleteStage === 'deleting' || deletingBlockId !== null
  const draft = autosave.draft
  const draftBlocks = draft.blocks ?? []

  function changeTitle(value: string) {
    titleEditedRef.current = true
    autosave.changeDraft({ title: value })
  }
  function startEditing() {
    if (!file) return
    const snapshot = toSnapshot(file)
    autosave.load({ id: file.id, revision: file.revision, draft: snapshot }, snapshot)
    setDeleteStage('idle')
    setDeleteError('')
    setBlockError('')
    setMode('edit')
  }
  function exitEditing() {
    createTitleEditedRef.current = null
    autosave.load(null, { title: '', content: '', date: '', folder_id: null })
    setDeleteStage('idle')
    setDeleteError('')
    setBlockError('')
    setMode('view')
  }

  async function confirmDelete() {
    if (file === null || writing.current) return
    writing.current = true
    onBusyChange(true)
    setDeleteStage('deleting')
    setDeleteError('')
    try {
      // Stage 3 契约：硬删除必须携带当前 revision（缺 428 / 旧 409）。
      await deleteInbox(file.id, file.revision)
      onDirtyChange(false)
      onDeleted(file)
    } catch (error: unknown) {
      if (error instanceof InboxApiError && error.status === 404) {
        // 目标已经不在了：与删除成功等价处理，刷新走正常路径。
        onDirtyChange(false)
        onDeleted(file)
      } else if (error instanceof InboxApiError && error.status === 409) {
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

  /** 删除一个 AI 段：先 flush 待保存输入，再按最新 revision 调专用接口，最后安全重读基线。 */
  async function requestDeleteAiBlock(blockId: string): Promise<void> {
    if (file === null || writing.current || deletingBlockId !== null) return
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
      await deleteAiBlock('inbox', file.id, blockId, latestRevisionRef.current)
      const refreshed = await getInbox(file.id)
      setFile(refreshed)
      rememberServer(refreshed)
      autosave.syncFromServer(toFile(refreshed))
      onChanged(refreshed)
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
    if (file === null) return
    try {
      const refreshed = await getInbox(file.id)
      setFile(refreshed)
      rememberServer(refreshed)
      autosave.syncFromServer(toFile(refreshed))
    } catch { /* 重读失败：保留原草稿与错误提示，不覆盖用户输入。 */ }
  }

  const heading = isCreate ? (isDaily ? '新建当日 Daily Inbox' : '新建 Inbox') : 'Inbox 详情'
  const invalidDraft = autosave.dirty && !autosave.savable

  const statusBanner = (
    <div className={`autosave-status autosave-${autosave.status}`} role="status" aria-live="polite">
      <span className="autosave-label">{statusLabel(autosave.status)}</span>
      <span className="autosave-hint">{autosave.status === 'failed' || autosave.status === 'conflict'
        ? autosave.error : autosaveHint(autosave.status)}</span>
      {autosave.status === 'failed' && (
        <button type="button" onClick={() => void autosave.retry()}>重试保存</button>
      )}
      {autosave.status === 'conflict' && (!isDaily || !isCreate) && (
        <>
          <button type="button" onClick={() => void autosave.resubmitAfterConflict()}>用我的草稿重试</button>
          <button type="button" onClick={() => void autosave.reloadServerVersion()}>重新载入服务器版本</button>
        </>
      )}
    </div>
  )

  return (
    <section className="journal-editor" aria-label={heading}>
      <div className="detail-header">
        <h2>{heading}</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>

      {mode === 'edit' && (panel.kind === 'create' || (status === 'success' && file)) && (
        <>
          <p className="inbox-identity">
            身份：{identityLabel(isDaily)} · 业务日期 {file?.inbox_date ?? inboxDate}
          </p>
          <p className="detail-hint">日期与 Daily 身份在创建后不可修改。</p>
          {statusBanner}
          <form className="editor-form" onSubmit={(event) => { event.preventDefault(); void autosave.saveNow() }}>
            <InboxFields draft={draft} blocks={draftBlocks}
              disabled={false}
              onTitle={changeTitle}
              onBlocks={(blocks) => autosave.changeDraft({ blocks, content: projectBlocks(blocks) })}
              changeDraft={autosave.changeDraft}
              composing={{ start: autosave.onCompositionStart, end: autosave.onCompositionEnd }}
              onRequestDeleteAiBlock={file === null ? undefined : (blockId) => void requestDeleteAiBlock(blockId)}
              deletingBlockId={deletingBlockId}
              onResolveLink={onResolveLink} />
            {blockError && <p className="detail-error" role="alert">{blockError}</p>}
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
          {isCreate && isDaily && autosave.conflict && dailyConflict !== null && (
            <div className="detail-confirm" role="alert">
              <p>该日期已经存在 Daily Inbox，未覆盖已有内容；当前未保存的输入仍然保留。</p>
              {dailyConflict.id !== null && (
                <div className="detail-confirm-actions">
                  <button type="button" onClick={() => onOpenRecord(dailyConflict.id as number)} disabled={busy}>
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
            <div className="detail-meta-row"><dt>版本</dt><dd>{file.revision}</dd></div>
            <div className="detail-meta-row"><dt>身份</dt><dd>{identityLabel(file.is_daily)}</dd></div>
            <div className="detail-meta-row"><dt>业务日期</dt><dd>{file.inbox_date}</dd></div>
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(file.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(file.updated_at)}</dd></div>
          </dl>
          <WritingContent blocks={file.content_blocks} content={file.content}
            onLink={onResolveLink} disabled={busy} />
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

    </section>
  )
}

function InboxPage({
  onDirtyChange, onBusyChange, onResolveLink, onNavigate, onFlushReady, initialOpen = null, onOpenRequestConsumed,
}: InboxPageProps) {
  // 初始外部请求直接进入详情；后续同模块链接由下面的 effect 消费。
  const [panel, setPanel] = useState<InboxPanelShape | { kind: 'list' }>(
    initialOpen ? { kind: 'detail', id: initialOpen.id, key: initialOpen.key } : { kind: 'list' },
  )
  // 从外部初始打开的序号继续递增，避免首次模块内切换复用旧 Panel。
  const keyRef = useRef(initialOpen?.key ?? 0)
  const consumedOpenKey = useRef(initialOpen?.key)
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
    if (consumedOpenKey.current !== initialOpen.key) {
      consumedOpenKey.current = initialOpen.key
      keyRef.current = Math.max(keyRef.current, initialOpen.key) + 1
      setPanel({ kind: 'detail', id: initialOpen.id, key: keyRef.current })
    }
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
    // List identity only; Dirty and the live save queue remain owned by the panel.
    setPanel((current) => current.kind === 'create'
      ? { ...current, savedId: inbox.id } : current)
    refreshList()
    setDailyRevision((value) => value + 1)
  }
  function handleChanged() {
    // 面板自身在查看态刷新；这里只负责刷新列表与 Daily 状态。
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
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onFlushReady={onFlushReady}
          onNavigate={onNavigate} onResolveLink={onResolveLink}
          onCreated={handleCreated} onChanged={handleChanged} onDeleted={handleDeleted}
          onClose={() => onNavigate(showList)} onOpenRecord={openInbox} />
      )}
      {panel.kind === 'detail' && (
        <InboxPanel key={`detail-${panel.key}`} panel={panel}
          onDirtyChange={onDirtyChange} onBusyChange={updateBusy} onFlushReady={onFlushReady}
          onNavigate={onNavigate} onResolveLink={onResolveLink}
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
                      <FileCard file={inbox} onOpen={(value) => openInbox(value.id)}
                        selected={(panel.kind === 'detail' && panel.id === inbox.id) || (panel.kind === 'create' && panel.savedId === inbox.id)} disabled={busy} />
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
