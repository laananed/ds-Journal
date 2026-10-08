/**
 * Journal 显示标题纯逻辑的最小测试（Stage 1.5 / S1.5-T1）。
 *
 * 不引入测试框架：直接用 Node 内置的类型剥离运行本文件——
 *
 *   node --experimental-strip-types src/utils/journalTitles.test.ts
 *
 * 断言只用 `throw`，因此本文件不需要 Node 的类型声明，
 * 也能被 `tsc -b` 正常检查。
 *
 * 测试调用的是 `journalTitles.ts` 里真实导出的 `buildDisplayTitles()`
 * （不是把算法复制一份过来），并且刻意覆盖三类容易写错的地方：
 *
 * - **编号与展示顺序解耦**：输入按后端顺序（新 → 旧）给，编号必须按创建时间升序给；
 * - **时间精度**：只用 `Date` 的毫秒精度比较会把「同一毫秒内的两条记录」当成并列，
 *   于是退回按 id 排序；这里用只差微秒、且 id 故意反向的数据固定住这个行为；
 * - **不改输入**：函数不能原地排序传入数组，也不能改动传入的 `Journal` 对象。
 */

import { buildDisplayTitles } from './journalTitles.ts'
import type { Journal } from '../types/journal.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`失败：${label}`)
  }
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  check(
    actualText === expectedText,
    `${label}：期望 ${expectedText}，实际 ${actualText}`,
  )
}

/** 构造一条 Journal；只写出本文件关心的字段，其余给固定值。 */
function journal(overrides: Partial<Journal> = {}): Journal {
  return {
    type: 'journal',
    display_title: '2026-10-02',
    folder_id: null,
    deleted_at: null,
    id: 1,
    title: null,
    content: '正文',
    journal_date: '2026-10-02',
    created_at: '2026-10-07T09:00:00.000000Z',
    updated_at: '2026-10-07T09:00:00.000000Z',
    ...overrides,
  }
}

/** 把 id → 显示标题 的映射摊平成便于断言的对象。 */
function titlesById(journals: Journal[]): Record<string, string> {
  const map = buildDisplayTitles(journals)
  const flat: Record<string, string> = {}
  for (const item of journals) {
    flat[String(item.id)] = map.get(item.id) ?? '<缺失>'
  }
  return flat
}

const DAY_A = '2026-10-02'
const DAY_B = '2026-10-03'

// ---- 1. 后端顺序（新 → 旧）：同一天三条无标题，编号必须按创建时间升序 ----

const sameDay = [
  journal({ id: 3, created_at: `${DAY_A}T04:00:03.000000Z` }),
  journal({ id: 2, created_at: `${DAY_A}T04:00:02.000000Z` }),
  journal({ id: 1, created_at: `${DAY_A}T04:00:01.000000Z` }),
]

expectEqual(
  titlesById(sameDay),
  { 3: `${DAY_A} (3)`, 2: `${DAY_A} (2)`, 1: DAY_A },
  '新→旧输入：最早创建的拿 1 号（纯日期），最新的拿最大号',
)
check(
  buildDisplayTitles(sameDay).get(3) !== DAY_A,
  '最新的那条不再占用纯日期标题',
)

// ---- 2. 乱序 / 正序输入得到同一结果（编号不依赖输入顺序） ----

const shuffled = [sameDay[1], sameDay[2], sameDay[0]]
expectEqual(
  titlesById(shuffled),
  titlesById(sameDay),
  '乱序输入与后端顺序输出同一套编号',
)

const ascending = [sameDay[2], sameDay[1], sameDay[0]]
expectEqual(
  titlesById(ascending),
  titlesById(sameDay),
  '升序输入与后端顺序输出同一套编号',
)

// ---- 3. 同一时刻：created_at 完全相同才用 id ASC 打破并列 ----

