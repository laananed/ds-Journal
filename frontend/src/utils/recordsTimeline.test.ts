/**
 * `recordsTimeline.ts` 的纯逻辑测试（node --experimental-strip-types 直接运行）。
 */
import {
  dateInRange,
  formatGroupLabel,
  formatRangeLabel,
  groupJournalsByDate,
  kindLabel,
  kindModifier,
  parseDateParts,
  rangeForPeriod,
  shiftPeriod,
  summarizeContent,
} from './recordsTimeline.ts'
import type { Journal } from '../types/journal.ts'

let passed = 0
function equal(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`)
  passed += 1
}

// ---------- parseDateParts ----------

equal(parseDateParts('2026-11-02'), { year: 2026, month: 11, day: 2 }, 'parse valid date')
equal(parseDateParts('2026-2-3'), null, 'reject non padded date')
equal(parseDateParts('2026-02-30'), null, 'reject impossible day')
equal(parseDateParts('2026-13-01'), null, 'reject month 13')
equal(parseDateParts(''), null, 'reject empty')
equal(parseDateParts('2026-11-02T08:00:00'), null, 'reject datetime string')

// ---------- rangeForPeriod ----------

// 2026-11-02 是周一：整周 11-02 ~ 11-08
equal(rangeForPeriod('day', '2026-11-02'), { start: '2026-11-02', end: '2026-11-02' }, 'day range')
equal(rangeForPeriod('week', '2026-11-02'), { start: '2026-11-02', end: '2026-11-08' }, 'week starting Monday')
// 2026-11-01 是周日：所在周是 10-26 ~ 11-01（跨月）
equal(rangeForPeriod('week', '2026-11-01'), { start: '2026-10-26', end: '2026-11-01' }, 'week crossing month')
equal(rangeForPeriod('month', '2026-11-09'), { start: '2026-11-01', end: '2026-11-30' }, 'month range')
equal(rangeForPeriod('month', '2026-02-10'), { start: '2026-02-01', end: '2026-02-28' }, 'non leap feb')
equal(rangeForPeriod('month', '2024-02-10'), { start: '2024-02-01', end: '2024-02-29' }, 'leap feb')
equal(rangeForPeriod('year', '2026-11-02'), { start: '2026-01-01', end: '2026-12-31' }, 'year range')

// ---------- dateInRange ----------

const week = rangeForPeriod('week', '2026-11-02')
equal(dateInRange('2026-11-02', week), true, 'in range start')
equal(dateInRange('2026-11-08', week), true, 'in range end')
equal(dateInRange('2026-11-09', week), false, 'after range')
equal(dateInRange('2026-11-01', week), false, 'before range')

// ---------- shiftPeriod ----------

equal(shiftPeriod('day', '2026-11-01', -1), '2026-10-31', 'prev day crosses month')
equal(shiftPeriod('day', '2026-03-01', -1), '2026-02-28', 'prev day into feb')
equal(shiftPeriod('week', '2026-11-02', -1), '2026-10-26', 'prev week')
equal(shiftPeriod('week', '2026-11-02', 1), '2026-11-09', 'next week')
equal(shiftPeriod('month', '2026-01-31', 1), '2026-02-28', 'month clamps day')
equal(shiftPeriod('month', '2024-01-31', 1), '2024-02-29', 'leap year clamp')
equal(shiftPeriod('month', '2026-12-15', 1), '2027-01-15', 'month crosses year')
equal(shiftPeriod('year', '2026-11-02', -1), '2025-11-02', 'prev year')
equal(shiftPeriod('day', '2026-11-02', 0), '2026-11-02', 'zero shift')

// ---------- groupJournalsByDate ----------

function journal(id: number, journalDate: string, kind?: 'writing' | 'set' | 'end'): Journal {
  return {
    type: 'journal',
    id,
    title: null,
    display_title: `记录 ${id}`,
    content: `正文 ${id}`,
    revision: 1,
    folder_id: null,
    created_at: '2026-11-02T10:00:00Z',
    updated_at: '2026-11-02T10:00:00Z',
    deleted_at: null,
    journal_date: journalDate,
    journal_kind: kind,
  }
}

const items = [
  journal(1, '2026-11-02', 'writing'),
  journal(2, '2026-11-02', 'writing'),
  journal(3, '2026-11-02', 'set'),
  journal(4, '2026-11-01', 'end'),
  journal(5, '2026-10-28', 'writing'),
]
const groups = groupJournalsByDate(items)
equal(groups.length, 3, 'group count')
equal(groups[0].date, '2026-11-02', 'newest date first')
equal(groups[0].items.length, 3, 'same day keeps multiple items')
equal(groups[0].items.map((item) => item.id), [1, 2, 3], 'server order preserved inside day')
equal(groups[2].date, '2026-10-28', 'oldest group last')
equal(groupJournalsByDate([]).length, 0, 'empty list → no groups')

// ---------- kindLabel / kindModifier ----------

equal(kindLabel('writing'), '速记', 'writing label')
equal(kindLabel('set'), '计划', 'set label')
equal(kindLabel('end'), '复盘', 'end label')
equal(kindLabel(undefined), '速记', 'missing kind falls back to server default')
equal(kindModifier('set'), 'set', 'set modifier')
equal(kindModifier(undefined), 'writing', 'missing kind modifier')

// ---------- formatGroupLabel ----------

// 业务「今天」= 2026-11-02（周一）
equal(formatGroupLabel('2026-11-02', '2026-11-02'), '今天', 'today label')
equal(formatGroupLabel('2026-11-01', '2026-11-02'), '昨天', 'yesterday label')
equal(formatGroupLabel('2026-10-31', '2026-11-02'), '2026年10月31日 周六', 'other date with weekday')
equal(formatGroupLabel('2024-02-29', '2026-11-02'), '2024年2月29日 周四', 'leap date')
equal(formatGroupLabel('bad', '2026-11-02'), 'bad', 'invalid date passes through')

// ---------- formatRangeLabel ----------

equal(formatRangeLabel('day', { start: '2026-11-02', end: '2026-11-02' }), '2026年11月2日', 'day label')
equal(
  formatRangeLabel('week', { start: '2026-10-26', end: '2026-11-01' }),
  '2026年10月26日 – 2026年11月1日',
  'week label crossing month',
)
equal(formatRangeLabel('month', { start: '2026-11-01', end: '2026-11-30' }), '2026年11月', 'month label')
equal(formatRangeLabel('year', { start: '2026-01-01', end: '2026-12-31' }), '2026年', 'year label')

// ---------- summarizeContent ----------

equal(summarizeContent('  第一行\n\n第二行  '), '第一行 第二行', 'whitespace collapsed')
equal(summarizeContent('短'), '短', 'short content unchanged')
equal(summarizeContent('a'.repeat(130)), `${'a'.repeat(120)}…`, 'long content truncated')
equal(summarizeContent('a'.repeat(120)), 'a'.repeat(120), 'exactly max not truncated')

console.log(`recordsTimeline: ${passed} assertions passed`)
