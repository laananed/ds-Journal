/**
 * SeekJournal 主页。
 *
 * Stage 1 / Task 8.1：通过真实 HTTP `GET` 请求读取 FastAPI 的 Journal 列表，
 * 支持按 `journal_date` 精确筛选与清除筛选，并处理加载中 / 有记录 / 空列表 /
 * 日期无记录 / 请求失败与重试。
 *
 * Stage 1 / Task 8.2：接入创建表单 `JournalEditor`，
 * 保存成功后按**当前筛选语义**刷新列表（全部还是全部，某日期还是该日期），
 * 不偷偷改筛选去让新记录出现。
 *
 * Stage 1 / Task 8.3：接入详情 / 修改 / 删除面板 `JournalDetail`。
 * 主列表与创建表单的「当天已有记录」都能打开某一条记录；
 * 详情面板修改或删除成功后，这里按当前筛选刷新列表，
 * 并用一个自增的 `dataRevision` 让创建表单重读「当天已有记录」。
 *
 * 设计要点：
 *
 * - 只用组件本地 `useState` / `useEffect`，不引入路由、状态管理或请求管理框架；
 * - 「打开的是哪一条」就是这里的 `selectedId`；详情面板通过 `key={selectedId}`
 *   在切换记录时整体重新挂载，旧记录的状态与在飞请求随之作废，
 *   因此迟到的旧响应不可能被应用到新记录上；
 * - `pendingWrite` 表示详情面板里是否有写操作（保存 / 删除）在进行，
 *   为 `true` 时禁用打开其它记录的入口，避免写入过程中换目标；
 * - 筛选由后端执行（把日期作为查询参数发给 API），不在前端拿全量再过滤；
 * - 保留 `main.tsx` 里的 `StrictMode`；
 * - 用 `AbortController` 在筛选变化或组件卸载时取消上一次请求，
 *   既避免「旧日期的迟到响应覆盖新日期结果」，也不会把取消误报成错误；
 * - 「进入加载中」的状态在事件处理器里设置（而不是在 effect 内同步 setState），
 *   effect 只负责发起请求与收尾，避免级联渲染；
 * - 列表刷新与「写入成功」互相独立：写入状态由各自的表单负责，
 *   这里刷新失败只在列表区域提示，不会被当成保存 / 删除失败。
 */

import { useEffect, useState } from 'react'
import './App.css'
import { listJournals } from './api/journals'
import JournalDetail from './components/JournalDetail'
import JournalEditor from './components/JournalEditor'
import JournalList from './components/JournalList'
import type { Journal } from './types/journal'

/** 列表加载状态。 */
type LoadStatus = 'loading' | 'success' | 'error'