const sameInstant = [
  journal({ id: 9, created_at: `${DAY_A}T04:00:00.000000Z` }),
  journal({ id: 7, created_at: `${DAY_A}T04:00:00.000000Z` }),
]
expectEqual(
  titlesById(sameInstant),
  { 9: `${DAY_A} (2)`, 7: DAY_A },
  'created_at 完全相同时 id 小的拿 1 号（与输入顺序无关）',
)

// ---- 4. 时间精度：只差微秒就不是并列，且不得退回按 id 排序 ----

const microsecondApart = [
  // id 更大的那条**更晚**创建：若实现丢了微秒精度就会错把它排到前面（或按 id 排反）。
  journal({ id: 500, created_at: `${DAY_A}T04:00:00.000100Z` }),
  journal({ id: 400, created_at: `${DAY_A}T04:00:00.000200Z` }),
]
expectEqual(
  titlesById(microsecondApart),
  { 500: DAY_A, 400: `${DAY_A} (2)` },
  '同一毫秒内只差微秒：按真实时间排序，不因丢精度改用 id 排序',
)

// 小数位长度不同（.45 < .5）也要比较正确。
const digitsApart = [
  journal({ id: 11, created_at: `${DAY_A}T04:00:00.5Z` }),
  journal({ id: 12, created_at: `${DAY_A}T04:00:00.45Z` }),
]
expectEqual(
  titlesById(digitsApart),
  { 12: DAY_A, 11: `${DAY_A} (2)` },
  '小数位数不同（.45 与 .5）时按数值比较',
)

// 整秒（没有小数部分）与带小数的时刻混在一起。
const withWholeSecond = [
  journal({ id: 21, created_at: `${DAY_A}T04:00:01Z` }),
  journal({ id: 22, created_at: `${DAY_A}T04:00:00.999999Z` }),
]
expectEqual(
  titlesById(withWholeSecond),
  { 22: DAY_A, 21: `${DAY_A} (2)` },
  '无小数部分的整秒时间戳也参与正确排序',
)

// 时区内偏移不同：+08:00 的 12:00 与 Z 的 04:00 是同一时刻 —— 按绝对时间比较。
const offsetAware = [
  journal({ id: 31, created_at: `${DAY_A}T12:00:00+08:00` }),
  journal({ id: 32, created_at: `${DAY_A}T04:00:01Z` }),
]
expectEqual(
  titlesById(offsetAware),
  { 31: DAY_A, 32: `${DAY_A} (2)` },
  '带时区偏移的时间戳按绝对时间（而不是字面字符串）排序',
)

// 无法解析的时间戳：退回字符串比较，只要求顺序确定、不抛异常。
const unparsable = [
  journal({ id: 41, created_at: '不明时间 B' }),
  journal({ id: 42, created_at: '不明时间 A' }),
]
expectEqual(
  titlesById(unparsable),
  { 42: DAY_A, 41: `${DAY_A} (2)` },
  '无法解析的时间戳退回字符串比较，不抛异常',
)

// ---- 5. 手工标题不占号 ----

const withCustomTitle = [
  // 最早的一条带手工标题：既不拿 1 号，也不把 1 号让给下面的记录。
  journal({ id: 53, title: '手工标题', created_at: `${DAY_A}T04:00:00.000000Z` }),
  journal({ id: 52, created_at: `${DAY_A}T04:00:02.000000Z` }),
  journal({ id: 51, created_at: `${DAY_A}T04:00:01.000000Z` }),
]
expectEqual(
  titlesById(withCustomTitle),
  { 53: '手工标题', 52: `${DAY_A} (2)`, 51: DAY_A },
  '有手工标题的记录不消耗编号，无标题记录仍从 1 号开始',
)

// ---- 6. 两个日期分别计数 ----

