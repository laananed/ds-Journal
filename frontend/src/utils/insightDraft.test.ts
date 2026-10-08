/**
 * Insight 纯逻辑测试（Stage 2 / S2-T06）。
 *
 * 不引入测试框架，直接运行：
 *
 *   node --experimental-strip-types src/utils/insightDraft.test.ts
 *
 * 断言只用 `throw`；调用的是 `insightDraft.ts` 里的真实函数。
 */

import {
  buildInsightCreate,
  buildInsightUpdate,
  isInsightUpdateEmpty,
  toInsightDraft,
  type InsightEditDraft,
} from './insightDraft.ts'
import type { Insight } from '../types/insight.ts'

let passed = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`${label}：期望 ${expectedText}，实际 ${actualText}`)
  }
  passed += 1
}

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label)
  passed += 1
}

/** 构造一条 Insight；只写出本文件关心的字段。 */
function insight(overrides: Partial<Insight> = {}): Insight {
  return {
    type: 'insight',
    id: 7,
    title: '原始标题',
    display_title: '原始标题',
    content: '原始正文',
    folder_id: null,
    created_at: '2026-10-08T09:33:15.123456Z',
    updated_at: '2026-10-08T09:33:15.123456Z',
    deleted_at: null,
    ...overrides,
  }
}

function draft(overrides: Partial<InsightEditDraft> = {}): InsightEditDraft {
  return { title: '原始标题', content: '原始正文', ...overrides }
}

// ---- toInsightDraft：把 null 标题显示成空串，绝不回退成展示标题 ----

expectEqual(toInsightDraft(insight({ title: null })), { title: '', content: '原始正文' }, 'null 标题显示为空串')
expectEqual(toInsightDraft(insight({ title: '' })), { title: '', content: '原始正文' }, '空串标题保持空串')
expectEqual(
  toInsightDraft(insight({ title: '  手工  ' })),
  { title: '  手工  ', content: '原始正文' },
  '非空标题保留原始空白',
)
expectEqual(
  toInsightDraft(insight({ title: null, display_title: '未命名 Insight' })),
  { title: '', content: '原始正文' },
  '不回退展示标题（display_title）到编辑框',
)

// ---- buildInsightCreate：空标题显式 null，非空原样提交 ----

expectEqual(
  buildInsightCreate({ title: '', content: '正文' }),
  { content: '正文', title: null },
  '空标题创建请求显式提交 title=null',
)
expectEqual(
  buildInsightCreate({ title: '原则一', content: '正文' }),
  { content: '正文', title: '原则一' },
  '非空标题原样提交',
)
expectEqual(
  buildInsightCreate({ title: '   ', content: '正文' }),
  { content: '正文', title: '   ' },
  '纯空白手工标题不 trim、原样提交',
)
check(
  !('folder_id' in buildInsightCreate({ title: '', content: '正文' })),
  '创建请求不携带 folder_id（本轮无 Folder 选择）',
)
check(
  !('journal_date' in buildInsightCreate({ title: '', content: '正文' })),
  '创建请求不携带任何日期字段',
)

// ---- buildInsightUpdate：只提交改动字段 ----

expectEqual(buildInsightUpdate(insight(), draft()), {}, '完全没有改动时请求体为空')
expectEqual(buildInsightUpdate(insight(), draft({ title: '新标题' })), { title: '新标题' }, '只改标题只提交 title')
expectEqual(buildInsightUpdate(insight(), draft({ content: '新正文' })), { content: '新正文' }, '只改正文只提交 content')
expectEqual(
  buildInsightUpdate(insight(), draft({ title: '新标题', content: '新正文' })),
  { title: '新标题', content: '新正文' },
  '两个字段同时改动时全部提交',
)
expectEqual(buildInsightUpdate(insight(), draft({ title: '' })), { title: null }, '清空已有标题提交 title=null')
expectEqual(buildInsightUpdate(insight({ title: null }), draft({ title: '' })), {}, '原文 null 且未编辑时不修改原值')
expectEqual(buildInsightUpdate(insight({ title: '' }), draft({ title: '' })), {}, '原文空串且未编辑时不修改原值')
expectEqual(buildInsightUpdate(insight({ title: '' }), draft({ title: '补标题' })), { title: '补标题' }, '空串标题改成字符串算改动')
expectEqual(
  buildInsightUpdate(insight({ content: '原文  ' }), draft({ content: '原文' })),
  { content: '原文' },
  '尾部空格变化是真实修改',
)
expectEqual(
  buildInsightUpdate(insight({ title: '  ' }), draft({ title: '  ' })),
  {},
  '纯空白标题未编辑时不算改动',
)

// 更新请求永远不携带日期、Daily 身份与系统字段。
const updateKeys = Object.keys(buildInsightUpdate(insight(), draft({ title: 'x', content: 'y' })))
check(!updateKeys.includes('journal_date'), '更新请求不含 journal_date')
check(!updateKeys.includes('inbox_date'), '更新请求不含 inbox_date')
check(!updateKeys.includes('is_daily'), '更新请求不含 is_daily')
check(!updateKeys.includes('id'), '更新请求不含 id')
check(!updateKeys.includes('type'), '更新请求不含 type')

// ---- isInsightUpdateEmpty ----
check(isInsightUpdateEmpty({}), '空对象判定为空更新')
check(!isInsightUpdateEmpty({ title: null }), '显式清空标题不算空更新')

console.log(`insightDraft: ${passed} assertions passed`)
