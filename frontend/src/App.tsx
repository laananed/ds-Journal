import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { listJournals } from './api/journals'
import JournalDetail from './components/JournalDetail'
import JournalEditor from './components/JournalEditor'
import JournalList from './components/JournalList'
import Pagination from './components/Pagination'
import FolderPage from './pages/FolderPage'
import InboxPage from './pages/InboxPage'
import InsightPage from './pages/InsightPage'
import type { FileIdentity } from './types/file'
import type { JournalPage } from './types/journal'
import { nearestValidPage } from './utils/pagination'

type Module = 'journal' | 'inbox' | 'insight' | 'search' | 'trash' | 'folder'
type Panel = { kind: 'list' } | { kind: 'create'; key: number } | { kind: 'detail'; file: FileIdentity; key: number }
const modules: { id: Module; label: string }[] = [
  { id: 'inbox', label: 'Inbox' }, { id: 'journal', label: 'Journal' },
  { id: 'insight', label: 'Insight' }, { id: 'search', label: 'Search' },
  { id: 'trash', label: 'Trash' }, { id: 'folder', label: 'Folder' },
]

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
  const confirmDialog = useRef<HTMLDialogElement>(null)
  const [notice, setNotice] = useState('')
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
  /** 每个离开出口只提交动作；真正导航前在这里统一检查。 */
  function navigate(action: () => void) {
    if (busyRef.current) return
    if (dirtyRef.current) {
      setPendingNavigation(() => action)
      return
    }
    action()
  }
  function confirmLeave() {
    const action = pendingNavigation
    setPendingNavigation(null)
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
  /** Folder 混合卡片按 (type, id) 打开真实详情；Journal 就地打开，Inbox/Insight 交给对应模块。 */
  function openFileFromFolder(file: FileIdentity) {
    navigate(() => {
      dirtyRef.current = false
      setNotice('')
      showList()
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      if (file.type === 'journal') {
        beginLoading()
        setModule('journal')
        setPanel({ kind: 'detail', file, key: nextKey })
        return
      }
      setModule(file.type)
      setCrossOpen({ file, key: nextKey })
    })
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>SeekJournal</h1>
        <p className="app-subtitle">记录经历与思考</p>
      </header>
      <nav className="app-navigation" aria-label="模块导航">
        {modules.map((item) => (
          <button key={item.id} type="button" aria-pressed={module === item.id}
            disabled={busy} onClick={() => changeModule(item.id)}>{item.label}</button>
        ))}
      </nav>

      {module !== 'journal' && module !== 'inbox' && module !== 'insight' && module !== 'folder' && (
        <section className="app-state" aria-label="尚未开放">
          <h2>{modules.find((item) => item.id === module)?.label}</h2>
          <p>该模块尚未开放。</p>
          <button type="button" onClick={() => changeModule('journal')}>返回 Journal</button>
        </section>
      )}
      {module === 'folder' && (
        <FolderPage onDirtyChange={setDirty} onBusyChange={setWriting}
          onNavigate={navigate} onOpenFile={openFileFromFolder} />
      )}
      {module === 'inbox' && (
        <InboxPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate}
          initialOpen={crossOpen?.file.type === 'inbox' ? { id: crossOpen.file.id, key: crossOpen.key } : null}
          onOpenRequestConsumed={consumeCrossOpen} />
      )}
      {module === 'insight' && (
        <InsightPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate}
          initialOpen={crossOpen?.file.type === 'insight' ? { id: crossOpen.file.id, key: crossOpen.key } : null}
          onOpenRequestConsumed={consumeCrossOpen} />
      )}
      {module === 'journal' && (
        <>
          <section className="app-toolbar" aria-label="Journal 列表工具">
            <button type="button" onClick={newJournal} disabled={busy}>新建 Journal</button>
            <button type="button" onClick={() => navigate(showList)} disabled={busy}>Journal 列表</button>
            <label className="app-filter">
              <span>按日期查看</span>
              <input type="date" value={filterDate} disabled={busy}
                onChange={(event) => changeFilter(event.target.value)} />
            </label>
            <button type="button" onClick={() => changeFilter('')} disabled={busy || filterDate === ''}>清除筛选</button>
          </section>
          {notice && <p className="detail-success" role="status">{notice}</p>}
          {panel.kind === 'create' && (
            <JournalEditor key={panel.key} listFilterDate={filterDate} externalRevision={dataRevision}
              onSaved={refreshData} onOpen={openJournal} onClose={() => navigate(showList)}
              onDirtyChange={setDirty} onBusyChange={setWriting} />
          )}
          {panel.kind === 'detail' && (
            <JournalDetail key={`${panel.file.type}:${panel.file.id}:${panel.key}`} journalId={panel.file.id}
              onBusyChange={setWriting} onDirtyChange={setDirty} onNavigate={navigate}
              onClose={() => navigate(showList)} onDataChanged={refreshData}
              onDeleted={() => {
                showList()
                setNotice('已移入回收箱，可以恢复。回收箱页面尚未开放。')
                refreshData()
              }} />
          )}
          <section className="journal-results" aria-label="Journal 列表">
            {status === 'loading' && <p className="app-state" role="status">加载中……</p>}
            {status === 'error' && (
              <div className="app-state app-state-error" role="alert">
                <p>列表加载失败：{errorMessage}</p>
                <button type="button" onClick={refreshData} disabled={busy}>重试</button>
              </div>
            )}
            {status === 'success' && result && (
              <>
                {result.items.length === 0
                  ? <p className="app-state">{filterDate ? '该日期没有 Journal 记录。' : '还没有任何 Journal 记录。'}</p>
                  : <JournalList journals={result.items} onOpen={openJournal}
                    selectedId={panel.kind === 'detail' ? panel.file.id : null} openDisabled={busy} />}
                <Pagination page={result.page} total={result.total} hasNext={result.has_next}
                  onPageChange={changePage} disabled={busy} label="Journal 列表分页" />
              </>
            )}
          </section>
        </>
      )}

      <dialog ref={confirmDialog} className="leave-dialog" aria-labelledby="leave-title"
        onCancel={(event) => { event.preventDefault(); setPendingNavigation(null) }}>
        <h2 id="leave-title">当前内容尚未保存，确定离开？</h2>
        <p>确认离开会丢弃本次未保存的改动。</p>
        <div className="detail-confirm-actions">
          <button type="button" autoFocus onClick={() => setPendingNavigation(null)}>继续编辑</button>
          <button type="button" onClick={confirmLeave}>确认离开</button>
        </div>
      </dialog>
    </main>
  )
}
export default App
