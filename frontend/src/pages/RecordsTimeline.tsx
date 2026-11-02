import { useEffect, useMemo, useState } from 'react'
import './RecordsTimeline.css'
import { listJournals } from '../api/journals'
import { defaultJournalDate } from '../utils/journalDate'
import { nearestValidPage } from '../utils/pagination'
import {
  dateInRange,
  formatAbsoluteGroupLabel,
  groupJournalsByDate,
  kindLabel,
  kindModifier,
  rangeForPeriod,
  summarizeContent,
  type JournalDateGroup,
  type RecordsPeriod,
} from '../utils/recordsTimeline'
import type { Journal } from '../types/journal'

/**
 * 「记录」时间线（UI 调整第三轮）。
 *
 * 参考图 8：顶部「日 / 周 / 月 / 年」切换；左侧细时间线 + 日期节点；
 * 同一天的记录是宽松、圆角的灰色卡片，带「计划 / 复盘 / 速记」标识；
 * 点击卡片通过 `onOpenJournal` 交给既有导航机制打开真实记录。
 *
 * 边界（本次用户指令 / `docs/stage4-tasks.md` 契约）：
 * - 组件只读：只调 `GET /api/journals`，不创建、不保存、不复制另一套保存系统；
 * - 类型标识只用服务端 `journal_kind` 字段，不从标题推断；同一篇一条卡片，
 *   同一天多篇速记各自独立显示，不合并、不改写；
 * - 分组只用服务器返回的 `journal_date` 字符串，不做浏览器时区换算；
 * - 日 / 周 / 月 / 年当前都只是按日期筛选展示，**没有** AI 周报 / 月报 / 年报，
 *   界面不出现任何暗示锁定的 AI 报告元素；
 * - 正式导航接线由整合者完成：本组件未接入 `App.tsx` 前，不算正式导航完成。
 *
 * 分页限制（已记录，待 Codex 评估）：`GET /api/journals` 只支持
 * `journal_date` 精确筛选 + 固定 20 条分页（`docs/stage2-api.md`），没有范围查询。
 * 「日」视图按页连续展示全部日期；「周 / 月 / 年」视图按页累积读取、前端按范围筛选，
 * 并明确显示「已加载 X / 共 Y 篇」，`has_next` 时提供「加载更多」继续取后续页，
 * 不把第一页冒充全部数据。
 */

export interface RecordsTimelineProps {
  /** 导航或编辑进行中时禁用卡片点击，与外壳的 `uiLocked` 口径一致。 */
  disabled?: boolean
  /** 点击卡片：交给宿主页面的既有导航机制打开真实记录。 */
  onOpenJournal: (id: number) => void
}

type LoadStatus = 'loading' | 'success' | 'error'

const PERIOD_TABS: ReadonlyArray<{ id: RecordsPeriod; label: string }> = [
  { id: 'day', label: '日' },
  { id: 'week', label: '周' },
  { id: 'month', label: '月' },
  { id: 'year', label: '年' },
]

