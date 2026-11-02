/**
 * 首页 / 今日（Stage 4 / S04-T05，UI 调整第一轮改版）。
 *
 * 产品边界（`docs/stage4.md` §4）：
 * - 按当前**业务日期**展示今天的入口，业务日期由服务端按 Asia/Shanghai 04:00 计算，
 *   前端不拿浏览器本地日期替代；
 * - 「速记 / 计划 / 复盘」只是入口：**打开页面不创建任何文件**，
 *   当天已有记录时进入的是同一份记录（同业务日 Ritual 唯一约束不被突破）；
 * - 首页是入口集合，不自动生成「今日汇总」或其他文件；
 * - 重新读取只重新 GET，不产生写入。
 *
 * 因此本组件是一个**纯展示组件**：不收发 HTTP，数据与状态由 `useTodayOverview`
 * 与 `App.tsx` 传入，所有会写库的动作只能来自用户点击并交回上层回调。
 *
 * 视觉（用户提供的参考图 3）：大面积留白、内容居中、白色背景；
 * 上方醒目的「速记」入口，下方一块蓝色渐变主卡片，卡内左「计划」右「复盘」，
 * 两者是白色按钮；当天没有有效计划时「复盘」为浅白禁用态并给出简短原因。
 */

import './DashboardPage.css'

/** Ritual 类型：原样对应 `journal_kind=set|end`，仅内部使用，界面不显示英文缩写。 */
export type DashboardRitualKind = 'set' | 'end'

/** 今日普通速记文件（`journal_kind=writing` 的列表项字段子集）。 */
export type DashboardWritingItem = {
  id: number
  title: string
  preview: string
  revision: number
  /** 服务端返回的更新时间，可缺省。 */
  updatedAt?: string | null
}

/**
 * 某一种 Ritual 的今日状态。
 *
 * `absent` 表示今天还没有有效文件——此时**不得**为了展示而创建草稿；
 * 用户点「计划 / 复盘」后由上层的 Ritual 页面决定是否落库（首次有效正文才创建）。
 */
export type DashboardRitualSlot =
  | { state: 'absent' }
  | { state: 'exists'; id: number; title: string; revision: number; preview?: string }

/** 上层按 `GET /api/business-day`、`GET /api/journals`、`GET /api/rituals` 组装的数据。 */
export type DashboardToday = {
  /** 业务日期 `YYYY-MM-DD`，由服务端按 Asia/Shanghai 04:00 换日计算。 */
  businessDate: string
  timezone: string
  dayStartHour: number
  writings: DashboardWritingItem[]
  rituals: { set: DashboardRitualSlot; end: DashboardRitualSlot }
}

export type DashboardStatus = 'loading' | 'success' | 'error'

export type DashboardPageProps = {
  /** 读取状态；`error` 时必须提供可读的 `error` 文案。 */
  status: DashboardStatus
  /** 读取成功时的今日数据；未读取完成或失败时为 null。 */
  today: DashboardToday | null
  /** 失败原因（已由上层转成用户可读文案，不回显正文）。 */
  error?: string
  /** 上层写入锁（自动保存中 / AI 处理中）时禁用所有入口。 */
  disabled?: boolean
  /** 失败后重试读取；只重新 GET，不创建任何文件。 */
  onRetry: () => void
  /** 速记入口：进入今天的速记（复用已有草稿/记录，不新建空记录）。 */
  onQuickNote: () => void
  /** 计划入口：进入今天的计划；今天已有计划时进入的是同一份记录。 */
  onOpenPlan: () => void
  /** 复盘入口：进入今天的复盘；今天已有复盘时继续同一份记录。 */
  onOpenReview: () => void
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 把 `YYYY-MM-DD` 业务日期格式化为「2026年10月30日 周五」。
 *
 * 业务日期本身已经是服务端算好的日历日期，这里**不做时区换算**：
 * 只按字符串取年月日，再用本机构造 `Date` 取星期几（只取星期，不参与日期计算），
 * 避免 `new Date('YYYY-MM-DD')` 被解析成 UTC 午夜而在东八区偏一天。
 * 非法输入原样返回，保证界面不会因为脏数据崩溃。
 */
function formatBusinessDate(value: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (matched === null) return value
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime()) || date.getDate() !== day || date.getMonth() !== month - 1) {
    return value
  }
  return `${year}年${month}月${day}日 ${WEEKDAYS[date.getDay()]}`
}

/** 速记入口右侧的铅笔图标（内联 SVG，不引入图标库）。 */
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.2 19.9l4.3-1 9.2-9.2a2.1 2.1 0 0 0 0-3l-.4-.4a2.1 2.1 0 0 0-3 0l-9.2 9.2-1 4.4z" />
      <path d="M14.2 7.1l2.8 2.8" />
    </svg>
  )
}

