/**
 * 独立日程（C01）的时间纯逻辑：Asia/Shanghai 展示、UTC 存储、排序与本地输入互转。
 *
 * 契约依据 `docs/stage4-api.md` §13：
 * - 时间字段是**带时区** ISO 字符串，服务端按 **UTC** 存储；
 * - 界面**按 Asia/Shanghai 转换**展示；
 * - 列表按开始时间与 ID 稳定排序。
 *
 * 为什么用固定 +8 而不是 `Intl` 反解：
 * Asia/Shanghai 自 1991 年起不再使用夏令时，全年固定 UTC+8；这里只做「同一时刻的
 * 两种表示」换算，固定偏移是可逆、可测试的。要显示时区名时直接用常量标注，
 * 不假装做了历史时区库那种计算。
 *
 * 本文件不 import 任何运行时代码（只有类型导入，会被类型剥离擦除），
 * 因此可以用 `node --experimental-strip-types` 直接跑测试。
 */

import type { ScheduleId } from '../types/schedule.ts'

/** 中国大陆标准时间偏移：UTC+8。 */
export const SHANGHAI_OFFSET_MINUTES = 480
/** 展示用的时区标识，与产品文档一致。 */
export const SHANGHAI_TIME_ZONE_LABEL = 'Asia/Shanghai'

/** 上海挂钟时间（不带时区信息，指「当地墙上看到的年月日时分」）。 */
export type ShanghaiWallClock = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** `<input type="datetime-local" step="60">` 的值形状：`YYYY-MM-DDTHH:mm`。 */
const LOCAL_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/**
 * 真实存在的日历日校验。
 *
 * 不能只看 `1 <= day <= 31`：`2026-02-30` 会被 `Date` 默默滚到 3 月 2 日，
 * 那样等于替用户改日期。这里用 UTC 构造后反查年月日是否原样保留。
 */
export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
}

/** 解析本地输入值；形状或日期/时刻不合法返回 null（不做任何自动修正）。 */
export function parseShanghaiInput(value: string): ShanghaiWallClock | null {
  const matched = LOCAL_INPUT_PATTERN.exec(value)
  if (matched === null) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const hour = Number(matched[4])
  const minute = Number(matched[5])
  if (!isRealCalendarDate(year, month, day)) return null
  if (hour > 23 || minute > 59) return null
  return { year, month, day, hour, minute }
}

/** 上海挂钟 → UTC ISO（服务端存储格式）。 */
export function shanghaiWallClockToUtcIso(wall: ShanghaiWallClock): string {
  const utcMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
    - SHANGHAI_OFFSET_MINUTES * 60_000
  return new Date(utcMs).toISOString()
}

/** 本地输入值 → UTC ISO；不合法返回 null。 */
export function inputToUtcIso(value: string): string | null {
  const wall = parseShanghaiInput(value)
  return wall === null ? null : shanghaiWallClockToUtcIso(wall)
}

/** UTC/带时区 ISO → 上海挂钟；无法解析返回 null。 */
export function utcIsoToShanghaiWallClock(iso: string): ShanghaiWallClock | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const shifted = new Date(ms + SHANGHAI_OFFSET_MINUTES * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  }
}

/** UTC/带时区 ISO → 本地输入值；无法解析返回 null。 */
export function utcIsoToShanghaiInput(iso: string): string | null {
  const wall = utcIsoToShanghaiWallClock(iso)
  if (wall === null) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`
}

function wallClockWeekday(wall: ShanghaiWallClock): string {
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()
  return WEEKDAY_LABELS[weekday] ?? ''
}

function formatWallClockDateTime(wall: ShanghaiWallClock): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${wall.year}年${wall.month}月${wall.day}日 ${wallClockWeekday(wall)} ${pad(wall.hour)}:${pad(wall.minute)}`
}

/**
 * 展示「2026年10月30日 周五 14:30」。
 * 非法输入原样返回：界面宁可显示原文，也不要因为脏数据白屏。
 */
export function formatShanghaiDateTime(iso: string): string {
  const wall = utcIsoToShanghaiWallClock(iso)
  return wall === null ? iso : formatWallClockDateTime(wall)
}

/**
 * 展示时间范围：同一天省略重复日期，`14:30–16:00`；跨天写出两端完整时间。
 * `ends_at` 为 null 或无法解析时只显示开始时间，不伪造结束时间。
 */
export function formatShanghaiTimeRange(startsAt: string, endsAt: string | null): string {
  const startWall = utcIsoToShanghaiWallClock(startsAt)
  if (startWall === null) return startsAt
  if (endsAt === null) return formatWallClockDateTime(startWall)
  const endWall = utcIsoToShanghaiWallClock(endsAt)
  if (endWall === null) return formatWallClockDateTime(startWall)
  const sameDay = startWall.year === endWall.year
    && startWall.month === endWall.month
    && startWall.day === endWall.day
  if (sameDay) {
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${formatWallClockDateTime(startWall)}–${pad(endWall.hour)}:${pad(endWall.minute)}`
  }
  return `${formatWallClockDateTime(startWall)} – ${formatWallClockDateTime(endWall)}`
}

/**
 * ID 归一：列表 key、Map 键、URL 片段统一走这里。
 * §13 未规定 ID 是整数还是 UUID，归一后两种都能用。
 */
export function scheduleKey(id: ScheduleId): string {
  return typeof id === 'number' ? String(id) : id
}

function idSortValue(id: ScheduleId): number | null {
  if (typeof id === 'number') return Number.isFinite(id) ? id : null
  return /^\d+$/.test(id) ? Number(id) : null
}

/**
 * 「按开始时间与 ID 稳定排序」的前端实现。
 *
 * 排序权威在服务端（§13）；这个函数只给 **Mock** 和本地合成列表用，
 * 页面不会用它去覆盖后端顺序——否则会把后端排序缺陷盖住。
 * 无法解析的开始时间排到最后，同时间按 ID 升序，仍相同则保持原序。
 */
export function compareSchedulesByStartThenId(
  a: { starts_at: string; id: ScheduleId },
  b: { starts_at: string; id: ScheduleId },
): number {
  const aMs = Date.parse(a.starts_at)
  const bMs = Date.parse(b.starts_at)
  const aValid = !Number.isNaN(aMs)
  const bValid = !Number.isNaN(bMs)
  if (aValid && bValid && aMs !== bMs) return aMs - bMs
  if (aValid !== bValid) return aValid ? -1 : 1
  const aId = idSortValue(a.id)
  const bId = idSortValue(b.id)
  if (aId !== null && bId !== null && aId !== bId) return aId - bId
  return 0
}