function App() {
  // '' 表示「不筛选」，即显示全部记录。
  const [filterDate, setFilterDate] = useState('')
  const [journals, setJournals] = useState<Journal[]>([])
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  // 失败后点击「重试」或写入成功后自增，作为 effect 的依赖重新触发列表请求。
  const [reloadToken, setReloadToken] = useState(0)

  // 当前打开的 Journal id；null 表示没有打开任何详情。
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // 详情面板里是否有写操作在进行中。
  const [pendingWrite, setPendingWrite] = useState(false)
  // 「外部写入导致数据变了」的版本号：详情面板改过 / 删过之后自增，
  // 传给创建表单让它重读「当天已有记录」，但不触碰正在填写的表单内容。
  const [dataRevision, setDataRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    listJournals(filterDate || undefined, controller.signal)
      .then((data) => {
        setJournals(data)
        setStatus('success')
      })
      .catch((error: unknown) => {
        // 主动取消（切换筛选 / 卸载）不算失败，直接忽略。
        if (controller.signal.aborted) {
          return
        }
        // 失败时不保留过期列表，避免把旧结果伪装成当前筛选结果。
        setJournals([])
        setErrorMessage(
          error instanceof Error ? error.message : '加载失败，请稍后重试',
        )
        setStatus('error')
      })

    return () => {
      controller.abort()
    }
  }, [filterDate, reloadToken])

  /** 打开任一入口前先进入「加载中」，并清掉上一次的错误与旧列表。 */
  function beginLoading() {
    setStatus('loading')
    setErrorMessage('')
    setJournals([])
  }

  function handleFilterDateChange(value: string) {
    if (value === filterDate) {
      return
    }
    beginLoading()
    setFilterDate(value)
  }

  function handleClearFilter() {
    if (filterDate === '') {
      return
    }
    beginLoading()
    setFilterDate('')
  }

  function handleRetry() {
    beginLoading()
    setReloadToken((token) => token + 1)
  }

  /**
   * 创建成功后的列表刷新。
   *
   * 只触发一次重新加载，保持当前筛选含义不变；
   * 不在这里等待请求、也不向上抛异常——
   * 列表刷新失败会在列表区域单独提示，不会被误报成「保存失败」。
   */
  function handleJournalSaved() {
    beginLoading()
    setReloadToken((token) => token + 1)
  }

  /**
   * 详情面板里的写操作（修改 / 删除）成功后的数据同步。
   *
   * 按**当前筛选语义**重新读取列表，并且额外让创建表单重读「当天已有记录」——
   * 但不改筛选、不触碰正在填写的创建表单内容。
   * 与 `handleJournalSaved` 一样，这里不等待请求、不抛异常：
   * 刷新失败只在列表区域提示，不会被当成写入失败。
   */
  function handleDetailDataChanged() {
    beginLoading()
    setReloadToken((token) => token + 1)
    setDataRevision((revision) => revision + 1)
  }

  /** 打开某一条记录的详情。 */
  function handleOpenJournal(id: number) {
    // 有写操作在飞行中时入口本身已被禁用，这里再挡一层，避免换目标。
    if (pendingWrite) {
      return
    }
    setSelectedId(id)
  }

  /** 返回列表：只关闭详情面板，不请求任何接口。 */
  function handleDetailClose() {
    setSelectedId(null)
    setPendingWrite(false)
  }

  /** 删除成功：关闭详情，再按当前筛选刷新列表与当天记录。 */
  function handleDetailDeleted() {
    setSelectedId(null)
    setPendingWrite(false)
    handleDetailDataChanged()
  }

  const isFiltering = filterDate !== ''

  return (
    <main className="app">
      <header className="app-header">
        <h1>SeekJournal</h1>
        <p className="app-subtitle">查看你的 Journal 记录</p>
      </header>

      <JournalEditor
        listFilterDate={filterDate}
        onSaved={handleJournalSaved}
        externalRevision={dataRevision}
        onOpen={handleOpenJournal}
        openDisabled={pendingWrite}
      />

      <section className="app-toolbar">
        <label className="app-filter">
          <span>按日期查看</span>
          <input
            type="date"
            value={filterDate}
            onChange={(event) => handleFilterDateChange(event.target.value)}
          />
        </label>
        <button type="button" onClick={handleClearFilter} disabled={!isFiltering}>
          清除筛选
        </button>
      </section>

      {selectedId !== null && (
        // key 让「切换记录」变成重新挂载：旧详情状态与在飞请求一起作废。
        <JournalDetail
          key={selectedId}
          journalId={selectedId}
          onBusyChange={setPendingWrite}
          onClose={handleDetailClose}
          onDataChanged={handleDetailDataChanged}
          onDeleted={handleDetailDeleted}
        />
      )}

      {status === 'loading' && (
        <p className="app-state" role="status">
          加载中……
        </p>
      )}

      {status === 'error' && (
        <div className="app-state app-state-error" role="alert">
          <p>列表加载失败：{errorMessage}</p>
          <button type="button" onClick={handleRetry}>
            重试
          </button>
        </div>
      )}

      {status === 'success' && journals.length === 0 && (
        <p className="app-state">
          {isFiltering ? '该日期没有 Journal 记录。' : '还没有任何 Journal 记录。'}
        </p>
      )}

      {status === 'success' && journals.length > 0 && (
        <JournalList
          journals={journals}
          onOpen={handleOpenJournal}
          selectedId={selectedId}
          openDisabled={pendingWrite}
        />
      )}
    </main>
  )
}

export default App