function RecordsTimeline({ disabled = false, onOpenJournal }: RecordsTimelineProps) {
  const [period, setPeriod] = useState<RecordsPeriod>('day')
  const [refDate, setRefDate] = useState(() => defaultJournalDate())
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Journal[]>([])
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [errorMessage, setErrorMessage] = useState('')
  // 重试计数：只 bump 它触发重发，不改动其他状态。
  const [revision, setRevision] = useState(0)

  /** 切换粒度 / 参考日期：从头加载第 1 页。 */
  function changeRange(nextPeriod: RecordsPeriod, nextDate: string) {
    if (nextPeriod === period && nextDate === refDate) return
    setPeriod(nextPeriod)
    setRefDate(nextDate)
    setPage(1)
    setItems([])
    setTotal(0)
    setHasNext(false)
    setStatus('loading')
    setErrorMessage('')
  }

  useEffect(() => {
    const controller = new AbortController()
    // 真实分页不传日期：日视图连续展示，其他粒度在客户端按范围筛选。
    listJournals(undefined, page, controller.signal).then((data) => {
      if (controller.signal.aborted) return
      const validPage = nearestValidPage(data.page, data.total)
      if (validPage !== data.page) {
        setPage(validPage)
        return
      }
      setTotal(data.total)
      setHasNext(data.has_next)
      // 按页累积（dev StrictMode 双调用也用 id 去重）；第 1 页直接替换。
      setItems((prev) => {
        if (page === 1) return data.items
        const seen = new Set(prev.map((item) => `${item.type}:${item.id}`))
        return [...prev, ...data.items.filter((item) => !seen.has(`${item.type}:${item.id}`))]
      })
      setStatus('success')
      setErrorMessage('')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setErrorMessage(error instanceof Error ? error.message : '加载失败，请稍后重试')
      setStatus('error')
    })
    return () => controller.abort()
  }, [period, refDate, page, revision])

  const range = useMemo(() => rangeForPeriod(period, refDate), [period, refDate])
  const groups = useMemo<JournalDateGroup[]>(() => {
    const visible = period === 'day'
      ? items
      : items.filter((item) => dateInRange(item.journal_date, range))
    return groupJournalsByDate(visible)
  }, [items, period, range])

  const initialLoading = status === 'loading' && items.length === 0

  return (
    <section className="rt" aria-label="记录时间线">
      <div className="rt-switch" role="group" aria-label="时间粒度">
        {PERIOD_TABS.map((tab) => (
          <button key={tab.id} type="button" className="rt-switch-tab"
            aria-pressed={period === tab.id}
            disabled={disabled}
            onClick={() => changeRange(tab.id, refDate)}>
            {tab.label}
          </button>
        ))}
      </div>

      {initialLoading && (
        <p className="rt-state" role="status">加载中……</p>
      )}

      {status === 'error' && (
        <div className="rt-state rt-state-error" role="alert">
          <p>记录加载失败：{errorMessage}</p>
          <button type="button" disabled={disabled} onClick={() => {
            setStatus('loading')
            setRevision((value) => value + 1)
          }}>重试</button>
        </div>
      )}

      {status === 'success' && groups.length === 0 && (
        <p className="rt-state">这个范围还没有记录。</p>
      )}

      {groups.length > 0 && (
        <ol className="rt-groups">
          {groups.map((group) => (
            <li key={group.date} className="rt-group">
              <div className="rt-node">
                <span className="rt-dot" aria-hidden="true" />
                <h3 className="rt-date">{formatAbsoluteGroupLabel(group.date)}</h3>
              </div>
              <ul className="rt-cards">
                {group.items.map((item) => (
                  <li key={`${item.type}:${item.id}`}>
                    <button type="button" className="rt-card"
                      disabled={disabled}
                      aria-label={`打开${kindLabel(item.journal_kind)}：${summarizeContent(item.content, 40) || item.display_title}`}
                      onClick={() => onOpenJournal(item.id)}>
                      <span className="rt-card-summary">
                        {summarizeContent(item.content, 300) || item.display_title}
                      </span>
                      <span className={`rt-tag rt-tag--${kindModifier(item.journal_kind)}`}>
                        {kindLabel(item.journal_kind)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {status === 'success' && period !== 'day' && (
        <p className="rt-count" role="status">
          {hasNext ? `已加载 ${items.length} / 共 ${total} 篇，可继续加载更早的记录。` : `已加载全部 ${total} 篇。`}
        </p>
      )}
      {status === 'success' && period === 'day' && (
        <p className="rt-count" role="status">
          {hasNext ? `已加载 ${items.length} / 共 ${total} 篇，可继续加载更早的记录。` : `已加载全部 ${total} 篇。`}
        </p>
      )}

      {(hasNext || (status === 'loading' && items.length > 0)) && (
        <div className="rt-more">
          <button type="button" disabled={disabled || status === 'loading'}
            onClick={() => {
              setStatus('loading')
              setPage((value) => value + 1)
            }}>
            {status === 'loading' ? '正在加载……' : '加载更多'}
          </button>
        </div>
      )}
    </section>
  )
}

export default RecordsTimeline