const twoDays = [
  journal({ id: 62, journal_date: DAY_B, created_at: `${DAY_B}T04:00:02.000000Z` }),
  journal({ id: 61, journal_date: DAY_B, created_at: `${DAY_B}T04:00:01.000000Z` }),
  journal({ id: 2, journal_date: DAY_A, created_at: `${DAY_A}T04:00:02.000000Z` }),
  journal({ id: 1, journal_date: DAY_A, created_at: `${DAY_A}T04:00:01.000000Z` }),
]
expectEqual(
  titlesById(twoDays),
  {
    62: `${DAY_B} (2)`,
    61: DAY_B,
    2: `${DAY_A} (2)`,
    1: DAY_A,
  },
  '不同日期各自从 1 号开始计数',
)

// 同一天只有一条：就是纯日期，没有 (2)。
expectEqual(
  titlesById([journal({ id: 71 })]),
  { 71: DAY_A },
  '同一天只有一条时显示纯日期',
)

// ---- 7. null / 空字符串 / 纯空白手工标题 ----

const titleVariants = [
  journal({ id: 84, title: '   ', created_at: `${DAY_A}T04:00:04.000000Z` }),
  journal({ id: 83, created_at: `${DAY_A}T04:00:03.000000Z` }),
  journal({ id: 82, title: '', created_at: `${DAY_A}T04:00:02.000000Z` }),
  journal({ id: 81, created_at: `${DAY_A}T04:00:01.000000Z` }),
]
expectEqual(
  titlesById(titleVariants),
  {
    84: '   ',
    83: `${DAY_A} (3)`,
    82: `${DAY_A} (2)`,
    81: DAY_A,
  },
  'null 与空字符串都算无标题参与编号；纯空白非空标题是手工标题、原样保留且不占号',
)

// ---- 8. 新增较晚创建的无标题记录后，旧记录的标题完全不变 ----

const beforeAdd = [
  journal({ id: 3, created_at: `${DAY_A}T04:00:03.000000Z` }),
  journal({ id: 2, created_at: `${DAY_A}T04:00:02.000000Z` }),
  journal({ id: 1, created_at: `${DAY_A}T04:00:01.000000Z` }),
]
const titlesBefore = titlesById(beforeAdd)

// 模拟「刷新后重新渲染」：同一天多了一条 created_at 最晚的记录。
const afterAdd = [
  journal({ id: 4, created_at: `${DAY_A}T04:00:04.000000Z` }),
  ...beforeAdd,
]
const titlesAfter = titlesById(afterAdd)

expectEqual(
  [titlesAfter[1], titlesAfter[2], titlesAfter[3]],
  [titlesBefore[1], titlesBefore[2], titlesBefore[3]],
  '新增一条较晚的无标题记录后，旧记录的显示标题保持不变',
)
expectEqual(titlesAfter[4], `${DAY_A} (4)`, '新增的记录拿到新号')
expectEqual(titlesAfter[1], DAY_A, '1 号仍然是创建最早的那条')

// ---- 9. 输入数组与其中的对象都没有被修改 ----

const inputForMutationCheck = [
  journal({ id: 3, content: '第三篇', created_at: `${DAY_A}T04:00:03.000000Z` }),
  journal({ id: 1, content: '第一篇', created_at: `${DAY_A}T04:00:01.000000Z` }),
  journal({ id: 2, content: '第二篇', created_at: `${DAY_A}T04:00:02.000000Z` }),
]
const snapshotBefore = JSON.stringify(inputForMutationCheck)

buildDisplayTitles(inputForMutationCheck)

expectEqual(
  JSON.stringify(inputForMutationCheck),
  snapshotBefore,
  '调用后输入数组与对象的内容、顺序都未被修改（含 title 仍为 null）',
)
expectEqual(
  inputForMutationCheck.map((item) => item.id),
  [3, 1, 2],
  '输入数组的顺序未被原地排序修改',
)

// ---- 10. 空数组 ----

expectEqual(
  buildDisplayTitles([]).size,
  0,
  '空数组返回空映射',
)

// 结论输出保持 ASCII，避免终端编码带来的干扰。
console.log(`journalTitles: ${passed} assertions passed`)
