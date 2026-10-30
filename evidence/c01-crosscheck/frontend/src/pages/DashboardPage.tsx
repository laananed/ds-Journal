/**
 * 今日概览（Stage 4 / S04-T05）。
 *
 * 产品边界（`docs/stage4.md` §4）：
 * - 按当前**业务日期**动态展示今天的普通写作、开始今天、结束今天；
 * - 「开始今天 / 结束今天」提供进入或继续入口，写作提供开始/继续入口；
 * - 概览是动态列表，**不自动创建**「今日汇总」文件、复盘或其他记录；
 * - 仅打开页面不得产生任何写入。
 *
 * 因此本组件是一个**纯展示组件**：
 * - 不收发 HTTP，不 import 任何 `api/*`，不在 `useEffect` 里读取数据；
 * - 数据（`today`）与状态（`status`）由上层接线者传入；
 * - 所有会写库的动作只能来自用户点击，并交回上层回调执行。
 * 这样「进入概览零创建」是由组件结构保证的，而不是靠调用顺序约定。
 *
 * 本轮不接线到 `App.tsx`（T02 正在改 App）。真实数据读取的验收门禁见
 * `docs/stage4-tasks.md` §3.6：等 T01 后端、隔离库与公共入口就绪后再验。
 */

import './DashboardPage.css'

/** Ritual 类型：原样对应 `journal_kind=set|end`，仅内部使用，界面不显示英文缩写。 */
export type DashboardRitualKind = 'set' | 'end'


/** 今日普通写作文件（`journal_kind=writing` 的列表项字段子集）。 */
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
 * 用户点「开始今天 / 结束今天」后由上层的创建流程决定是否落库。
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
  /** Writing 入口：进入今天的普通写作（首次进入打开未落库草稿）。 */
  onNewWriting: () => void
  /** 打开今天已有的某篇普通写作。 */
  onOpenWriting: (id: number) => void
  /** 今天还没有该 Ritual：进入创建流程（是否落库由上层决定）。 */
  onStartRitual: (kind: DashboardRitualKind) => void
  /** 今天已有该 Ritual：打开继续编辑。 */
  onOpenRitual: (kind: DashboardRitualKind, id: number) => void
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

/** 标题为空时的兜底显示，不伪造内容。 */
function displayTitle(title: string): string {
  const trimmed = title.trim()
  return trimmed === '' ? '（无标题）' : trimmed
}

