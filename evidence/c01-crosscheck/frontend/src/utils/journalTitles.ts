/**
 * Journal 显示标题的纯逻辑（Stage 1.5 / S1.5-T1）。
 *
 * 规则来自 `docs/stage1.5-bugfix.md` 第 5 节「Bug 1：无标题编号方向」：
 *
 * - 同一天的**无标题**记录按 `created_at ASC` 编号；
 *   只有 `created_at` 真正相同（精确到微秒）才用 `id ASC` 打破并列；
 * - 编号 1 显示 `日期`，之后显示 `日期 (2)`、`日期 (3)`……
 * - `title` 为 `null` 或空字符串都算「无标题」；
 *   纯空白但非空的标题是**手工标题**，原样保留、不参与编号；
 * - 手工标题的记录不消耗编号；
 * - 编号只存在于 UI：不写回 API，也不写回数据库。
 *
 * 为什么要按 `created_at ASC` 而不是按列表顺序编号：
 *
 * - 列表沿用后端返回的顺序（`journal_date DESC`、同日 `created_at DESC`），
 *   也就是「最新的在最上面」；
 * - 如果照列表顺序从 1 开始数，最新那条永远是 1 号，
 *   于是**每新增一条较晚的记录，旧记录的编号都会整体 +1**；
 * - 按创建时间升序给同一天的记录排队再编号，编号就与「谁更新」无关：
 *   新增一条较晚的记录只会追加一个新号，旧记录的号保持不变。
 *
 * 本函数依赖**完整数据**（同一天的全部记录都在传入数组里）。
 * 它不能直接用于 Stage 2 的分页结果：分页只拿到当前页时，
 * 「同一天最早的记录」可能不在这一页，编号会算错；
 * 由后端提供统一的显示标题元数据是 Stage 2 的事。
 *
 * 本文件不依赖 React，也不发请求，因此可以用
 * `node --experimental-strip-types` 直接测试。
 */

import type { Journal } from '../types/journal.ts'

/** 时间戳解析结果：整秒 + 小数秒（小数秒原样保留成文本，避免丢精度）。 */
interface ParsedTimestamp {
  seconds: number
  /** 小数秒的原始数字文本，例如 `594800`；没有小数部分时为 `''`。 */
  fraction: string
}

/**
 * 匹配后端返回的时间戳，覆盖实际可能出现的写法：
 *
 * ```text
 * 2026-10-07T11:57:29.594800Z   （本机后端实际返回的格式）
 * 2026-10-07T11:57:29+08:00     （带偏移）
 * 2026-10-07T11:57:29           （没有小数秒）
 * ```
 */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/

/** 解析时间戳；格式不认识时返回 `null`。 */
function parseTimestamp(value: string): ParsedTimestamp | null {
  const match = TIMESTAMP_PATTERN.exec(value)
  if (match === null) {
    return null
  }

  const [, year, month, day, hour, minute, second, fraction = '', zone = ''] = match

  let offsetMinutes = 0
  if (zone !== '' && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    offsetMinutes =
      sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  }

  // `Date.UTC` 在这里只用来把「年月日时分秒」折算成绝对秒数：
  // 它不做本地时区换算，也不参与格式化，因此不会引入时区偏移问题。
  // 小数秒**不经过** `Date`：毫秒精度会把微秒差抹平，
  // 结果就是「同一毫秒内的两条记录」被判成并列，只能退回按 id 排序。
  const seconds =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ) /
      1000 -
    offsetMinutes * 60

  return { seconds, fraction }
}

/**
 * 比较两个时间戳的先后；`left` 更早返回负数。
 *
 * - 两边都能解析：先比整秒，再比小数秒（按数值，即右补 0 后按文本比较）；
 * - 任一边解析不了：退回原始字符串比较，只保证顺序确定、不抛异常。
 */
function compareTimestamps(left: string, right: string): number {
  const a = parseTimestamp(left)
  const b = parseTimestamp(right)

  if (a !== null && b !== null) {
    if (a.seconds !== b.seconds) {
      return a.seconds < b.seconds ? -1 : 1
    }

    if (a.fraction !== b.fraction) {
      // `.5` 与 `.45` 必须按数值比较（0.5 > 0.45），右补 0 对齐位数即可。
      const width = Math.max(a.fraction.length, b.fraction.length)
      const paddedA = a.fraction.padEnd(width, '0')
      const paddedB = b.fraction.padEnd(width, '0')
      return paddedA < paddedB ? -1 : 1
    }

    return 0
  }

  if (left === right) {
    return 0
  }
  return left < right ? -1 : 1
}

/**
 * 计算每条记录的显示标题。
 *
 * @returns `id → 显示标题` 的映射。调用方按自己的顺序渲染，
 *   只做一次 `get(id)` 查表，因此**不改变展示排序**。
 *
 * 传入的数组与其中的 `Journal` 对象**都不会被修改**：
 * 分桶用的是新数组，排序只发生在新数组上。
 */
export function buildDisplayTitles(journals: Journal[]): Map<number, string> {
  const displayTitles = new Map<number, string>()
  // 只有「无标题」记录需要编号，因此按 journal_date 分桶后再各自排队。
  const untitledByDate = new Map<string, Journal[]>()

  for (const journal of journals) {
    const title = journal.title

    if (title !== null && title !== '') {
      // 手工标题：原样显示，不参与编号，也不消耗编号。
      // 纯空白（如 '   '）属于这种「非空的手工标题」，不做 trim。
      displayTitles.set(journal.id, title)
      continue
    }

    const bucket = untitledByDate.get(journal.journal_date)
    if (bucket === undefined) {
      untitledByDate.set(journal.journal_date, [journal])
    } else {
      bucket.push(journal)
    }
  }

  for (const [journalDate, bucket] of untitledByDate) {
    bucket.sort((left, right) => {
      const byCreatedAt = compareTimestamps(left.created_at, right.created_at)
      return byCreatedAt !== 0 ? byCreatedAt : left.id - right.id
    })

    bucket.forEach((journal, index) => {
      const position = index + 1
      displayTitles.set(
        journal.id,
        position === 1 ? journalDate : `${journalDate} (${position})`,
      )
    })
  }

  return displayTitles
}
