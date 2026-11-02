/**
 * 「记录」时间线（UI 调整第三轮）的纯逻辑工具。
 *
 * 目标：把 `GET /api/journals` 返回的 Journal 列表按**服务端业务日期**
 * （`journal_date` 字符串）分组展示，不做任何时区换算。
 *
 * 日期语义约定：
 * - `journal_date` 一律是服务器返回的 `YYYY-MM-DD` 字符串；
 *   本模块只做字符串比较与展示格式化，**不**用 `Date` 解析它再取本地日期，
 *   避免浏览器时区把记录挪到错误的日期（`docs/stage1-api.md` 业务日期规则）；
 * - 「今天 / 昨天」的判断基准用既有 `defaultJournalDate()`（Stage 1 / Task 8.2：
 *   04:00 换日），与写作、计划、复盘共用同一套业务日期口径；
 * - 周 / 月 / 年范围只用于前端筛选展示。当前 API（`docs/stage2-api.md` §Journal）
 *   仅支持 `journal_date` 精确筛选与固定分页，没有范围查询；
 *   范围外的取舍由 `RecordsTimeline` 组件用「分页累积 + 明确计数」处理。
 */

import type { Journal } from '../types/journal'
import type { JournalKind } from '../types/document'

/** 时间线的时间粒度。日 / 周 / 月 / 年当前都只是「按日期展示记录」，无 AI 报告。 */
export type RecordsPeriod = 'day' | 'week' | 'month' | 'year'

/** 含头含尾的闭区间，两端都是 `YYYY-MM-DD` 字符串。 */
export interface DateRange {
  start: string
  end: string
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

/** 校验并拆分 `YYYY-MM-DD`；不合法返回 null，调用方回退默认日期。 */
export function parseDateParts(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // 再用 Date 反向验证一次（例如 2 月 30 日会被归一化到 3 月，即不合法）
  const probe = new Date(year, month - 1, day)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return null
  }
  return { year, month, day }
}

/** `Date` 的本机年月日 → `YYYY-MM-DD`（与 `journalDate.ts` 同一口径）。 */
export function formatDateParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function partsToDate(value: string): Date {
  const parts = parseDateParts(value)
  if (parts === null) throw new Error(`invalid date: ${value}`)
  return new Date(parts.year, parts.month - 1, parts.day)
}

/**
 * 计算某个粒度下，参考日期所在区间（含头含尾）。
 *
 * - day：就是当天；
 * - week：周一到周日（中文语境习惯）；
 * - month：当月第一天到最后一天；
 * - year：当年 1 月 1 日到 12 月 31 日。
 */
export function rangeForPeriod(period: RecordsPeriod, refDate: string): DateRange {
  const parts = parseDateParts(refDate)
  if (parts === null) throw new Error(`invalid date: ${refDate}`)
  const { year, month, day } = parts
  if (period === 'day') return { start: refDate, end: refDate }
  if (period === 'month') {
    const lastDay = new Date(year, month, 0).getDate()
    return { start: formatDateParts(year, month, 1), end: formatDateParts(year, month, lastDay) }
  }
  if (period === 'year') {
    return { start: `${year}-01-01`, end: `${year}-12-31` }
  }
  // week：getDay() 0=周日；换算成周一偏移（周一为一周之首）
  const weekday = partsToDate(refDate).getDay()
  const mondayOffset = (weekday + 6) % 7
  const monday = new Date(year, month - 1, day - mondayOffset)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  return {
    start: formatDateParts(monday.getFullYear(), monday.getMonth() + 1, monday.getDate()),
    end: formatDateParts(sunday.getFullYear(), sunday.getMonth() + 1, sunday.getDate()),
  }
}

/** `journal_date` 是否落在区间内。ISO 字符串的字典序即时间序，可直接比较。 */
export function dateInRange(dateStr: string, range: DateRange): boolean {
  return dateStr >= range.start && dateStr <= range.end
}

/**
 * 把参考日期在某个粒度上移动 `delta` 步（-1 上一个、+1 下一个）。
 *
 * 月移动会把超出的日号截断到目标月最后一天（1 月 31 日 + 1 月 = 2 月 28/29 日）。
 */
export function shiftPeriod(period: RecordsPeriod, refDate: string, delta: number): string {
  const parts = parseDateParts(refDate)
  if (parts === null) throw new Error(`invalid date: ${refDate}`)
  const { year, month, day } = parts
  if (period === 'day') {
    const moved = new Date(year, month - 1, day + delta)
    return formatDateParts(moved.getFullYear(), moved.getMonth() + 1, moved.getDate())
  }
  if (period === 'week') {
    const moved = new Date(year, month - 1, day + delta * 7)
    return formatDateParts(moved.getFullYear(), moved.getMonth() + 1, moved.getDate())
  }
  if (period === 'year') {
    return formatDateParts(year + delta, month, day)
  }
  const moved = new Date(year, month - 1 + delta, 1)
  const lastDay = new Date(moved.getFullYear(), moved.getMonth() + 1, 0).getDate()
  return formatDateParts(moved.getFullYear(), moved.getMonth() + 1, Math.min(day, lastDay))
}

