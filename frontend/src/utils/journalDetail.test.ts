/**
 * 详情 / 编辑纯逻辑的最小测试（Stage 1 / Task 8.3）。
 *
 * 不引入测试框架：直接用 Node 内置的类型剥离运行本文件——
 *
 *   node --experimental-strip-types src/utils/journalDetail.test.ts
 *
 * 断言只用 `throw`，因此本文件不需要 Node 的类型声明，
 * 也能被 `tsc -b` 正常检查。
 *
 * 测试调用的是 `journalDetail.ts` 里的真实函数（不是复制一份算法过来）。
 */

import {
  buildJournalUpdate,
  displayJournalTitle,
  draftTitleToValue,
  formatServerTimestamp,
  isJournalUpdateEmpty,
  type JournalEditDraft,
} from './journalDetail.ts'
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

/** 构造一条原始 Journal；只写出本文件关心的字段值。 */
function journal(overrides: Partial<Journal> = {}): Journal {
  return {
    type: 'journal',
    display_title: '2026-10-02',
    folder_id: null,
    deleted_at: null,
    id: 42,
    title: '原始标题',
    content: '原始正文',
    journal_date: '2026-10-02',
    created_at: '2026-10-06T09:33:15.123456+00:00',
    updated_at: '2026-10-06T09:33:15.123456+00:00',
    ...overrides,
  }
}

/** 构造表单草稿；默认与 `journal()` 完全一致（即「什么都没改」）。 */
function draft(overrides: Partial<JournalEditDraft> = {}): JournalEditDraft {
  return {
    title: '原始标题',
    content: '原始正文',
    journal_date: '2026-10-02',
    folder_id: null,
    ...overrides,
  }
}

// ---- 标题归一化 ----

expectEqual(draftTitleToValue(''), null, '空字符串标题转成 null')
expectEqual(draftTitleToValue('广州动物园'), '广州动物园', '普通标题原样保留')
expectEqual(draftTitleToValue('   '), '   ', '空白字符串不做 trim，原样保留')

// ---- 只发送真正改动的字段 ----

expectEqual(buildJournalUpdate(journal(), draft()), {}, '没有任何改动时请求体为空')
check(
  isJournalUpdateEmpty(buildJournalUpdate(journal(), draft())),
  '没有改动时被判为空更新',
)

expectEqual(
  buildJournalUpdate(journal(), draft({ title: '新标题' })),
  { title: '新标题' },
  '只改标题只发送 title',
)

expectEqual(
  buildJournalUpdate(journal(), draft({ content: '新正文' })),
  { content: '新正文' },
  '只改正文只发送 content',
)

expectEqual(
  buildJournalUpdate(journal(), draft({ journal_date: '2026-09-30' })),
  { journal_date: '2026-09-30' },
  '只改日期只发送 journal_date',
)

expectEqual(
  buildJournalUpdate(
    journal(),
    draft({ title: '新标题', content: '新正文', journal_date: '2026-09-30' }),
  ),
  { title: '新标题', content: '新正文', journal_date: '2026-09-30' },
  '三个字段同时改动时全部发送',
)

// ---- 空标题 / 清空标题：正确区分 null 与字符串 ----

expectEqual(
  buildJournalUpdate(journal(), draft({ title: '' })),
  { title: null },
  '清空已有标题时发送 title=null',
)

expectEqual(
  buildJournalUpdate(journal({ title: null }), draft({ title: '' })),
  {},
  '原文标题本来就是 null 时，空表单不算改动',
)

expectEqual(
  buildJournalUpdate(journal({ title: null }), draft({ title: '补一个标题' })),
  { title: '补一个标题' },
  '从 null 改成字符串算改动',
)

expectEqual(
  buildJournalUpdate(journal({ title: '' }), draft({ title: '' })),
  {},
  '原文标题是空字符串时，未编辑的空表单不修改原值',
)

expectEqual(
  buildJournalUpdate(journal({ title: '' }), draft({ title: '新标题' })),
  { title: '新标题' },
  '原文标题是空字符串时，填上标题算改动',
)