/** 卡片内的一句状态说明：既是可见原因，也是禁用按钮的 `aria-describedby` 目标。 */
function ritualNote(setExists: boolean, endExists: boolean): string {
  if (endExists) return '今天已经复盘过了，可以随时回来继续。'
  if (setExists) return '计划已记录，今晚可以回来复盘。'
  return '今天还没有计划，完成计划后即可复盘。'
}

function DashboardPage({
  status,
  today,
  error,
  disabled = false,
  onRetry,
  onQuickNote,
  onOpenPlan,
  onOpenReview,
}: DashboardPageProps) {
  const view = today
  const writingsCount = view === null ? 0 : view.writings.length
  const setExists = view !== null && view.rituals.set.state === 'exists'
  const endExists = view !== null && view.rituals.end.state === 'exists'

  /*
   * 「先计划后复盘」在本轮只作用于首页入口：没有有效计划时复盘按钮为禁用。
   * 例外是今天已经存在复盘记录——历史复盘（含从回收箱恢复的）必须仍然可读可继续，
   * 否则等于用入口禁用删掉了已有内容的访问路径。此处不涉及后端强制限制。
   */
  const reviewAllowed = setExists || endExists
  const note = ritualNote(setExists, endExists)

  const dateLabel = view === null ? '今天' : formatBusinessDate(view.businessDate)
  const shiftLabel = view === null
    ? ''
    : `${view.timezone} · 每日 ${String(view.dayStartHour).padStart(2, '0')}:00 换日`

  return (
    <div className="dash">
      <div className="dash-stack">
        <button type="button" className="dash-quick" disabled={disabled} onClick={onQuickNote}>
          <span className="dash-quick-text">
            <span className="dash-quick-label">速记</span>
            <span className="dash-quick-hint">写下此刻的想法</span>
          </span>
          <span className="dash-quick-icon" aria-hidden="true"><PencilIcon /></span>
        </button>

        {status === 'loading' && (
          <section className="dash-hero dash-hero--loading" aria-busy="true" aria-live="polite">
            <p className="dash-hero-status">正在读取今天的记录……</p>
            <ul className="dash-skeleton" aria-hidden="true">
              <li className="dash-skeleton-row" />
              <li className="dash-skeleton-row" />
              <li className="dash-skeleton-row dash-skeleton-row--short" />
            </ul>
          </section>
        )}

        {status === 'error' && (
          <section className="dash-hero dash-hero--error" role="alert">
            <p className="dash-hero-eyebrow">今天的记录</p>
            <h1 className="dash-hero-title">暂时读不到今天的状态</h1>
            <p className="dash-hero-sub">
              {error !== undefined && error.trim() !== '' ? error : '读取今天的记录失败，请稍后重试。'}
            </p>
            <p className="dash-hero-note">重新读取只会再次查询，不会创建任何文件。</p>
            <div className="dash-actions">
              <button type="button" className="dash-action dash-action--solo" onClick={onRetry}>
                重新读取
              </button>
            </div>
          </section>
        )}

        {status === 'success' && view === null && (
          <section className="dash-hero dash-hero--error" role="alert">
            <p className="dash-hero-eyebrow">今天的记录</p>
            <h1 className="dash-hero-title">今天的数据不完整</h1>
            <p className="dash-hero-sub">服务端返回的今日数据不完整，暂时无法给出计划与复盘入口。</p>
            <p className="dash-hero-note">重新读取只会再次查询，不会创建任何文件。</p>
            <div className="dash-actions">
              <button type="button" className="dash-action dash-action--solo" onClick={onRetry}>
                重新读取
              </button>
            </div>
          </section>
        )}

        {status === 'success' && view !== null && (
          <>
            <section className="dash-hero" aria-labelledby="dash-hero-title">
              <p className="dash-hero-eyebrow">{dateLabel}</p>
              <h1 className="dash-hero-title" id="dash-hero-title">先计划，再复盘</h1>
              <p className="dash-hero-sub">用几句话写下今天想完成的事，晚上再回来收个尾。</p>

              <div className="dash-actions">
                <button type="button" className="dash-action" disabled={disabled} onClick={onOpenPlan}>
                  计划
                </button>
                <button
                  type="button"
                  className="dash-action dash-action--muted"
                  disabled={disabled || !reviewAllowed}
                  aria-describedby="dash-hero-note"
                  onClick={onOpenReview}
                >
                  复盘
                </button>
              </div>

              <p className="dash-hero-note" id="dash-hero-note">{note}</p>
            </section>

            <p className="dash-meta">
              {shiftLabel}
              <span className="dash-meta-sep" aria-hidden="true">·</span>
              {writingsCount === 0 ? '今天还没有速记' : `今天 ${writingsCount} 篇速记`}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export default DashboardPage
