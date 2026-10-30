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
  blankInsightDraft,
  buildInsightCreate,
  buildInsightUpdate,
  documentPlainText,
  emptyInsightDocument,
  insightCreatePayload,
  insightDraftIssue,
  insightDraftSavable,
  insightEditingDocument,
  insightToDraft,
  insightUpdatePayload,
  isContentDocument,
  isExactLegacyDocument,
  isInsightUpdateEmpty,
  legacyTextDocument,
  seedInsightDraft,
  textToDocument,
  toInsightDraft,
  type InsightEditDraft,
} from './insightDraft.ts'
import type { Insight } from '../types/insight.ts'
import type { ContentDocument } from '../types/document.ts'

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
    revision: 1,
    folder_id: null,
    created_at: '2026-10-08T09:33:15.123456Z',
    updated_at: '2026-10-08T09:33:15.123456Z',
    deleted_at: null,
    ...overrides,
  }
}

function draft(overrides: Partial<InsightEditDraft> = {}): InsightEditDraft {
  return { title: '原始标题', content: '原始正文', folder_id: null, ...overrides }
}

// ---- toInsightDraft：把 null 标题显示成空串，绝不回退成展示标题 ----

expectEqual(toInsightDraft(insight({ title: null })), { title: '', content: '原始正文', folder_id: null }, 'null 标题显示为空串')
expectEqual(toInsightDraft(insight({ title: '' })), { title: '', content: '原始正文', folder_id: null }, '空串标题保持空串')
expectEqual(
  toInsightDraft(insight({ title: '  手工  ' })),
  { title: '  手工  ', content: '原始正文', folder_id: null },
  '非空标题保留原始空白',
)
expectEqual(
  toInsightDraft(insight({ title: null, display_title: '未命名 Insight' })),
  { title: '', content: '原始正文', folder_id: null },
  '不回退展示标题（display_title）到编辑框',
)
expectEqual(
  toInsightDraft(insight({ folder_id: 5 })),
  { title: '原始标题', content: '原始正文', folder_id: 5 },
  '草稿保留原始 folder_id',
)

// ---- buildInsightCreate：空标题显式 null，非空原样提交 ----

expectEqual(buildInsightCreate(draft({ folder_id: 5 })).folder_id, 5, 'Insight 创建提交所选 Folder')
expectEqual(buildInsightCreate(draft()).folder_id, null, 'Insight 创建可显式选择无 Folder')

