import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TrashApiError,
  getTrashItem,
  listTrash,
  purgeTrashItem,
  restoreTrashItem,
} from '../api/trash'
import FileCard from '../components/FileCard'
import WritingContent from '../components/WritingContent'
import Pagination from '../components/Pagination'
import type { TrashFilter, TrashItem, TrashPageData, TrashType } from '../types/trash'
import { nearestValidPage } from '../utils/pagination'
import { formatServerTimestamp } from '../utils/journalDetail'
import {
  TRASH_PURGE_CONFIRM_MESSAGE,
  TRASH_TARGET_GONE_MESSAGE,
  trashActionDoneMessage,
  trashWriteFailureMessage,
  type TrashAction,
  type TrashFailureFeedback,
} from '../utils/trashFeedback'

interface TrashPageProps {
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onResolveLink: (title: string) => void
  onNavigate: (action: () => void) => void
}

type TrashPanelShape = { kind: 'list' } | { kind: 'detail'; type: TrashType; id: number; key: number }

const TYPE_LABELS: Record<TrashType, string> = { journal: 'Journal', insight: 'Insight' }
const FILTER_LABELS: { id: TrashFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'journal', label: 'Journal' },
  { id: 'insight', label: 'Insight' },
]

function emptyMessage(filter: TrashFilter): string {
  return filter === 'all' ? '回收箱是空的。' : '回收箱中没有该类型的记录。'
}

/**
 * Trash 详情（Stage 2 / S2-T10 → Stage 4 / S04-T11）。
 *
 * - 组件按 `type:id:key` 重挂载，每次打开真实读取已删除详情；
 * - **只读**：不挂编辑器变更回调、不发 PATCH，因此不可能改写已删除正文；
 * - 正文优先消费 T01 契约的 `content_doc`（统一只读编辑器），
 *   legacy 记录**不做自动转换**（转换必须由用户回到编辑页显式发起），
 *   原文用既有安全 Markdown 兜底呈现；
 * - 恢复/永久删除都使用服务器响应；写失败保留记录与详情；
 * - 404 表示目标已被其他操作恢复或删除，不谎报本次动作成功；
 * - 409 按 `code` 区分语义：`ritual_slot_conflict`（名额冲突，替换恢复待 T04）
 *   与 `related_files_changed`（关联文件变化）**不冒充**成「重读再试」；
 * - 永久删除取消/关闭确认框时不发任何请求。
 */