export interface JournalDateGroup {
  date: string
  items: Journal[]
}

/**
 * 按服务端 `journal_date` 字符串分组；组内保持服务器顺序（最新优先），
 * 组之间按日期字符串降序。**不**解析成 `Date`，不做时区换算。
 */
export function groupJournalsByDate(items: readonly Journal[]): JournalDateGroup[] {
  const byDate = new Map<string, Journal[]>()
  for (const item of items) {
    const bucket = byDate.get(item.journal_date)
    if (bucket === undefined) byDate.set(item.journal_date, [item])
    else bucket.push(item)
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, group]) => ({ date, items: group }))
}

/** 类型标识来自服务端 `journal_kind` 字段，不从标题推断；缺失时按服务器默认值 writing。 */
export function kindLabel(kind: JournalKind | undefined): '速记' | '计划' | '复盘' {
  if (kind === 'set') return '计划'
  if (kind === 'end') return '复盘'
  return '速记'
}

/** 类型对应的样式修饰符（BEM）。 */
export function kindModifier(kind: JournalKind | undefined): string {
  if (kind === 'set') return 'set'
  if (kind === 'end') return 'end'
  return 'writing'
}

/**
 * 日期节点的展示文案。
 *
 * - 业务「今天」→ 今天；业务「今天」的前一天 → 昨天；
 * - 其余 → `2026年10月29日 周三`。
 */
export function formatGroupLabel(dateStr: string, businessToday: string): string {
  const parts = parseDateParts(dateStr)
  if (parts === null) return dateStr
  if (dateStr === businessToday) return '今天'
  const previous = new Date(parts.year, parts.month - 1, parts.day + 1)
  if (formatDateParts(previous.getFullYear(), previous.getMonth() + 1, previous.getDate()) === businessToday) {
    return '昨天'
  }
  const weekday = WEEKDAYS[partsToDate(dateStr).getDay()]
  return `${parts.year}年${parts.month}月${parts.day}日 ${weekday}`
}

/** 每个时间线节点显示实际业务日期，日期本身作为分组标识。 */
export function formatAbsoluteGroupLabel(dateStr: string): string {
  const parts = parseDateParts(dateStr)
  if (parts === null) return dateStr
  return `${parts.year}年${parts.month}月${parts.day}日 ${WEEKDAYS[partsToDate(dateStr).getDay()]}`
}

/** 时间范围条的文案：day 完整日期；week 显示起止；month / year 显示年月 / 年。 */
export function formatRangeLabel(period: RecordsPeriod, range: DateRange): string {
  const start = parseDateParts(range.start)
  if (start === null) return `${range.start} ~ ${range.end}`
  if (period === 'day') return `${start.year}年${start.month}月${start.day}日`
  if (period === 'year') return `${start.year}年`
  const end = parseDateParts(range.end)
  if (end === null) return `${range.start} ~ ${range.end}`
  if (period === 'month') return `${start.year}年${start.month}月`
  return `${start.year}年${start.month}月${start.day}日 – ${end.year}年${end.month}月${end.day}日`
}

/** 相对业务日期显示所选范围，不以浏览器本地时区解释日期。 */
export function formatRelativeRangeLabel(period: RecordsPeriod, date: string, today: string): string {
  const a = parseDateParts(date)
  const b = parseDateParts(today)
  if (a === null || b === null) return '日期不可用'
  const epoch = (p: { year: number; month: number; day: number }) => Date.UTC(p.year, p.month - 1, p.day) / 86400000
  let offset: number
  if (period === 'day') offset = epoch(a) - epoch(b)
  else if (period === 'week') {
    const first = parseDateParts(rangeForPeriod('week', date).start)!
    const current = parseDateParts(rangeForPeriod('week', today).start)!
    offset = (epoch(first) - epoch(current)) / 7
  } else if (period === 'month') offset = (a.year - b.year) * 12 + a.month - b.month
  else offset = a.year - b.year
  const current = { day: '今天', week: '本周', month: '本月', year: '今年' }[period]
  const previous = { day: '昨天', week: '上周', month: '上个月', year: '去年' }[period]
  const next = { day: '明天', week: '下周', month: '下个月', year: '明年' }[period]
  if (offset === 0) return current
  if (offset === -1) return previous
  if (offset === 1) return next
  const unit = { day: '天', week: '周', month: '个月', year: '年' }[period]
  return `${Math.abs(offset)} ${unit}${offset < 0 ? '前' : '后'}`
}

/**
 * 正文摘要：把所有空白（含换行）折叠成单个空格并截断。
 *
 * 列表接口返回的 `content` 就是服务器原文；这里只做展示裁剪，不改写内容本身。
 */
export function summarizeContent(content: string, max = 120): string {
  const collapsed = content.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max)}…`
}
