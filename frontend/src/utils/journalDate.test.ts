/**
 * 默认业务日期规则的最小测试（Stage 1 / Task 8.2）。
 *
 * 不引入测试框架：直接用 Node 内置的类型剥离运行本文件——
 *
 *   node --experimental-strip-types src/utils/journalDate.test.ts
 *
 * 断言只用 `throw`，因此本文件不需要 Node 的类型声明，
 * 也能被 `tsc -b` 正常检查。
 *
 * 测试调用的是 `journalDate.ts` 里的真实函数（不是复制一份算法过来），
 * 时间点全部用本机 `Date` 构造，不依赖运行测试的当前真实时间。
 */

import { defaultJournalDate } from './journalDate.ts'

/** 构造本机时间；`month` 用 1 起（更贴近人的写法）。 */
function at(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

function expectDate(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${expected}，实际 ${actual}`)
  }
}

const cases: Array<[string, Date, string]> = [
  // 换日边界
  ['00:00 属于前一天', at(2026, 10, 2, 0, 0), '2026-10-01'],
  ['03:59 仍属于前一天', at(2026, 10, 2, 3, 59), '2026-10-01'],
  ['04:00 切换为当天', at(2026, 10, 2, 4, 0), '2026-10-02'],
  ['23:59 属于当天', at(2026, 10, 2, 23, 59), '2026-10-02'],
  // 跨月 / 跨年
  ['月初跨月（3/1 03:00 → 2 月末）', at(2026, 3, 1, 3, 0), '2026-02-28'],
  ['月末跨月（11/1 00:30 → 10/31）', at(2026, 11, 1, 0, 30), '2026-10-31'],
  ['年初跨年（1/1 02:00 → 上一年 12/31）', at(2026, 1, 1, 2, 0), '2025-12-31'],
  // 闰年
  ['闰日次日（2024/3/1 01:00 → 2024/2/29）', at(2024, 3, 1, 1, 0), '2024-02-29'],
  ['闰日当天（2024/2/29 04:00 → 当天）', at(2024, 2, 29, 4, 0), '2024-02-29'],
  ['平年（2025/3/1 03:00 → 2/28）', at(2025, 3, 1, 3, 0), '2025-02-28'],
]

for (const [label, now, expected] of cases) {
  expectDate(defaultJournalDate(now), expected, label)
}

// 结论输出保持 ASCII，避免终端编码带来的干扰。
console.log(`defaultJournalDate: ${cases.length} cases passed`)
