import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import './components/JournalPage.css'
import { listJournals } from './api/journals'
import { searchFiles } from './api/search'
import { journalSearchConditions } from './utils/homeSearch'
import AppShell from './components/AppShell'
import DashboardPage from './pages/DashboardPage'
import WritingPage from './pages/WritingPage'
import { useTodayOverview } from './hooks/useTodayOverview'
import JournalDetail from './components/JournalDetail'
import JournalEditor from './components/JournalEditor'
import JournalList from './components/JournalList'
import Pagination from './components/Pagination'
import LinkCandidates from './components/LinkCandidates'
import FolderPage from './pages/FolderPage'
import InboxPage from './pages/InboxPage'
import InsightPage, { type InsightDraftRequest } from './pages/InsightPage'
import ReviewPage from './pages/ReviewPage'
import SettingsPage from './pages/SettingsPage'
import TrashPage from './pages/TrashPage'
import SearchPage from './pages/SearchPage'
import type { FileIdentity } from './types/file'
import type { JournalPage } from './types/journal'
import type { SearchConditions, SearchPageData } from './types/search'
import type { FlushResult } from './hooks/useAutosave'
import type { ReviewSource } from './utils/reviewSelection'
import { nearestValidPage } from './utils/pagination'
import type { InsightDraftSeed } from './utils/insightAiDraft'

/**
 * Stage 4 / S04-T06：把 T05 的外壳（`AppShell`）、T05 的今日概览（`DashboardPage`
 * + `hooks/useTodayOverview`）与 T06 的写作页（`WritingPage` + `utils/writingSession`）
 * 接进正式应用。
 *
 * 接线原则（`docs/stage4-tasks.md` §5「文件所有权与交接」、本次用户指令）：
 * - 外壳只提供布局、响应式与外观；导航点击、「先保存再跳转」仍由本文件的
 *   `navigate` / `registerFlush` 负责，没有第二套导航或保存逻辑；
 * - 既有模块（所有日记/收件箱/复盘/洞察/全部搜索/回收箱/文件夹/设置）原样保留，
 *   它们的面板、卸载 flush、删除与链接解析行为都不变；
 * - 尚未交付的功能（开始今天 / 结束今天的独立编辑页属 T10）**不伪造**：
 *   点击只给明确说明，不创建任何记录，也不放 Mock 数据冒充真实接线；
 * - 概览与写作都只读或走既有会话队列，进入页面本身不产生写入。
 */
type Module =
  | 'dashboard'
  | 'writing'
  | 'journal'
  | 'inbox'
  | 'insight'
  | 'search'
  | 'trash'
  | 'folder'
  | 'review'
  | 'settings'
type Panel = { kind: 'list' } | { kind: 'create'; key: number } | { kind: 'detail'; file: FileIdentity; key: number }

/**
 * 主导航顺序按「今天 → 写作 → 归档与查找」排列。
 * 「开始今天 / 结束今天」不在这里：它们是 Ritual 页面（T10）的入口，
 * 本轮只在概览卡片上出现，不提供未实现的导航项。
 */
const modules: { id: Module; label: string }[] = [
  { id: 'dashboard', label: '概览' },
  { id: 'writing', label: '写作' },
  { id: 'journal', label: '所有日记' },
  { id: 'inbox', label: '收件箱' },
  { id: 'review', label: '复盘' },
  { id: 'insight', label: '洞察' },
  { id: 'search', label: '全部搜索' },
  { id: 'trash', label: '回收箱' },
  { id: 'folder', label: '文件夹' },
  { id: 'settings', label: '设置' },
]

/** 写作页的一次性「打开某篇」请求；由 WritingPage 消费后清空。 */
type WritingOpenRequest = { id: number; key: number }

/**
 * 今日概览模块。
 *
 * 单独成组件，是为了让 `useTodayOverview`（三个真实 GET）只在概览可见时存在：
 * 切走即卸载、切回即重新读取，不需要在 App 里挂一个常驻的读取副作用，
 * 也不会因为停留在别的模块而反复请求。
 */
function DashboardModule(props: {
  disabled: boolean
  onNewWriting: () => void
  onOpenWriting: (id: number) => void
  onStartRitual: (kind: 'set' | 'end') => void
  onOpenRitual: (kind: 'set' | 'end', id: number) => void
}) {
  const overview = useTodayOverview()
  return (
    <DashboardPage
      status={overview.status}
      today={overview.today}
      error={overview.error}
      disabled={props.disabled}
      onRetry={overview.reload}
      onNewWriting={props.onNewWriting}
      onOpenWriting={props.onOpenWriting}
      onStartRitual={props.onStartRitual}
      onOpenRitual={props.onOpenRitual}
    />
  )
}