function TrashDetail({ trashType, trashId, onBusyChange, onClose, onActionDone, onTargetGone, onResolveLink }: {
  trashType: TrashType
  trashId: number
  onBusyChange: (busy: boolean) => void
  onClose: () => void
  onActionDone: (action: TrashAction, item: TrashItem) => void
  onResolveLink: (title: string) => void
  onTargetGone: () => void
}) {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [item, setItem] = useState<TrashItem | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const [restoreStage, setRestoreStage] = useState<'idle' | 'restoring'>('idle')
  const [purgeStage, setPurgeStage] = useState<'idle' | 'confirming' | 'deleting'>('idle')
  const [writeFailure, setWriteFailure] = useState<TrashFailureFeedback | null>(null)
  const writing = useRef(false)

  /** 写入失败：交给纯逻辑按 `code`/`status` 分类，再决定是否重读详情。 */
  const reportFailure = useCallback((action: TrashAction, error: unknown) => {
    const failure = trashWriteFailureMessage(action, {
      status: error instanceof TrashApiError ? error.status : undefined,
      code: error instanceof TrashApiError ? error.code : undefined,
      message: error instanceof Error ? error.message : undefined,
    })
    setWriteFailure(failure)
    if (failure.reread) setReloadToken((value) => value + 1)
  }, [])

  /** 目标消失（404）：清除过期详情、通知父级重读列表，但不声称动作成功。 */
  const handleGone = useCallback(() => {
    setItem(null)
    setNotFound(true)
    setStatus('error')
    setRestoreStage('idle')
    setPurgeStage('idle')
    onTargetGone()
  }, [onTargetGone])

  useEffect(() => {
    const controller = new AbortController()
    getTrashItem(trashType, trashId, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      setItem(data)
      setStatus('success')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (error instanceof TrashApiError && error.status === 404) {
        handleGone()
        return
      }
      setItem(null)
      setNotFound(false)
      setLoadError(error instanceof Error ? error.message : '读取失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [trashType, trashId, reloadToken, handleGone])

  const busy = restoreStage === 'restoring' || purgeStage === 'deleting'


  async function confirmRestore() {
    if (writing.current || item === null) return
    writing.current = true
    onBusyChange(true)
    setRestoreStage('restoring')
    setWriteFailure(null)
    try {
      // Stage 3 / T01 契约：恢复必须携带当前版本，缺版本 428、旧版本 409。
      const restored = await restoreTrashItem(trashType, trashId, item.revision)
      onActionDone('restore', restored)
    } catch (error: unknown) {
      setRestoreStage('idle')
      if (error instanceof TrashApiError && error.status === 404) {
        handleGone()
      } else {
        // 409 的不同 code（名额冲突 / 关联变化 / 版本过期）由纯逻辑分别措辞。
        reportFailure('restore', error)
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  async function confirmPurge() {
    if (writing.current || item === null) return
    writing.current = true
    onBusyChange(true)
    setPurgeStage('deleting')
    setWriteFailure(null)
    try {
      // Stage 3 / T01 契约：永久删除同样必须携带当前版本。
      await purgeTrashItem(trashType, trashId, item.revision)
      onActionDone('purge', item)
    } catch (error: unknown) {
      setPurgeStage('idle')
      if (error instanceof TrashApiError && error.status === 404) {
        handleGone()
      } else {
        reportFailure('purge', error)
      }
    } finally {
      writing.current = false
      onBusyChange(false)
    }
  }

  function retry() {
    setStatus('loading')
    setItem(null)
    setNotFound(false)
    setLoadError('')
    setWriteFailure(null)
    setRestoreStage('idle')
    setPurgeStage('idle')
    setReloadToken((value) => value + 1)
  }

  /**
   * 正文渲染口径：有 `content_doc`（T01 契约的权威正文）就用统一只读编辑器；
   * 为 `null` 说明是 legacy 记录，只呈现服务器投影的原文，**不自动转换**。
   */
  const itemDocument = item?.content_doc ?? null

  return (
    <section className="journal-detail" aria-label="回收箱详情">
      <div className="detail-header">
        <h2>回收箱详情（{TYPE_LABELS[trashType]}）</h2>
        <button type="button" onClick={onClose} disabled={busy}>返回列表</button>
      </div>
      {status === 'loading' && <p className="detail-state" role="status">正在读取详情……</p>}
      {status === 'error' && (
        <div className="detail-state detail-state-error" role="alert">
          <p>{notFound
            ? `该记录不在回收箱中（${TYPE_LABELS[trashType]} id ${trashId}），可能已被恢复或永久删除。`
            : `读取详情失败：${loadError}`}</p>
          <button type="button" disabled={busy} onClick={retry}>重新读取</button>
        </div>
      )}
      {status === 'success' && item && (
        <>
          <h3 className="detail-title">{item.display_title}</h3>
          <dl className="detail-meta">
            <div className="detail-meta-row"><dt>id</dt><dd>{item.id}</dd></div>
            {item.type === 'journal' && (
              <div className="detail-meta-row"><dt>日期</dt><dd>{item.journal_date}</dd></div>
            )}
            <div className="detail-meta-row"><dt>所属 Folder</dt>
              <dd>{item.folder_id === null ? '无' : `#${item.folder_id}`}</dd></div>
            <div className="detail-meta-row"><dt>创建时间</dt><dd>{formatServerTimestamp(item.created_at)}</dd></div>
            <div className="detail-meta-row"><dt>修改时间</dt><dd>{formatServerTimestamp(item.updated_at)}</dd></div>
            <div className="detail-meta-row"><dt>移入回收箱时间</dt><dd>{formatServerTimestamp(item.deleted_at ?? '')}</dd></div>
            <div className="detail-meta-row"><dt>正文格式</dt>
              <dd>{itemDocument === null ? '旧格式（原始文本，只读）' : '富文本（schema 1）'}</dd></div>
          </dl>
          {/* 只读展示（Stage 4 / T11）：优先 `content_doc`；
              legacy 时用原文兜底，Journal 的旧 blocks 仅在无 JSON 时参与呈现。
              两条路径都不写回数据，也不执行正文 HTML。 */}
          {itemDocument === null
            ? (
              <WritingContent
                blocks={item.type === 'journal' ? item.content_blocks : null}
                content={item.content} onLink={onResolveLink} disabled={busy} />
            )
            : <WritingContent doc={itemDocument} content={item.content} onLink={onResolveLink} disabled={busy} />}
          {itemDocument === null && (
            <p className="detail-hint">
              这条记录的正文仍是旧格式：回收箱只读呈现原文，不做自动转换；恢复后可在编辑页显式使用「转换为富文本」。
            </p>
          )}
          <p className="detail-hint">回收箱中的记录只读，不能编辑或修改 Folder；恢复后回到原来的位置。</p>
          <div className="detail-actions">
            <button type="button" onClick={confirmRestore} disabled={busy}>
              {restoreStage === 'restoring' ? '恢复中……' : '恢复'}
            </button>
            {purgeStage === 'idle' && (
              <button type="button" className="detail-danger" disabled={busy}
                onClick={() => { setWriteFailure(null); setPurgeStage('confirming') }}>永久删除</button>
            )}
          </div>
          {purgeStage === 'confirming' && (
            <div className="detail-confirm">
              <p>{TRASH_PURGE_CONFIRM_MESSAGE}</p>
              <div className="detail-confirm-actions">
                <button type="button" className="detail-danger" onClick={confirmPurge} disabled={busy}>
                  确认永久删除
                </button>
                <button type="button" disabled={busy} onClick={() => setPurgeStage('idle')}>取消</button>
              </div>
            </div>
          )}
          {restoreStage === 'restoring' && <p className="detail-state" role="status">正在恢复……</p>}
          {writeFailure && (
            <p className="detail-error" role="alert">
              {writeFailure.message}
              {writeFailure.retriable ? '（记录仍在回收箱中，可稍后重试。）' : ''}
            </p>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Trash 页面（Stage 2 / S2-T10）。
 *
 * - 只显示 Journal / Insight（Inbox 硬删除，不进入回收箱）；
 * - 后端全局分页（20 条/页）；类型变化回第一页，越界回最近有效页；
 * - 卡片按 (type, id) 打开真实详情；恢复/永久删除成功后刷新列表；
 * - 写成功与列表刷新失败分开反馈；写入中禁止切换与重复动作。
 */
function TrashPage({ onDirtyChange, onBusyChange, onNavigate, onResolveLink }: TrashPageProps) {
  const [filter, setFilter] = useState<TrashFilter>('all')
  const [page, setPage] = useState(1)
  const [listResult, setListResult] = useState<TrashPageData | null>(null)
  const [listStatus, setListStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [listError, setListError] = useState('')
  const [listRevision, setListRevision] = useState(0)
  const [panel, setPanel] = useState<TrashPanelShape>({ kind: 'list' })
  const keyRef = useRef(0)
  const [notice, setNotice] = useState('')

  function nextKey() {
    keyRef.current += 1
    return keyRef.current
  }

  // 回收箱列表：条件（类型）与页码变化都经过 AbortController，迟到响应不覆盖当前状态。
  useEffect(() => {
    const controller = new AbortController()
    listTrash(filter, page, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setPage(validPage)
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
  }, [filter, page, listRevision])

  const beginListLoading = useCallback(() => {
    setListStatus('loading')
    setListError('')
    setListResult(null)
  }, [])
  const refreshList = useCallback(() => {
    beginListLoading()
    setListRevision((value) => value + 1)
  }, [beginListLoading])
  function showList() {
    onDirtyChange(false)
    setPanel({ kind: 'list' })
  }

  function changeFilter(value: TrashFilter) {
    if (value === filter) return
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      showList()
      beginListLoading()
      setFilter(value)
      setPage(1) // 类型变化回第一页
    })
  }
  function changePage(value: number) {
    onNavigate(() => {
      setNotice('')
      showList()
      beginListLoading()
      setPage(value)
    })
  }
  function openItem(target: { type: TrashType; id: number }) {
    onNavigate(() => {
      onDirtyChange(false)
      setNotice('')
      setPanel({ kind: 'detail', type: target.type, id: target.id, key: nextKey() })
    })
  }
  /** 动作成功：用服务器响应给出提示，回列表并刷新（刷新失败由列表区单独反馈）。 */
  function handleActionDone(action: TrashAction, done: TrashItem) {
    setNotice(trashActionDoneMessage(action, done.display_title))
    showList()
    refreshList()
  }
  /** 目标消失：提示状态变化并重读列表；详情停留在“不在回收箱”状态。 */
  const handleTargetGone = useCallback(() => {
    setNotice(TRASH_TARGET_GONE_MESSAGE)
    refreshList()
  }, [refreshList])

  return (
    <section className="trash-page" aria-label="回收箱模块">
      <section className="app-toolbar" aria-label="回收箱工具">
        <div className="trash-type-filter" role="group" aria-label="回收箱类型筛选">
          {FILTER_LABELS.map((item) => (
            <button key={item.id} type="button" aria-pressed={filter === item.id}
              disabled={listStatus === 'loading'} onClick={() => changeFilter(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <p className="detail-hint">只显示已删除的 Journal / Insight；Inbox 是永久删除，不会出现在回收箱。</p>
      </section>

      {notice && <p className="detail-success" role="status">{notice}</p>}

      {panel.kind === 'detail' && (
        <TrashDetail onResolveLink={onResolveLink} key={`${panel.type}:${panel.id}:${panel.key}`}
          trashType={panel.type} trashId={panel.id}
          onBusyChange={onBusyChange}
          onClose={() => onNavigate(() => { setNotice(''); showList() })}
          onActionDone={handleActionDone} onTargetGone={handleTargetGone} />
      )}

      <section className="journal-results" aria-label="回收箱列表">
        {listStatus === 'loading' && <p className="app-state" role="status">加载中……</p>}
        {listStatus === 'error' && (
          <div className="app-state app-state-error" role="alert">
            <p>回收箱列表加载失败：{listError}</p>
            <button type="button" onClick={refreshList}>重试</button>
          </div>
        )}
        {listStatus === 'success' && listResult && (
          <>
            {listResult.items.length === 0
              ? <p className="app-state">{emptyMessage(filter)}</p>
              : (
                <ul className="journal-list">
                  {listResult.items.map((item) => (
                    <li key={`${item.type}:${item.id}`}>
                      <FileCard file={item} onOpen={(file) => openItem({ type: file.type as TrashType, id: file.id })}
                        selected={false} />
                    </li>
                  ))}
                </ul>
              )}
            <Pagination page={listResult.page} total={listResult.total} hasNext={listResult.has_next}
              onPageChange={changePage} label="回收箱分页" />
          </>
        )}
      </section>
    </section>
  )
}

export default TrashPage
