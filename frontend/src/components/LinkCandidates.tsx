import { useEffect, useRef, useState } from 'react'
import { LinkApiError, readLinkTarget, resolveLinks } from '../api/links'
import type { FileIdentity } from '../types/file'
import type { LinkPage } from '../types/link'
import { nearestValidPage } from '../utils/pagination'
import Pagination from './Pagination'

interface Props {
  title: string
  disabled: boolean
  onOpen: (file: FileIdentity) => void
  onClose: () => void
}
const labels = { journal: 'Journal', inbox: 'Inbox', insight: 'Insight' }

function LinkCandidates({ title, disabled, onOpen, onClose }: Props) {
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<LinkPage | null>(null)
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState(false)
  const request = useRef<AbortController | null>(null)
  const autoOpen = useRef(true)
  const openCallback = useRef(onOpen)
  useEffect(() => { openCallback.current = onOpen }, [onOpen])

  function refresh() {
    request.current?.abort()
    setResult(null)
    setStatus('loading')
    setOpening(false)
    setError('')
    setRevision(value => value + 1)
  }
  async function readTarget(file: FileIdentity, controller: AbortController) {
    setOpening(true)
    try {
      await readLinkTarget(file, controller.signal)
      if (!controller.signal.aborted) openCallback.current(file)
    } catch (failure) {
      if (controller.signal.aborted) return
      if (failure instanceof LinkApiError && failure.status === 404) {
        autoOpen.current = false
        setNotice('该目标已不存在或已移入回收箱，候选已重新查询。')
        refresh()
      } else {
        setError(failure instanceof Error ? failure.message : '打开失败，请重试')
        setStatus('error')
        setResult(null)
      }
    } finally {
      if (!controller.signal.aborted) setOpening(false)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    resolveLinks(title, page, controller.signal).then(async data => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setPage(validPage)
        return
      }
      setResult(data)
      setStatus('success')
      if (autoOpen.current && data.total === 1 && data.items[0]) await readTarget(data.items[0], controller)
    }).catch(failure => {
      if (controller.signal.aborted) return
      setError(failure instanceof Error ? failure.message : '解析失败，请重试')
      setStatus('error')
      setResult(null)
    })
    return () => controller.abort()
  }, [title, page, revision])

  function choose(file: FileIdentity) {
    // A read failure must leave the source draft and Dirty flag untouched.
    // Only the successful onOpen callback asks App to leave the source.
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    void readTarget(file, controller)
  }
  // Also cancel a candidate-detail request created after the effect began.
  useEffect(() => () => request.current?.abort(), [])

  return <section className="link-candidates" aria-label="内部链接候选">
    <h2>链接：{title}</h2>
    <button type="button" onClick={onClose} disabled={disabled}>关闭链接候选</button>
    {notice && <p role="status">{notice}</p>}
    {status === 'loading' && <p role="status">正在解析链接……</p>}
    {opening && <p role="status">正在打开目标……</p>}
    {status === 'error' && <div role="alert"><p>{error}</p>
      <button type="button" onClick={refresh} disabled={disabled}>重试链接</button></div>}
    {status === 'success' && result && <>
      {result.total === 0 ? <p role="status">找不到目标：{title}</p> : <ul>
        {result.items.map(item => <li key={`${item.type}:${item.id}`}>
          <button type="button" disabled={disabled || opening} onClick={() => choose(item)}>
            {labels[item.type]}：{item.display_title} · {item.journal_date ?? new Date(item.created_at).toLocaleString()}
          </button>
        </li>)}
      </ul>}
      {result.total > 1 && <Pagination page={result.page} total={result.total} hasNext={result.has_next}
        disabled={disabled || opening} label="链接候选分页" onPageChange={value => {
          setResult(null); setStatus('loading'); setPage(value)
        }} />}
    </>}
  </section>
}
export default LinkCandidates
