import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { listJournals } from './api/journals'
import JournalDetail from './components/JournalDetail'
import JournalEditor from './components/JournalEditor'
import JournalList from './components/JournalList'
import Pagination from './components/Pagination'
import LinkCandidates from './components/LinkCandidates'
import FolderPage from './pages/FolderPage'
import InboxPage from './pages/InboxPage'
import InsightPage from './pages/InsightPage'
import TrashPage from './pages/TrashPage'
import SearchPage from './pages/SearchPage'
import type { FileIdentity } from './types/file'
import type { JournalPage } from './types/journal'
import type { SearchConditions } from './types/search'
import type { FlushResult } from './hooks/useAutosave'
import { nearestValidPage } from './utils/pagination'
import { reviewDraftsToSeeds, type InsightDraftLike } from './utils/insightAiDraft'

type Module = 'journal' | 'inbox' | 'insight' | 'search' | 'trash' | 'folder'
type Panel = { kind: 'list' } | { kind: 'create'; key: number } | { kind: 'detail'; file: FileIdentity; key: number }
const modules: { id: Module; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'journal', label: 'Journal' },
  { id: 'insight', label: 'Insight' }, { id: 'search', label: 'Search' },
  { id: 'trash', label: 'Trash' }, { id: 'folder', label: 'Folder' },
]

/**
 * 开发自查入口（T10）：从 `?t10drafts=<base64url(JSON)>` 读取一组合成观点草稿，
 * 交给 Insight 模块，用来在真实浏览器里检查草稿面板、添加与普通搜索。
 *
 * - 只在开发构建生效；生产构建直接返回空数组，因此线上没有任何读取入口；
 * - 只解析本地 URL，不读服务器数据，也不改变草稿内容；
 * - 用 base64url（查询串里 `+` 会被解析成空格，标准 base64 不可靠）；
 * - 草稿形状与 T09 复盘预览将要提供的 `insight_drafts` 一致，最多 15 份。
 */
function readDraftPreview(): ReturnType<typeof reviewDraftsToSeeds> {
  if (!import.meta.env.DEV) return []
  const raw = new URLSearchParams(window.location.search).get('t10drafts')
  if (raw === null || raw === '') return []
  try {
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = atob(padded)
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!Array.isArray(parsed)) return []
    return reviewDraftsToSeeds(parsed.slice(0, 15) as InsightDraftLike[])
  } catch {
    return []
  }
}