function DashboardPage({
  status,
  today,
  error,
  disabled = false,
  onRetry,
  onNewWriting,
  onOpenWriting,
  onStartRitual,
  onOpenRitual,
}: DashboardPageProps) {
  const writings = today === null ? [] : today.writings
  const setSlot: DashboardRitualSlot = today === null ? { state: 'absent' } : today.rituals.set
  const endSlot: DashboardRitualSlot = today === null ? { state: 'absent' } : today.rituals.end
  const allEmpty = writings.length === 0 && setSlot.state === 'absent' && endSlot.state === 'absent'

  return (
    <div className="dash">
      <header className="dash-head">
        <p className="dash-eyebrow">今日概览</p>
        <h2 className="dash-title">{today === null ? '今天' : formatBusinessDate(today.businessDate)}</h2>
        <p className="dash-sub">
          {today === null
            ? '按服务端业务日期读取今天的记录'
            : `${today.timezone} · 每日 ${String(today.dayStartHour).padStart(2, '0')}:00 换日`}
        </p>
      </header>

      {status === 'loading' && (
        <section className="dash-panel dash-loading" role="status" aria-live="polite">
          <p className="dash-loading-text">正在读取今天的记录……</p>
          <ul className="dash-skeleton" aria-hidden="true">
            <li className="dash-skeleton-row" />
            <li className="dash-skeleton-row" />
            <li className="dash-skeleton-row" />
          </ul>
        </section>
      )}

      {status === 'error' && (
        <section className="dash-panel dash-error" role="alert">
          <p className="dash-error-text">{error && error.trim() !== '' ? error : '今天的记录加载失败，请稍后重试。'}</p>
          <p className="dash-error-hint">概览只读取数据，重试不会创建任何文件。</p>
          <button type="button" className="dash-button dash-button--primary" onClick={onRetry}>
            重新读取
          </button>
        </section>
      )}

      {status === 'success' && (
        <>
          {allEmpty && (
            <p className="dash-empty-all">
              今天还没有任何记录。可以从写作或开始今天开始，概览本身不会生成汇总文件。
            </p>
          )}

          <div className="dash-cards">
            <section className="dash-card" aria-labelledby="dash-writing-heading">
              <div className="dash-card-head">
                <h3 className="dash-card-title" id="dash-writing-heading">写作</h3>
                <p className="dash-card-meta">
                  {writings.length === 0 ? '今天还没有写作' : `今天 ${writings.length} 篇`}
                </p>
              </div>
              <p className="dash-card-desc">普通日记，不限篇数；写作入口默认打开今天的草稿。</p>

              {writings.length === 0 ? (
                <p className="dash-card-empty">今天还没有写作记录。</p>
              ) : (
                <ul className="dash-list">
                  {writings.map((item) => (
                    <li className="dash-list-item" key={item.id}>
                      <button
                        type="button"
                        className="dash-list-open"
                        disabled={disabled}
                        onClick={() => onOpenWriting(item.id)}
                      >
                        <span className="dash-list-title">{displayTitle(item.title)}</span>
                        {item.preview.trim() !== '' && (
                          <span className="dash-list-preview">{item.preview}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div className="dash-card-actions">
                <button
                  type="button"
                  className="dash-button dash-button--primary"
                  disabled={disabled}
                  onClick={onNewWriting}
                >
                  开始写作
                </button>
              </div>
            </section>

            <section className="dash-card" aria-labelledby="dash-set-heading">
              <div className="dash-card-head">
                <h3 className="dash-card-title" id="dash-set-heading">开始今天</h3>
                <p className="dash-card-meta">
                  {setSlot.state === 'exists' ? `今天已有记录 · ${displayTitle(setSlot.title)}` : '今天还没有开始今天'}
                </p>
              </div>
              <p className="dash-card-desc">日初 Ritual：写下今天想完成的目标，并可以从这里进入正文。</p>
              {setSlot.state === 'exists' && setSlot.preview !== undefined && setSlot.preview.trim() !== '' && (
                <p className="dash-card-preview">{setSlot.preview}</p>
              )}
              <div className="dash-card-actions">
                {setSlot.state === 'exists' ? (
                  <button
                    type="button"
                    className="dash-button dash-button--primary"
                    disabled={disabled}
                    onClick={() => onOpenRitual('set', setSlot.id)}
                  >
                    继续开始今天
                  </button>
                ) : (
                  <button
                    type="button"
                    className="dash-button dash-button--primary"
                    disabled={disabled}
                    onClick={() => onStartRitual('set')}
                  >
                    开始今天
                  </button>
                )}
              </div>
            </section>

            <section className="dash-card" aria-labelledby="dash-end-heading">
              <div className="dash-card-head">
                <h3 className="dash-card-title" id="dash-end-heading">结束今天</h3>
                <p className="dash-card-meta">
                  {endSlot.state === 'exists' ? `今天已有记录 · ${displayTitle(endSlot.title)}` : '今天还没有结束今天'}
                </p>
              </div>
              <p className="dash-card-desc">日终 Ritual：回顾今天的目标与感受，已有记录可继续编辑。</p>
              {endSlot.state === 'exists' && endSlot.preview !== undefined && endSlot.preview.trim() !== '' && (
                <p className="dash-card-preview">{endSlot.preview}</p>
              )}
              <div className="dash-card-actions">
                {endSlot.state === 'exists' ? (
                  <button
                    type="button"
                    className="dash-button dash-button--primary"
                    disabled={disabled}
                    onClick={() => onOpenRitual('end', endSlot.id)}
                  >
                    继续结束今天
                  </button>
                ) : (
                  <button
                    type="button"
                    className="dash-button dash-button--primary"
                    disabled={disabled}
                    onClick={() => onStartRitual('end')}
                  >
                    结束今天
                  </button>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}

export default DashboardPage