expectEqual(
  buildInsightCreate({ title: '', content: '正文', folder_id: null }),
  { content: '正文', title: null, folder_id: null },
  '空标题创建请求显式提交 title=null',
)
expectEqual(
  buildInsightCreate({ title: '原则一', content: '正文', folder_id: null }),
  { content: '正文', title: '原则一', folder_id: null },
  '非空标题原样提交',
)
expectEqual(
  buildInsightCreate({ title: '   ', content: '正文', folder_id: null }),
  { content: '正文', title: '   ', folder_id: null },
  '纯空白手工标题不 trim、原样提交',
)
check(
  buildInsightCreate({ title: '', content: '正文', folder_id: null }).folder_id === null,
  '无 Folder 创建请求显式携带 folder_id=null',
)
check(
  !('journal_date' in buildInsightCreate({ title: '', content: '正文', folder_id: null })),
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

// ---- buildInsightUpdate：Folder 差异（S2-T08）----

expectEqual(buildInsightUpdate(insight({ folder_id: 3 }), draft({ folder_id: 5 })), { folder_id: 5 }, 'Folder 变化提交新 id')
expectEqual(buildInsightUpdate(insight({ folder_id: 3 }), draft({ folder_id: null })), { folder_id: null }, '移出 Folder 显式提交 null')
expectEqual(buildInsightUpdate(insight({ folder_id: null }), draft({ folder_id: 3 })), { folder_id: 3 }, '移入 Folder 提交目标 id')
expectEqual(buildInsightUpdate(insight({ folder_id: 3 }), draft({ folder_id: 3 })), {}, 'Folder 未变化不制造 PATCH')
check(
  !isInsightUpdateEmpty(buildInsightUpdate(insight({ folder_id: 3 }), draft({ folder_id: null }))),
  '仅移出 Folder 的更新不算空更新',
)

// ---- isInsightUpdateEmpty ----
check(isInsightUpdateEmpty({}), '空对象判定为空更新')
check(!isInsightUpdateEmpty({ title: null }), '显式清空标题不算空更新')

/* ------------------------------- Stage 4 正文 JSON（S04-T11） */

// ---- textToDocument / documentPlainText：逐行逐字往返 ----

for (const text of [
  '第一行\n第二行',
  '观点\n\n## 依据\n> 来源：journal:12\n> 原文引用',
  '带 [[内部标题]] 与 `反引号` 与 *星号*\n\n末尾空行在这\n',
  '单个 emoji 🙂 与全角　空白',
  '  前后空格不 trim  ',
]) {
  expectEqual(documentPlainText(textToDocument(text)), text, `文本往返逐字不变：${JSON.stringify(text)}`)
}

// 空串得到单个空段落：文档合法，但纯文本投影为空（服务端同样判为空白正文）。
expectEqual(textToDocument('').content.length, 1, '空文本得到一个段落')
expectEqual(documentPlainText(textToDocument('')), '', '空文本投影为空串')

// 非文档输入不猜测内容。
expectEqual(documentPlainText(null), '', 'null 文档投影为空串')
expectEqual(documentPlainText({ type: 'paragraph' }), '', '非 doc 根不投影')
check(isContentDocument(emptyInsightDocument()), '空草稿是合法 doc 形状')
check(!isContentDocument({ type: 'doc' }), '缺少 content 数组不算 doc')

// 每次返回新对象：调用方改内容不会污染"空草稿"常量。
const firstEmpty = emptyInsightDocument()
firstEmpty.content.push({ type: 'paragraph' })
expectEqual(emptyInsightDocument().content.length, 1, '空草稿不被上一次修改污染')

// ---- legacyTextDocument / isExactLegacyDocument：等价转换口径 ----

const legacyDoc = legacyTextDocument('旧正文\n第二行', '11111111-1111-4111-8111-111111111111')
expectEqual(
  legacyDoc,
  {
    type: 'doc',
    content: [{
      type: 'legacyText',
      attrs: { id: '11111111-1111-4111-8111-111111111111', raw_text: '旧正文\n第二行', author: 'user' },
    }],
  },
  '旧文转换文档：单个 user legacyText，原文逐字',
)
check(isExactLegacyDocument(legacyDoc, '旧正文\n第二行'), '原文相同的转换文档被判定为等价')
check(!isExactLegacyDocument(legacyDoc, '旧正文\n第二行改了一个字'), '原文不同不算等价转换')
check(!isExactLegacyDocument({
  type: 'doc',
  content: [
    { type: 'legacyText', attrs: { id: '11111111-1111-4111-8111-111111111111', raw_text: 'x', author: 'ai' } },
  ],
} as ContentDocument, 'x'), 'AI 作者的旧文段不算等价转换')
check(!isExactLegacyDocument({
  type: 'doc',
  content: [
    { type: 'legacyText', attrs: { id: '11111111-1111-4111-8111-111111111111', raw_text: 'x', author: 'user' } },
    { type: 'paragraph', content: [{ type: 'text', text: '新增段落' }] },
  ],
} as ContentDocument, 'x'), '转换后再加段落不再是原样转换')
check(!isExactLegacyDocument(null, 'x'), '空文档不是等价转换')

// ---- insightEditingDocument / insightToDraft ----

const legacyInsight = insight({ content_doc: null, document_format: 'legacy' })
expectEqual(
  documentPlainText(insightEditingDocument(legacyInsight, '22222222-2222-4222-8222-222222222222')),
  '原始正文',
  '旧格式 Insight 载入为原文逐字的 legacyText 文档',
)
check(
  isExactLegacyDocument(insightEditingDocument(legacyInsight, '22222222-2222-4222-8222-222222222222'), '原始正文'),
  '旧格式载入文档满足等价转换口径',
)

const docInsight = insight({
  content_doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '已转换' }] }] },
  document_format: 'tiptap',
})
const loaded = insightEditingDocument(docInsight, '33333333-3333-4333-8333-333333333333')
expectEqual(documentPlainText(loaded), '已转换', 'tiptap Insight 载入原 content_doc')
check(loaded !== docInsight.content_doc, '载入时深拷贝，不与响应对象共享结构')