function App() {
  const [module, setModule] = useState<Module>('journal')
  const [panel, setPanel] = useState<Panel>({ kind: 'list' })
  const [editorKey, setEditorKey] = useState(0)
  const [filterDate, setFilterDate] = useState('')
  const [page, setPage] = useState(1)
  const [result, setResult] = useState<JournalPage | null>(null)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  const [dataRevision, setDataRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  // ref同步更新，点击连续发生时也不能绕过写入锁或离开检查。
  const busyRef = useRef(false)
  const dirtyRef = useRef(false)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  // T02：当前编辑面板注册的 flush。所有离开出口先 flush 最新有效草稿再导航。
  const flushRef = useRef<(() => Promise<FlushResult>) | null>(null)
  const registerFlush = useCallback((flush: (() => Promise<FlushResult>) | null) => {
    flushRef.current = flush
  }, [])
  // T07：AI 处理中锁（最长 90 秒）。单独持有，不复用 writing busy，避免误解锁或死锁。
  const aiLockedRef = useRef(false)
  const [aiLocked, setAiLocked] = useState(false)
  const registerAiLock = useCallback((locked: boolean) => {
    aiLockedRef.current = locked
    setAiLocked(locked)
  }, [])
  const [leaveBlocked, setLeaveBlocked] = useState(false)
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const [notice, setNotice] = useState('')
  const [linkRequest, setLinkRequest] = useState<{ title: string; key: number } | null>(null)
  const linkKey = useRef(0)
  const [searchConditions, setSearchConditions] = useState<SearchConditions>({ q: '', type: 'all', page: 1 })
  // T10 开发自查：只解析一次 URL，正常访问（无参数）恒为空数组。
  const [previewDrafts] = useState(readDraftPreview)
  // Folder 混合卡片的一次性打开请求：交给对应模块消费后清空。
  const [crossOpen, setCrossOpen] = useState<{ file: FileIdentity; key: number } | null>(null)
  const consumeCrossOpen = useCallback(() => setCrossOpen(null), [])

  useEffect(() => {
    if (module !== 'journal') return
    const controller = new AbortController()
    listJournals(filterDate || undefined, page, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setPage(validPage)
        return
      }
      setResult(data)
      setStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setResult(null)
      setErrorMessage(error instanceof Error ? error.message : '加载失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [module, filterDate, page, dataRevision])

  useEffect(() => {
    const dialog = confirmDialog.current
    if (pendingNavigation !== null && dialog && !dialog.open) dialog.showModal()
    if (pendingNavigation === null && dialog?.open) dialog.close()
  }, [pendingNavigation])

  function setWriting(value: boolean) {
    busyRef.current = value
    setBusy(value)
  }
  function setDirty(value: boolean) {
    dirtyRef.current = value
  }
  /**
   * 每个离开出口只提交动作；真正导航前在这里统一处理。
   *
   * T02：编辑面板注册了 flush 时，先等最新有效草稿落库再导航；
   * flush 返回 blocked（保存失败 / 版本冲突 / 输入不合法）则停留，
   * 只有用户明确选择放弃才离开。
   */
  function navigate(action: () => void) {
    if (busyRef.current) return
    // T07：AI 处理中锁定导航；锁由编辑面板登记，与自动保存 busy 分开。
    if (aiLockedRef.current) {
      setNotice('AI 正在处理这篇内容，编辑、删除与导航已临时锁定；处理结束即可继续。')
      return
    }
    const run = () => {
      setLinkRequest(null)
      action()
    }
    const flush = flushRef.current
    if (flush === null) {
      if (dirtyRef.current) {
        setLeaveBlocked(false)
        setPendingNavigation(() => run)
        return
      }
      run()
      return
    }
    void (async () => {
      let result: FlushResult
      try {
        result = await flush()
      } catch {
        result = 'blocked'
      }
      if (result === 'blocked') {
        setLeaveBlocked(true)
        setPendingNavigation(() => run)
        return
      }
      run()
    })()
  }
  function resolveLink(title: string) {
    navigate(() => setLinkRequest({ title, key: ++linkKey.current }))
  }
  function confirmLeave() {
    const action = pendingNavigation
    setPendingNavigation(null)
    setLeaveBlocked(false)
    dirtyRef.current = false
    action?.()
  }
  function beginLoading() {
    setStatus('loading')
    setErrorMessage('')
    setResult(null)
  }
  function refreshData() {
    beginLoading()
    setDataRevision((value) => value + 1)
  }
  function showList() {
    dirtyRef.current = false
    setPanel({ kind: 'list' })
  }
  function changeModule(value: Module) {
    navigate(() => {
      showList()
      setNotice('')
      if (value !== module) {
        if (value === 'journal') beginLoading()
        setModule(value)
      }
    })
  }
  function openJournal(id: number) {
    navigate(() => {
      dirtyRef.current = false
      setNotice('')
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      setPanel({ kind: 'detail', file: { type: 'journal', id }, key: nextKey })
    })
  }
  function newJournal() {
    navigate(() => {
      dirtyRef.current = false
      setNotice('')
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      setPanel({ kind: 'create', key: nextKey })
    })
  }
  function changeFilter(value: string) {
    if (value === filterDate) return
    navigate(() => {
      showList()
      beginLoading()
      setFilterDate(value)
      setPage(1)
    })
  }
  function changePage(value: number) {
    navigate(() => {
      showList()
      beginLoading()
      setPage(value)
    })
  }
  /** Folder/Search 卡片共用按 (type, id) 打开的真实详情与 Dirty 导航。 */
  function openFile(file: FileIdentity) {
    navigate(() => {
      dirtyRef.current = false
      setNotice('')
      showList()
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      if (file.type === 'journal') {
        if (module !== 'journal') beginLoading()
        setModule('journal')
        setPanel({ kind: 'detail', file, key: nextKey })
        return
      }
      setModule(file.type)
      setCrossOpen({ file, key: nextKey })
    })
  }

  /** 界面禁用统一口径：写入 busy 或 AI 处理中锁任一成立即视为锁定。 */
  const uiLocked = busy || aiLocked

  return (
    <main className="app">
      <header className="app-header">
        <h1>SeekJournal</h1>
        <p className="app-subtitle">记录经历与思考</p>
      </header>
      <nav className="app-navigation" aria-label="模块导航">
        {modules.map((item) => (
          <button key={item.id} type="button" aria-pressed={module === item.id}
            disabled={uiLocked} onClick={() => changeModule(item.id)}>{item.label}</button>
        ))}
      </nav>

      {module === 'search' && (
        <SearchPage conditions={searchConditions} onConditionsChange={setSearchConditions}
          onNavigate={navigate} onOpenFile={openFile} />
      )}
      {module === 'trash' && (
        <TrashPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate} onResolveLink={resolveLink} />
      )}
      {module === 'folder' && (
        <FolderPage onDirtyChange={setDirty} onBusyChange={setWriting}
          onNavigate={navigate} onOpenFile={openFile} />
      )}
      {module === 'inbox' && (
        <InboxPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate}
          onResolveLink={resolveLink} onFlushReady={registerFlush} onAiLockChange={registerAiLock}
          initialOpen={crossOpen?.file.type === 'inbox' ? { id: crossOpen.file.id, key: crossOpen.key } : null}
          onOpenRequestConsumed={consumeCrossOpen} />
      )}
      {module === 'insight' && (
        <InsightPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate}
          onResolveLink={resolveLink} onFlushReady={registerFlush}
          drafts={previewDrafts}
          initialOpen={crossOpen?.file.type === 'insight' ? { id: crossOpen.file.id, key: crossOpen.key } : null}
          onOpenRequestConsumed={consumeCrossOpen} />
      )}
      {module === 'journal' && (
        <>
          <section className="app-toolbar" aria-label="Journal 列表工具">
            <button type="button" onClick={newJournal} disabled={uiLocked}>新建 Journal</button>
            <button type="button" onClick={() => navigate(showList)} disabled={uiLocked}>Journal 列表</button>
            <label className="app-filter">
              <span>按日期查看</span>
              <input type="date" value={filterDate} disabled={uiLocked}
                onChange={(event) => changeFilter(event.target.value)} />
            </label>
            <button type="button" onClick={() => changeFilter('')} disabled={uiLocked || filterDate === ''}>清除筛选</button>
          </section>
          {notice && <p className="detail-success" role="status">{notice}</p>}
          {panel.kind === 'create' && (
            <JournalEditor key={panel.key} listFilterDate={filterDate} externalRevision={dataRevision}
              onSaved={() => refreshData()} onOpen={openJournal} onClose={() => navigate(showList)}
              onDirtyChange={setDirty} onFlushReady={registerFlush} onAiLockChange={registerAiLock} />
          )}
          {panel.kind === 'detail' && (
            <JournalDetail key={`${panel.file.type}:${panel.file.id}:${panel.key}`} journalId={panel.file.id}
              onResolveLink={resolveLink}
              onBusyChange={setWriting} onDirtyChange={setDirty} onFlushReady={registerFlush}
              onAiLockChange={registerAiLock}
              onNavigate={navigate}
              onClose={() => navigate(showList)} onDataChanged={refreshData}
              onDeleted={() => {
                showList()
                setNotice('已移入回收箱，可以恢复。可到 Trash 页面查看或恢复。')
                refreshData()
              }} />
          )}
          <section className="journal-results" aria-label="Journal 列表">
            {status === 'loading' && <p className="app-state" role="status">加载中……</p>}
            {status === 'error' && (
              <div className="app-state app-state-error" role="alert">
                <p>列表加载失败：{errorMessage}</p>
                <button type="button" onClick={refreshData} disabled={uiLocked}>重试</button>
              </div>
            )}
            {status === 'success' && result && (
              <>
                {result.items.length === 0
                  ? <p className="app-state">{filterDate ? '该日期没有 Journal 记录。' : '还没有任何 Journal 记录。'}</p>
                  : <JournalList journals={result.items} onOpen={openJournal}
                    selectedId={panel.kind === 'detail' ? panel.file.id : null} openDisabled={uiLocked} />}
                <Pagination page={result.page} total={result.total} hasNext={result.has_next}
                  onPageChange={changePage} disabled={uiLocked} label="Journal 列表分页" />
              </>
            )}
          </section>
        </>
      )}

      {linkRequest && <LinkCandidates key={linkRequest.key} title={linkRequest.title} disabled={uiLocked}
        onOpen={openFile}
        onClose={() => setLinkRequest(null)} />}

      <dialog ref={confirmDialog} className="leave-dialog" aria-labelledby="leave-title"
        onCancel={(event) => { event.preventDefault(); setPendingNavigation(null); setLeaveBlocked(false) }}>
        <h2 id="leave-title">{leaveBlocked ? '最新改动还没保存成功，确定离开？' : '当前内容尚未保存，确定离开？'}</h2>
        <p>{leaveBlocked
          ? '自动保存失败或出现版本冲突，最新输入还没有提交到后端。确认离开会丢弃这些未保存的改动。'
          : '确认离开会丢弃本次未保存的改动。'}</p>
        <div className="detail-confirm-actions">
          <button type="button" autoFocus onClick={() => { setPendingNavigation(null); setLeaveBlocked(false) }}>继续编辑</button>
          <button type="button" onClick={confirmLeave}>确认离开</button>
        </div>
      </dialog>
    </main>
  )
}
export default App