function App() {
  const [module, setModule] = useState<Module>('dashboard')
  const [homeInput, setHomeInput] = useState('')
  const [homeQuery, setHomeQuery] = useState('')
  const [homePage, setHomePage] = useState(1)
  const [homeResult, setHomeResult] = useState<SearchPageData | null>(null)
  const [homeStatus, setHomeStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [homeError, setHomeError] = useState('')
  const [homeRevision, setHomeRevision] = useState(0)
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
  // 用户在真实复盘预览主动选中的一次性 Insight 编辑请求。
  const [insightDraft, setInsightDraft] = useState<InsightDraftRequest | null>(null)
  const consumeInsightDraft = useCallback(() => setInsightDraft(null), [])
  const [reviewDrafts, setReviewDrafts] = useState<InsightDraftSeed[]>([])
  // Folder 混合卡片的一次性打开请求：交给对应模块消费后清空。
  const [crossOpen, setCrossOpen] = useState<{ file: FileIdentity; key: number } | null>(null)
  const consumeCrossOpen = useCallback(() => setCrossOpen(null), [])
  // T09：详情页「复盘这篇」的一次性预选源；ReviewPage 消费后清空。
  const [reviewSeed, setReviewSeed] = useState<{ source: ReviewSource; key: number } | null>(null)
  const consumeReviewSeed = useCallback(() => setReviewSeed(null), [])
  // T06：概览的今日写作点击后，交给写作页打开那一篇（一次性请求）。
  const [writingOpen, setWritingOpen] = useState<WritingOpenRequest | null>(null)
  const consumeWritingOpen = useCallback(() => setWritingOpen(null), [])
  const writingKey = useRef(0)

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
    const conditions = journalSearchConditions(homeQuery, homePage)
    if (module !== 'journal' || !conditions) return
    const controller = new AbortController()
    setHomeStatus('loading')
    searchFiles(conditions, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const valid = nearestValidPage(data.page, data.total)
      if (valid !== data.page) { setHomePage(valid); return }
      setHomeResult(data)
      setHomeStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setHomeResult(null)
      setHomeError(error instanceof Error ? error.message : '搜索失败，请稍后重试')
      setHomeStatus('error')
    })
    return () => controller.abort()
  }, [module, homeQuery, homePage, homeRevision, dataRevision])

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

  /**
   * 概览 → 写作：切到写作模块并让 WritingPage 打开指定文件。
   *
   * 这里不自己读详情、不自己建会话：写作页会用 T02 的 `openSession` 复用/打开
   * 同一篇的会话（含未提交输入），并走同一条保存队列。
   */
  function openWriting(id: number) {
    navigate(() => {
      dirtyRef.current = false
      setNotice('')
      writingKey.current += 1
      setWritingOpen({ id, key: writingKey.current })
      setModule('writing')
    })
  }

  /**
   * 写作页遇到旧格式记录（`content_doc IS NULL` 或带旧 blocks）时，
   * 交给既有旧编辑器打开：不在写作页里转换正文、不改原文。
   */
  function openLegacyJournal(id: number) {
    navigate(() => {
      dirtyRef.current = false
      setNotice('')
      showList()
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      setModule('journal')
      setPanel({ kind: 'detail', file: { type: 'journal', id }, key: nextKey })
      beginLoading()
    })
  }

  /** 尚未交付的 Ritual 编辑页（T10）只给说明，绝不用 Mock 冒充已接线。 */
  function ritualNotWired(kind: 'set' | 'end'): void {
    const label = kind === 'set' ? '开始今天' : '结束今天'
    setNotice(`「${label}」的独立编辑页由 T10 交付，本轮未接入；这里不会创建任何记录。今天已有的${label}可以在「所有日记」里查看。`)
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

  /**
   * T09 单篇入口：Journal 详情 / Inbox 详情点「复盘这篇」。
   *
   * 只登记一次性预选源并切到复盘模块；**不**在这里直接调 navigate——调用方
   * 已经把它包在 `navigate(() => startReview(file))` 里，因此「先 flush 最新
   * 有效待保存输入、失败则停留」的导航保护对单篇入口同样生效。
   */
  function startReview(file: FileIdentity) {
    if (file.type === 'insight') return
    dirtyRef.current = false
    setNotice('')
    showList()
    const nextKey = editorKey + 1
    setEditorKey(nextKey)
    setReviewSeed({
      source: { type: file.type === 'inbox' ? 'inbox' : 'journal', id: file.id },
      key: nextKey,
    })
    setModule('review')
  }

  /**
   * T09 保存成功后的目标导航：按后端返回的 target 打开真实 Journal。
   *
   * 走统一 `navigate`（含 flush 保护）并给出一条成功提示；刷新列表但不重发保存。
   */
  function openReviewTarget(id: number, drafts: InsightDraftSeed[]) {
    navigate(() => {
      dirtyRef.current = false
      setReviewDrafts(drafts)
      showList()
      setModule('journal')
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      setPanel({ kind: 'detail', file: { type: 'journal', id }, key: nextKey })
      setNotice(`复盘已保存到 Journal ${id}。`)
      refreshData()
    })
  }

  function addReviewInsight(seed: InsightDraftSeed) {
    navigate(() => {
      showList()
      setNotice('')
      setCrossOpen(null)
      const nextKey = editorKey + 1
      setEditorKey(nextKey)
      setInsightDraft({ seed, key: nextKey })
      setModule('insight')
    })
  }

  /** 界面禁用统一口径：写入 busy 或 AI 处理中锁任一成立即视为锁定。 */
  const uiLocked = busy || aiLocked

  /**
   * 导航槽内容：品牌、新建入口、模块导航。
   *
   * 外层带 `app app-embedded`：`.app` 只作为按钮/输入框的基础样式命名空间，
   * 布局交给 AppShell（见 App.css 末尾的接线说明）。导航的点击语义仍是
   * `changeModule` → `navigate`，与接线前完全一致。
   */
  const navigation = (
    <div className="app app-embedded app-nav-host">
      <header className="app-header">
        <h1>SeekJournal</h1>
        <p className="app-subtitle">记录经历与思考</p>
      </header>
      <button
        className="home-new"
        type="button"
        disabled={uiLocked}
        onClick={() => { if (module === 'journal') newJournal(); else navigate(() => { dirtyRef.current = false; setNotice(''); setModule('journal'); setPanel({ kind: 'create', key: editorKey + 1 }); setEditorKey(editorKey + 1); beginLoading() }) }}
      >
        新建记录
      </button>
      <nav className="app-navigation" aria-label="模块导航">
        {modules.map((item) => (
          <button key={item.id} type="button" aria-pressed={module === item.id}
            disabled={uiLocked} onClick={() => changeModule(item.id)}>{item.label}</button>
        ))}
      </nav>
    </div>
  )

  return (
    <AppShell navigation={navigation} context={null} aside={null}>
      <div className="app app-embedded">
        <div className="app-content">

          {notice !== '' && (module === 'dashboard' || module === 'writing') && (
            <p className="detail-success" role="status">{notice}</p>
          )}

          {module === 'dashboard' && (
            <DashboardModule
              disabled={uiLocked}
              onNewWriting={() => changeModule('writing')}
              onOpenWriting={openWriting}
              onStartRitual={ritualNotWired}
              onOpenRitual={(kind) => ritualNotWired(kind)}
            />
          )}

          {module === 'writing' && (
            <WritingPage
              disabled={uiLocked}
              onDirtyChange={setDirty}
              onFlushReady={registerFlush}
              onOpenLegacy={openLegacyJournal}
              initialFile={writingOpen}
              onInitialFileConsumed={consumeWritingOpen}
            />
          )}

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
          {module === 'settings' && <SettingsPage disabled={uiLocked} />}
          {module === 'review' && (
            <ReviewPage
              initialSource={reviewSeed?.source ?? null}
              initialSourceKey={reviewSeed?.key ?? 0}
              onInitialSourceConsumed={consumeReviewSeed}
              onNavigate={navigate}
              onOpenJournal={openReviewTarget}
              onAddInsight={addReviewInsight}
              onOpenInsight={(id) => openFile({ type: 'insight', id })}
              onAiLockChange={registerAiLock} />
          )}
          {module === 'inbox' && (
            <InboxPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate}
              onResolveLink={resolveLink} onFlushReady={registerFlush} onAiLockChange={registerAiLock}
              onStartReview={(file) => navigate(() => startReview(file))}
              initialOpen={crossOpen?.file.type === 'inbox' ? { id: crossOpen.file.id, key: crossOpen.key } : null}
              onOpenRequestConsumed={consumeCrossOpen} />
          )}
          {module === 'insight' && (
            <InsightPage onDirtyChange={setDirty} onBusyChange={setWriting} onNavigate={navigate}
              onResolveLink={resolveLink} onFlushReady={registerFlush}
              initialDraft={insightDraft} onAddDraftConsumed={consumeInsightDraft}
              drafts={reviewDrafts}
              initialOpen={crossOpen?.file.type === 'insight' ? { id: crossOpen.file.id, key: crossOpen.key } : null}
              onOpenRequestConsumed={consumeCrossOpen} />
          )}
          {module === 'journal' && (
            <>
              {panel.kind === 'list' && <>
                <div className="home-heading"><h2>{homeQuery ? '搜索结果' : '所有日记'}</h2><span>{homeQuery ? (homeStatus === 'success' ? `${homeResult?.total ?? 0} 条匹配` : '') : (status === 'success' ? `${result?.total ?? 0} 篇日记` : '')}</span></div>
                <form className="home-search" onSubmit={(event) => { event.preventDefault(); const value = homeInput.trim(); setHomePage(1); setHomeQuery(value); if (value === homeQuery && value) setHomeRevision((v) => v + 1) }}>
                  <label className="sr-only" htmlFor="home-search">搜索日记标题和正文</label>
                  <input id="home-search" type="search" value={homeInput} onChange={(event) => setHomeInput(event.target.value)} placeholder="搜索日记标题和正文" />
                  <button type="submit">搜索</button>
                </form>
                {homeQuery && <button className="clear-search" type="button" onClick={() => { setHomeQuery(''); setHomeInput(''); setHomePage(1) }}>清除搜索</button>}
              </>}
              {panel.kind === 'list' && !homeQuery && <section className="app-toolbar" aria-label="日记列表工具">
                <label className="app-filter">
                  <span>按日期查看</span>
                  <input type="date" value={filterDate} disabled={uiLocked}
                    onChange={(event) => changeFilter(event.target.value)} />
                </label>
                <button type="button" onClick={() => changeFilter('')} disabled={uiLocked || filterDate === ''}>清除筛选</button>
              </section>}
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
                  onStartReview={(file) => navigate(() => startReview(file))}
                  onClose={() => navigate(showList)} onDataChanged={refreshData}
                  onDeleted={() => {
                    showList()
                    setNotice('已移入回收箱，可以恢复。可到回收箱页面查看或恢复。')
                    refreshData()
                  }} />
              )}
              {panel.kind === 'list' && homeQuery && <section className="journal-results" aria-label="搜索结果">
                {homeStatus === 'loading' && <p className="app-state" role="status">正在搜索……</p>}
                {homeStatus === 'error' && <div className="app-state app-state-error" role="alert"><p>{homeError}</p><button type="button" onClick={() => setHomeRevision((v) => v + 1)}>重试</button></div>}
                {homeStatus === 'success' && homeResult && <>
                  {homeResult.items.length === 0 ? <p className="app-state">没有找到匹配的日记，请尝试其他关键词。</p> : <JournalList journals={homeResult.items.filter((item): item is import('./types/journal').Journal => item.type === 'journal')} onOpen={openJournal} openDisabled={uiLocked} />}
                  <Pagination page={homeResult.page} total={homeResult.total} hasNext={homeResult.has_next} onPageChange={setHomePage} disabled={uiLocked} label="搜索结果分页" />
                </>}
              </section>}
              {panel.kind === 'list' && !homeQuery && <section className="journal-results" aria-label="日记列表">
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
                      ? <p className="app-state">{filterDate ? '这一天还没有日记，试试其他日期。' : '还没有日记。点击「新建记录」，写下今天的第一句话。'}</p>
                      : <JournalList journals={result.items} onOpen={openJournal}
                        openDisabled={uiLocked} />}
                    <Pagination page={result.page} total={result.total} hasNext={result.has_next}
                      onPageChange={changePage} disabled={uiLocked} label="Journal 列表分页" />
                  </>
                )}
              </section>}
            </>
          )}

        </div>
      </div>

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
    </AppShell>
  )
}
export default App