// ---- 正文允许空字符串，且不允许 null ----

expectEqual(
  buildJournalUpdate(journal(), draft({ content: '' })),
  { content: '' },
  '正文改成空字符串也要发送（content 不可为 null）',
)

expectEqual(
  buildJournalUpdate(journal({ content: '' }), draft({ content: '' })),
  {},
  '原文正文本来就是空字符串时不算改动',
)

// ---- Folder 差异（S2-T08）----

expectEqual(
  buildJournalUpdate(journal({ folder_id: 3 }), draft({ folder_id: 5 })),
  { folder_id: 5 },
  'Folder 变化提交新 id',
)
expectEqual(
  buildJournalUpdate(journal({ folder_id: 3 }), draft({ folder_id: null })),
  { folder_id: null },
  '移出 Folder 显式提交 folder_id=null',
)
expectEqual(
  buildJournalUpdate(journal({ folder_id: null }), draft({ folder_id: 3 })),
  { folder_id: 3 },
  '移入 Folder 提交目标 id',
)
expectEqual(
  buildJournalUpdate(journal({ folder_id: 3 }), draft({ folder_id: 3 })),
  {},
  'Folder 未变化不制造 PATCH',
)
check(
  !isJournalUpdateEmpty(buildJournalUpdate(journal({ folder_id: 3 }), draft({ folder_id: null }))),
  '仅移出 Folder 的更新不算空更新',
)
expectEqual(
  buildJournalUpdate(journal(), draft({ title: '新标题', folder_id: 5 })),
  { title: '新标题', folder_id: 5 },
  'Folder 变化与标题变化可同时提交',
)

// ---- 时间字段永远不进入请求体 ----

const updateFromIdChange = buildJournalUpdate(
  journal(),
  draft({ title: '新标题' }),
)
check(!('id' in updateFromIdChange), '请求体不含 id')
check(!('created_at' in updateFromIdChange), '请求体不含 created_at')
check(!('updated_at' in updateFromIdChange), '请求体不含 updated_at')

// ---- 详情展示标题（Stage 1.5 / S1.5-T2）----

expectEqual(
  displayJournalTitle(null, '2026-10-02'),
  '2026-10-02',
  'title 为 null 时详情显示 journal_date',
)
expectEqual(
  displayJournalTitle('', '2026-10-02'),
  '2026-10-02',
  'title 为空字符串时详情显示 journal_date（旧行为会显示空行）',
)
expectEqual(
  displayJournalTitle('广州动物园复盘', '2026-10-02'),
  '广州动物园复盘',
  '有标题时原样显示',
)
expectEqual(
  displayJournalTitle('  手工标题  ', '2026-10-02'),
  '  手工标题  ',
  '非空标题不做 trim、原样显示',
)
expectEqual(
  displayJournalTitle('   ', '2026-10-02'),
  '   ',
  '纯空白手工标题原样显示，不退回日期',
)

// ---- 时间戳排版 ----

expectEqual(
  formatServerTimestamp('2026-10-06T09:33:15.123456+00:00'),
  '2026-10-06 09:33:15+00:00',
  '去掉小数秒，保留时区偏移',
)
expectEqual(
  formatServerTimestamp('2026-10-06T09:33:15+08:00'),
  '2026-10-06 09:33:15+08:00',
  '已是整秒时只替换分隔符',
)
expectEqual(
  formatServerTimestamp('2026-10-06T09:33:15'),
  '2026-10-06 09:33:15',
  '没有时区后缀时不补时区',
)
expectEqual(
  formatServerTimestamp('2026-10-06T09:33:15.5Z'),
  '2026-10-06 09:33:15Z',
  'Z 后缀被保留',
)
expectEqual(
  formatServerTimestamp('2026-10-06'),
  '2026-10-06',
  '只有日期的值原样返回',
)
expectEqual(
  formatServerTimestamp(''),
  '',
  '空字符串原样返回',
)

// 结论输出保持 ASCII，避免终端编码带来的干扰。
console.log(`journalDetail: ${passed} assertions passed`)
