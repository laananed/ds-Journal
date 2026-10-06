/**
 * SeekJournal 主页（Stage 1 / Task 8.1）。
 *
 * 通过真实 HTTP `GET` 请求读取 FastAPI 的 Journal 列表，支持按 `journal_date`
 * 精确筛选与清除筛选，并处理加载中 / 有记录 / 空列表 / 日期无记录 / 请求失败与重试。
 *
 * 设计要点：
 *
 * - 只用组件本地 `useState` / `useEffect`，不引入路由、状态管理或请求管理框架；
 * - 筛选由后端执行（把日期作为查询参数发给 API），不在前端拿全量再过滤；
 * - 保留 `main.tsx` 里的 `StrictMode`；
 * - 用 `AbortController` 在筛选变化或组件卸载时取消上一次请求，
 *   既避免「旧日期的迟到响应覆盖新日期结果」，也不会把取消误报成错误；
 * - 「进入加载中」的状态在事件处理器里设置（而不是在 effect 内同步 setState），
 *   effect 只负责发起请求与收尾，避免级联渲染。
 */

import { useEffect, useState } from 'react'
import './App.css'
import { listJournals } from './api/journals'
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
  // 失败后点击「重试」时自增，作为 effect 的依赖重新触发请求。
  const [reloadToken, setReloadToken] = useState(0)

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

  const isFiltering = filterDate !== ''

  return (
    <main className="app">
      <header className="app-header">
        <h1>SeekJournal</h1>
        <p className="app-subtitle">查看你的 Journal 记录</p>
      </header>

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

      {status === 'loading' && (
        <p className="app-state" role="status">
          加载中……
        </p>
      )}

      {status === 'error' && (
        <div className="app-state app-state-error" role="alert">
          <p>加载失败：{errorMessage}</p>
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
        <JournalList journals={journals} />
      )}
    </main>
  )
}

export default App
