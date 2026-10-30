/**
 * 今日总览的读取接线（Stage 4 / S04-T06）。
 *
 * 产品边界（`docs/stage4.md` §4）：总览是按当前**业务日期**动态读取的列表，
 * 不生成“今日汇总”、不生成复盘、不创建任何文件。
 *
 * 因此这里只有三个 GET：
 * 1. `GET /api/business-day` —— 服务端按 Asia/Shanghai 04:00 算出业务日期；
 * 2. `GET /api/journals?journal_date=…&journal_kind=all` —— 当日全部 Journal，
 *    由 `buildTodayOverview` 过滤出 `writing`；
 * 3. `GET /api/rituals?journal_date=…` —— 今日两种 Ritual 的状态（缺失零创建）。
 *
 * 返回值与 T05 `DashboardPage` 的 props 结构一致，接线由协调者在 `App.tsx` 完成；
 * 本 hook 不写会话、不发写请求，读取失败只影响 `status`/`error`。
 */

import { useCallback, useEffect, useState } from 'react'
import { listJournals } from '../api/journals'
import { getBusinessDay, getRituals } from '../api/rituals'
import { buildTodayOverview, writingDateFromBusinessDay, type TodayOverviewView } from '../utils/writingSession'

export interface TodayOverviewState {
  status: 'loading' | 'success' | 'error'
  /** 读取成功时的总览数据；失败或加载中为 null。 */
  today: TodayOverviewView | null
  /** 用户可读的失败原因（不回显正文）。 */
  error: string
  /** 重新读取：只重新 GET，不创建、不修改任何数据。 */
  reload: () => void
}

export function useTodayOverview(): TodayOverviewState {
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading')
  const [today, setToday] = useState<TodayOverviewView | null>(null)
  const [error, setError] = useState('')
  const [token, setToken] = useState(0)

  const reload = useCallback(() => {
    setStatus('loading')
    setError('')
    setToken((value) => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const businessDay = await getBusinessDay(controller.signal)
        const businessDate = writingDateFromBusinessDay(businessDay)
        if (businessDate === '') throw new Error('服务端返回的业务日期不合法，暂时无法读取今日总览。')
        const [writings, rituals] = await Promise.all([
          listJournals(businessDate, 1, controller.signal, 'all'),
          getRituals(businessDate, controller.signal),
        ])
        if (controller.signal.aborted) return
        const view = buildTodayOverview({ businessDay, writings, rituals })
        if (view === null) throw new Error('今日总览数据不完整，请稍后重试。')
        setToday(view)
        setStatus('success')
      } catch (cause: unknown) {
        if (controller.signal.aborted) return
        setToday(null)
        setError(cause instanceof Error && cause.message !== ''
          ? cause.message
          : '读取今天的记录失败，请稍后重试。')
        setStatus('error')
      }
    })()
    return () => controller.abort()
  }, [token])

  return { status, today, error, reload }
}
