/**
 * Inbox 纯逻辑测试（Stage 2 / S2-T05）。
 *
 * 不引入测试框架，直接运行：
 *
 *   node --experimental-strip-types src/utils/inboxDraft.test.ts
 *
 * 断言只用 `throw`；调用的是 `inboxDraft.ts` 里的真实函数。
 */

import {
  buildInboxCreate,
  buildInboxUpdate,
  planDailyEntry,
  toInboxDraft,
  type InboxEditDraft,
} from './inboxDraft.ts'
import type { Inbox } from '../types/inbox.ts'

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

/** 构造一条 Inbox；只写出本文件关心的字段。 */
function inbox(overrides: Partial<Inbox> = {}): Inbox {
  return {
    type: 'inbox',
    id: 7,
    title: '原始标题',
    display_title: '原始标题',
    content: '原始正文',
    inbox_date: '2026-10-08',
    is_daily: false,
    folder_id: null,
    created_at: '2026-10-08T09:33:15.123456Z',
    updated_at: '2026-10-08T09:33:15.123456Z',
    deleted_at: null,
    ...overrides,
  }
}

function draft(overrides: Partial<InboxEditDraft> = {}): InboxEditDraft {
  return { title: '原始标题', content: '原始正文', ...overrides }
}

// ---- toInboxDraft：把 null 标题显示成空串，绝不回退成日期 ----

expectEqual(toInboxDraft(inbox({ title: null })), { title: '', content: '原始正文' }, 'null 标题显示为空串')
expectEqual(toInboxDraft(inbox({ title: '' })), { title: '', content: '原始正文' }, '空串标题保持空串')
expectEqual(
  toInboxDraft(inbox({ title: '  手工  ' })),
  { title: '  手工  ', content: '原始正文' },
  '非空标题保留原始空白',
)

// ---- buildInboxCreate：省略 → 默认日期标题；主动清空 → 显式 null ----

expectEqual(
  buildInboxCreate({ title: '', content: '正文' }, { inboxDate: '2026-10-08', isDaily: true, titleEdited: false }),
  { content: '正文', inbox_date: '2026-10-08', is_daily: true },
  '未编辑标题的创建请求不含 title（后端存日期默认标题）',
)
check(
  !('title' in buildInboxCreate({ title: '', content: '正文' }, { inboxDate: '2026-10-08', isDaily: false, titleEdited: false })),
  '未编辑标题时不携带 title 键',
)
expectEqual(
  buildInboxCreate({ title: 'AI培训待办', content: 'x' }, { inboxDate: '2026-10-08', isDaily: false, titleEdited: true }),
  { content: 'x', inbox_date: '2026-10-08', is_daily: false, title: 'AI培训待办' },
  '编辑过的标题原样提交',
)
expectEqual(
  buildInboxCreate({ title: '   ', content: 'x' }, { inboxDate: '2026-10-08', isDaily: false, titleEdited: true }),
  { content: 'x', inbox_date: '2026-10-08', is_daily: false, title: '   ' },
  '纯空白手工标题不 trim、原样提交',
)
expectEqual(
  buildInboxCreate({ title: '', content: 'x' }, { inboxDate: '2026-10-08', isDaily: false, titleEdited: true }),
  { content: 'x', inbox_date: '2026-10-08', is_daily: false, title: null },
  '编辑后清空的标题显式提交 null，不能省略成默认创建',
)
expectEqual(
  buildInboxCreate({ title: '', content: '正文' }, { inboxDate: '2026-10-08', isDaily: true, titleEdited: false }).is_daily,
  true,
  'Daily 创建携带 is_daily=true',
)
expectEqual(
  buildInboxCreate({ title: '', content: '正文' }, { inboxDate: '2026-10-08', isDaily: false, titleEdited: false }).is_daily,
  false,
  '普通 Inbox 创建携带 is_daily=false',
)

// ---- buildInboxUpdate：只提交改动字段 ----

expectEqual(buildInboxUpdate(inbox(), draft()), {}, '完全没有改动时请求体为空')
expectEqual(buildInboxUpdate(inbox(), draft({ title: '新标题' })), { title: '新标题' }, '只改标题只提交 title')
expectEqual(buildInboxUpdate(inbox(), draft({ content: '新正文' })), { content: '新正文' }, '只改正文只提交 content')
expectEqual(
  buildInboxUpdate(inbox(), draft({ title: '新标题', content: '新正文' })),
  { title: '新标题', content: '新正文' },
  '两个字段同时改动时全部提交',
)
expectEqual(buildInboxUpdate(inbox(), draft({ title: '' })), { title: null }, '清空已有标题提交 title=null')
expectEqual(buildInboxUpdate(inbox({ title: null }), draft({ title: '' })), {}, '原文 null 且未编辑时不修改原值')
expectEqual(buildInboxUpdate(inbox({ title: '' }), draft({ title: '' })), {}, '原文空串且未编辑时不修改原值')
expectEqual(buildInboxUpdate(inbox({ title: '' }), draft({ title: '补标题' })), { title: '补标题' }, '空串标题改成字符串算改动')
expectEqual(
  buildInboxUpdate(inbox({ content: '原文  ' }), draft({ content: '原文' })),
  { content: '原文' },
  '尾部空格变化是真实修改',
)
expectEqual(
  buildInboxUpdate(inbox({ title: '  ' }), draft({ title: '  ' })),
  {},
  '纯空白标题未编辑时不算改动',
)

// 更新请求永远不携带日期与 Daily 身份。
const updateKeys = Object.keys(buildInboxUpdate(inbox(), draft({ title: 'x', content: 'y' })))
check(!updateKeys.includes('inbox_date'), '更新请求不含 inbox_date')
check(!updateKeys.includes('is_daily'), '更新请求不含 is_daily')
check(!updateKeys.includes('id'), '更新请求不含 id')

// ---- planDailyEntry：active 复用、missing 走空编辑器 ----

expectEqual(
  planDailyEntry({ state: 'active', id: 42, file: inbox({ id: 42 }) }),
  { kind: 'existing', id: 42 },
  'active 复用已有 Daily 的记录 id',
)
expectEqual(planDailyEntry({ state: 'missing', id: null, file: null }), { kind: 'missing' }, 'missing 进入空编辑器')
expectEqual(
  planDailyEntry({ state: 'active', id: null, file: null }),
  { kind: 'missing' },
  'active 但缺少 id 的异常响应按 missing 处理',
)

console.log(`inboxDraft: ${passed} assertions passed`)
