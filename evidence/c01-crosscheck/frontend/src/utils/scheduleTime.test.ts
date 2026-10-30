/**
 * Asia/Shanghai 时间纯逻辑测试（C01）。
 *
 * 运行：`node --experimental-strip-types src/utils/scheduleTime.test.ts`
 *
 * 只调真实函数，不复制算法；断言只用 `throw`，因此不需要 Node 类型声明，
 * 也能被 `tsc -b` 正常检查。所有用例都是**固定时刻**，不依赖运行时的当前时间。
 */

import {
  compareSchedulesByStartThenId,
  formatShanghaiDateTime,
  formatShanghaiTimeRange,
  inputToUtcIso,
  isRealCalendarDate,
  parseShanghaiInput,
  scheduleKey,
  SHANGHAI_OFFSET_MINUTES,
  utcIsoToShanghaiInput,
} from './scheduleTime.ts'

let assertions = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  assertions += 1
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`)
  }
}

function expectNull(actual: unknown, label: string): void {
  assertions += 1
  if (actual !== null) throw new Error(`${label}：期望 null，实际 ${String(actual)}`)
}

/* ------------------------------------------------ 偏移与日历日 */

expectEqual(SHANGHAI_OFFSET_MINUTES, 480, '上海固定 UTC+8')

expectEqual(isRealCalendarDate(2026, 2, 29), false, '2026 不是闰年，2/29 不合法')
expectEqual(isRealCalendarDate(2024, 2, 29), true, '2024 是闰年，2/29 合法')
expectEqual(isRealCalendarDate(2026, 4, 31), false, '4/31 不合法')
expectEqual(isRealCalendarDate(2026, 13, 1), false, '13 月不合法')

/* ------------------------------------------------ 本地值 ⇄ UTC ISO */

expectEqual(inputToUtcIso('2026-10-30T14:30'), '2026-10-30T06:30:00.000Z', '上海 14:30 → UTC 06:30')
expectEqual(inputToUtcIso('2026-10-30T00:30'), '2026-10-29T16:30:00.000Z', '上海凌晨 00:30 → UTC 前一天')
expectEqual(inputToUtcIso('2026-10-30T23:59'), '2026-10-30T15:59:00.000Z', '上海 23:59 → UTC 同日 15:59')

expectNull(inputToUtcIso('2026-02-30T10:00'), '2/30 不自动滚到 3 月')
expectNull(inputToUtcIso('2026-10-30T24:00'), '24:00 不合法')
expectNull(inputToUtcIso('2026-10-30T10:60'), '60 分不合法')
expectNull(inputToUtcIso('2026-10-30'), '缺时刻不合法')
expectNull(inputToUtcIso(' 2026-10-30T10:00'), '带空格不自动容忍')
expectNull(parseShanghaiInput(''), '空串不合法')

expectEqual(utcIsoToShanghaiInput('2026-10-30T06:30:00.000Z'), '2026-10-30T14:30', 'UTC 06:30 → 上海 14:30')
expectEqual(utcIsoToShanghaiInput('2026-10-30T06:30:00Z'), '2026-10-30T14:30', '无毫秒的 ISO 同样解析')
expectEqual(utcIsoToShanghaiInput('2026-10-29T16:30:00.000Z'), '2026-10-30T00:30', 'UTC 前一天 → 上海次日凌晨')
expectNull(utcIsoToShanghaiInput('不是时间'), '非法 ISO 返回 null')

// 往返：本地值 → UTC → 本地值 必须原样还原
for (const value of ['2026-01-01T00:00', '2026-06-15T12:34', '2026-12-31T23:59', '2024-02-29T04:00']) {
  const utc = inputToUtcIso(value)
  expectEqual(utc === null ? null : utcIsoToShanghaiInput(utc), value, `往返一致：${value}`)
}

/* ------------------------------------------------ 展示格式 */

expectEqual(formatShanghaiDateTime('2026-10-30T06:30:00.000Z'), '2026年10月30日 周五 14:30', '展示含星期')
expectEqual(formatShanghaiDateTime('2026-10-31T17:00:00.000Z'), '2026年11月1日 周日 01:00', '跨月与跨日展示')
expectEqual(formatShanghaiDateTime('乱码'), '乱码', '非法输入原样返回')

expectEqual(
  formatShanghaiTimeRange('2026-10-30T06:30:00.000Z', '2026-10-30T08:00:00.000Z'),
  '2026年10月30日 周五 14:30–16:00',
  '同日范围省略重复日期',
)
expectEqual(
  formatShanghaiTimeRange('2026-10-30T15:30:00.000Z', '2026-10-30T17:00:00.000Z'),
  '2026年10月30日 周五 23:30 – 2026年10月31日 周六 01:00',
  '跨日范围两端都写全',
)
expectEqual(
  formatShanghaiTimeRange('2026-10-30T06:30:00.000Z', null),
  '2026年10月30日 周五 14:30',
  '缺结束时间不伪造结束',
)

/* ------------------------------------------------ 排序与 ID 归一 */

const early = { starts_at: '2026-10-30T01:00:00.000Z', id: 2 }
const late = { starts_at: '2026-10-30T09:00:00.000Z', id: 1 }
const broken = { starts_at: '坏数据', id: 3 }

const ordered = [late, broken, early].sort(compareSchedulesByStartThenId)
expectEqual(ordered[0], early, '按开始时间升序')
expectEqual(ordered[1], late, '按开始时间升序（第二条）')
expectEqual(ordered[2], broken, '无法解析的开始时间排最后')

const tieA = { starts_at: '2026-10-30T01:00:00.000Z', id: 7 }
const tieB = { starts_at: '2026-10-30T01:00:00.000Z', id: 5 }
expectEqual(compareSchedulesByStartThenId(tieA, tieB) > 0, true, '同一时间按 ID 升序')
expectEqual(compareSchedulesByStartThenId(tieB, tieB), 0, '完全相同返回 0（保持稳定）')

expectEqual(scheduleKey(12), '12', '整数 ID 归一为字符串')
expectEqual(scheduleKey('a1b2'), 'a1b2', '字符串 ID 原样')

console.log(`scheduleTime: ${assertions} assertions passed`)
