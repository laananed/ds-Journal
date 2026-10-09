import { useEffect, useRef, useState } from 'react'
import { getSearchTarget, SearchApiError, searchFiles } from '../api/search'
import FileCard from '../components/FileCard'
import Pagination from '../components/Pagination'
import type { FileIdentity } from '../types/file'
import type { SearchConditions, SearchFilter, SearchPageData } from '../types/search'
import { nearestValidPage } from '../utils/pagination'

interface SearchPageProps {
  conditions: SearchConditions
  onConditionsChange: (conditions: SearchConditions) => void
  onNavigate: (action: () => void) => void
  onOpenFile: (file: FileIdentity) => void
}

const FILTERS: { type: SearchFilter; label: string }[] = [
  { type: 'all', label: '全部' }, { type: 'journal', label: 'Journal' },
  { type: 'inbox', label: 'Inbox' }, { type: 'insight', label: 'Insight' },
]

function SearchPage({ conditions, onConditionsChange, onNavigate, onOpenFile }: SearchPageProps) {
  const [result, setResult] = useState<SearchPageData | null>(null)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState<FileIdentity | null>(null)
  const openController = useRef<AbortController | null>(null)
  const hasQuery = conditions.q.trim() !== ''

  useEffect(() => {
    if (!conditions.q.trim()) return
    const controller = new AbortController()
    searchFiles(conditions, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        onConditionsChange({ ...conditions, page: validPage })
        return
      }
      setResult(data)
      setStatus('success')
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return
      setResult(null)
      setError(failure instanceof Error ? failure.message : '搜索失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [conditions, revision, onConditionsChange])

  // Abort both late list responses and a clicked-target read on navigation or
  // condition changes. An old target must not navigate after the user leaves.
  useEffect(() => () => openController.current?.abort(), [conditions])

  function beginLoading() {
    setResult(null)
    setStatus('loading')
    setError('')
  }
  function changeConditions(next: SearchConditions) {
    openController.current?.abort()
    setOpening(null)
    setNotice('')
    beginLoading()
    onConditionsChange(next)
  }
  function refresh() {
    beginLoading()
    setRevision((value) => value + 1)
  }
  function openFile(file: FileIdentity) {
    onNavigate(() => {
      openController.current?.abort()
      const controller = new AbortController()
      openController.current = controller
      setOpening(file)
      setNotice('')
      getSearchTarget(file, controller.signal).then(() => {
        if (!controller.signal.aborted) onOpenFile(file)
      }).catch((failure: unknown) => {
        if (controller.signal.aborted) return
        if (failure instanceof SearchApiError && failure.status === 404) {
          setNotice('该记录已不存在或已移入回收箱，搜索结果已重新查询。')
          refresh()
        } else {
          setNotice(failure instanceof Error ? failure.message : '打开失败，请稍后重试')
        }
      }).finally(() => {
        if (!controller.signal.aborted) setOpening(null)
      })
    })
  }

  return (
    <section aria-label="搜索模块">
      <section className="app-toolbar" aria-label="搜索工具">
        <label className="app-filter"><span>关键词</span>
          <input type="search" value={conditions.q} placeholder="搜索标题和正文"
            onChange={(event) => changeConditions({ ...conditions, q: event.target.value, page: 1 })} />
        </label>
        <label className="app-filter"><span>文件类型</span>
          <select value={conditions.type}
            onChange={(event) => changeConditions({ ...conditions, type: event.target.value as SearchFilter, page: 1 })}>
            {FILTERS.map((filter) => <option key={filter.type} value={filter.type}>{filter.label}</option>)}
          </select>
        </label>
        <button type="button" disabled={!hasQuery} onClick={refresh}>重新搜索</button>
      </section>
      {notice && <p role="status" className="detail-state">{notice}</p>}
      {opening && <p role="status">正在打开记录……</p>}
      {!hasQuery && <p className="app-state">请输入关键词，搜索标题和正文。</p>}
      {hasQuery && status === 'loading' && <p className="app-state" role="status">正在搜索……</p>}
      {hasQuery && status === 'error' && (
        <div className="app-state app-state-error" role="alert">
          <p>{error}</p><button type="button" onClick={refresh}>重试</button>
        </div>
      )}
      {hasQuery && status === 'success' && result && (
        <>
          {result.items.length === 0 ? <p className="app-state">没有找到匹配的记录。</p> : (
            <ul className="journal-list" aria-label="搜索结果">
              {result.items.map((item) => <li key={`${item.type}:${item.id}`}>
                <FileCard file={item} onOpen={openFile} disabled={opening !== null} />
              </li>)}
            </ul>
          )}
          <Pagination page={result.page} total={result.total} hasNext={result.has_next}
            label="搜索分页" onPageChange={(page) => changeConditions({ ...conditions, page })} />
        </>
      )}
    </section>
  )
}
export default SearchPage
