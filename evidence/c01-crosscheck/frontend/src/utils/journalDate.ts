/**
 * 默认业务日期规则（Stage 1 / Task 8.2）。
 *
 * 规则来自 `docs/stage1-api.md` 第 14 节「Default journal_date」：
 *
 * - 00:00 ～ 03:59：默认前一天；
 * - 04:00 ～ 23:59：默认当天。
 *
 * 默认日期由前端计算（后端 Stage 1 不推断用户想写哪一天），
 * 用户随后可以手动修改。
 *
 * ## 为什么这样算日期
 *
 * - 用本机的 `getFullYear()` / `getMonth()` / `getDate()` 取**本机日历日期**；
 * - 减一天交给 `Date` 构造器完成（`new Date(y, m, d - 1)`），
 *   它会自动处理跨月、跨年与闰年，**不是**减固定 24 小时；
 * - 显式避免 `toISOString().slice(0, 10)`：它先把本机时间转成 UTC 再取日期，
 *   在东八区的凌晨会整体偏前一天，得到错误的业务日期。
 */

/** 换日时刻：本机 04:00。 */
const DAY_START_HOUR = 4

/** 把 `Date` 的本机年月日格式化为 `YYYY-MM-DD`。 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 计算本机当前时间对应的默认 `journal_date`。
 *
 * @param now 用于计算的时刻，默认取当前时间。
 *   显式传入是为了让测试可以构造确定性的时间点（例如 03:59 与 04:00）。
 * @returns `YYYY-MM-DD` 字符串，可直接发送给后端或喂给 `<input type="date">`。
 */
export function defaultJournalDate(now: Date = new Date()): string {
  if (now.getHours() < DAY_START_HOUR) {
    // 传「日 - 1」而不是减 86400000 毫秒：Date 会按日历回退，跨月 / 跨年 / 闰年都正确。
    return formatLocalDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
    )
  }
  return formatLocalDate(now)
}