expectEqual(
  insightToDraft(insight({ title: null, folder_id: 4, content_doc: null }), '44444444-4444-4444-8444-444444444444'),
  {
    title: '',
    content_doc: legacyTextDocument('原始正文', '44444444-4444-4444-8444-444444444444'),
    date: '',
    folder_id: 4,
  },
  'Insight 草稿：标题 null 显示为空串，没有业务日期',
)

expectEqual(blankInsightDraft(), { title: '', content_doc: emptyInsightDocument(), date: '', folder_id: null }, '空白草稿')

// ---- insightDraftIssue / insightDraftSavable ----

expectEqual(insightDraftIssue(blankInsightDraft()), 'blank', '空白草稿不可提交')
expectEqual(insightDraftIssue(seedInsightDraft({
  title: 't', content: '   ', folder_id: null, createKey: 'k', userNotes: '', draftId: '', viewpoint: '',
  keyword: '', evidenceCount: 0, evidenceLines: [],
})), 'blank', '纯空白正文不可提交')
expectEqual(insightDraftIssue(seedInsightDraft({
  title: '', content: '一句话', folder_id: null, createKey: 'k', userNotes: '', draftId: '', viewpoint: '',
  keyword: '', evidenceCount: 0, evidenceLines: [],
})), '', '标题为空但正文有内容可提交')
expectEqual(
  insightDraftIssue({ ...blankInsightDraft(), content_doc: textToDocument('a'.repeat(50_000)) }),
  '',
  '50000 码点仍在限内',
)
expectEqual(
  insightDraftIssue({ ...blankInsightDraft(), content_doc: textToDocument('a'.repeat(50_001)) }),
  'too_long',
  '超过 50000 码点本地不提交',
)
check(insightDraftSavable({ ...blankInsightDraft(), content_doc: textToDocument('x') }), 'isSavable 与 issue 同口径')
check(!insightDraftSavable(blankInsightDraft()), '空白草稿 isSavable 为 false')

// ---- 创建 / 更新 payload：只走 content_doc ----

const created = insightCreatePayload({ ...blankInsightDraft(), title: '', content_doc: textToDocument('正文') }, 'key-1')
expectEqual(created, {
  title: null,
  content_doc: textToDocument('正文'),
  document_schema_version: 1,
  folder_id: null,
  client_create_id: 'key-1',
}, '创建请求：空标题提交 null，正文只发 content_doc')
check(!('content' in created), '创建请求不携带旧 content')
check(!('content_blocks' in created), '创建请求不携带 content_blocks')

expectEqual(insightUpdatePayload({ title: 'x' }, 3), { expected_revision: 3, title: 'x' }, '仅标题的 PATCH 不带文档版本')
expectEqual(
  insightUpdatePayload({ title: null, content_doc: textToDocument('新正文'), folder_id: null, journal_date: '' }, 5),
  {
    expected_revision: 5,
    title: null,
    content_doc: textToDocument('新正文'),
    document_schema_version: 1,
    folder_id: null,
  },
  '带正文的 PATCH 附文档版本，且从不提交 journal_date',
)

// ---- seedInsightDraft：AI 草稿种子进入统一编辑器 ----

const seedDraft = seedInsightDraft({
  title: '我怕让人失望',
  content: '我怕让人失望\n\n## 依据\n> 来源：journal:12\n> 我总在答应之后拖延',
  folder_id: 9,
  createKey: 'seed-key',
  userNotes: '',
  draftId: '55555555-5555-4555-8555-555555555555',
  viewpoint: '我怕让人失望',
  keyword: '我怕让人失望',
  evidenceCount: 1,
  evidenceLines: [{ source: 'journal:12', quote: '我总在答应之后拖延' }],
})
expectEqual(seedDraft.title, '我怕让人失望', '种子标题进入草稿')
expectEqual(seedDraft.folder_id, 9, '种子 Folder 进入草稿')
expectEqual(
  documentPlainText(seedDraft.content_doc),
  '我怕让人失望\n\n## 依据\n> 来源：journal:12\n> 我总在答应之后拖延',
  '种子正文逐字进入文档（Markdown 记号仍由阅读投影渲染）',
)

console.log(`insightDraft: ${passed} assertions passed`)
