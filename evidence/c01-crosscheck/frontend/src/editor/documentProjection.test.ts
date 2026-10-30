/**
 * S04-T03 编辑器纯逻辑测试（不依赖浏览器）。
 *
 * 运行：`node --experimental-strip-types src/editor/documentProjection.test.ts`
 *
 * 覆盖四件事：
 * 1. 与后端共享的 golden fixtures（`tests/fixtures/stage4_documents/projections.json`）
 *    给出相同的 R / U —— 同一份样例，不在前端复制第二份；
 * 2. UTF-16 → Unicode 码点换算（锚点区间用码点）；
 * 3. 保存前归一化：只保留服务端白名单属性，不把 `id: null` 送成 422；
 * 4. 受保护边界：AI / 系统 / 旧文兼容节点的可改与不可改，必须与服务端
 *    `validate_author_changes` 的判定一致。
 *
 * 这里用真实的 ProseMirror 文档对象比较签名，不是对字符串做正则假设。
 */

import { readFileSync } from 'node:fs'
import { getSchema } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { generateUniqueIds } from '@tiptap/extension-unique-id'
import { projectDocument, userTextDocument, utf16ToCodePoint } from './documentProjection.ts'
import {
  buildExtensions,
  isSafeHref,
  protectedSignature,
  toEditorDocument,
  toServerDocument,
} from './schema.ts'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}\n  actual:   ${left}\n  expected: ${right}`)
}

// 1. 共享投影 fixtures -------------------------------------------------------
const cases = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/stage4_documents/projections.json', import.meta.url), 'utf8'),
) as { id: string; input: unknown; R: string; U: string }[]
for (const item of cases) {
  if (projectDocument(item.input) !== item.R || userTextDocument(item.input) !== item.U) {
    throw new Error(`projection fixture failed: ${item.id}`)
  }
}
console.log(`${cases.length} shared projection fixtures passed`)

// 2. 码点换算 ---------------------------------------------------------------
if (utf16ToCodePoint('甲😀乙', 3) !== 2) throw new Error('unicode offset conversion failed')
let rejected = false
try {
  utf16ToCodePoint('甲😀乙', 2)
} catch {
  rejected = true
}
if (!rejected) throw new Error('offset splitting surrogate pair was accepted')

// 3. 保存前归一化 -----------------------------------------------------------
const editorJson = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: null },
      content: [
        {
          type: 'text',
          text: '看这里',
          marks: [
            { type: 'link', attrs: { href: 'https://example.com/a', target: '_blank', rel: 'noopener', class: null } },
            { type: 'bold' },
          ],
        },
      ],
    },
    { type: 'heading', attrs: { id: null, level: 5 }, content: [{ type: 'text', text: '标题' }] },
    { type: 'text', text: '' },
    {
      type: 'taskList',
      attrs: { id: null },
      content: [
        { type: 'taskItem', attrs: { id: null, checked: false }, content: [{ type: 'paragraph', attrs: { id: null } }] },
      ],
    },
    {
      type: 'aiReply',
      attrs: { id: '11111111-1111-4111-8111-111111111111', request_id: '22222222-2222-4222-8222-222222222222' },
      content: [{ type: 'paragraph', attrs: { id: null }, content: [{ type: 'text', text: '回复' }] }],
    },
    {
      type: 'goalReview',
      attrs: {
        id: '33333333-3333-4333-8333-333333333333',
        link_id: null,
        goal_snapshot: '读书',
        checked_snapshot: false,
        review_title: '目标回顾：读书',
      },
      content: [{ type: 'paragraph', attrs: { id: null }, content: [{ type: 'text', text: '做到了' }] }],
    },
    {
      type: 'paragraph',
      attrs: { id: null },
      content: [{ type: 'text', text: '坏链接', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }],
    },
  ],
} as unknown as JSONContent

const serverDoc = toServerDocument(editorJson) as unknown as { content: Record<string, any>[] }
equal(serverDoc.content[0], {
  type: 'paragraph',
  content: [{ type: 'text', text: '看这里', marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }, { type: 'bold' }] }],
}, 'paragraph 应剥离 id:null，并只保留 link 的 href')
equal(serverDoc.content[1], { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '标题' }] }, 'heading.level 应夹到 1..3')
equal(serverDoc.content[2].type, 'taskList', '空文本节点应被丢弃')
equal(serverDoc.content[3].attrs, {
  id: '11111111-1111-4111-8111-111111111111',
  request_id: '22222222-2222-4222-8222-222222222222',
}, 'aiReply 必须保留 id 与 request_id')
equal(serverDoc.content[4].attrs.link_id, null, 'goalReview.link_id 允许为 null 且必须存在')
equal(serverDoc.content[5], { type: 'paragraph', content: [{ type: 'text', text: '坏链接' }] }, '不安全协议的 link Mark 应被剥离')

// 4. 受保护边界 -------------------------------------------------------------
const schema = getSchema(buildExtensions())
const doc = (content: unknown[]) => schema.nodeFromJSON({ type: 'doc', content } as JSONContent)
const reply = {
  type: 'aiReply',
  attrs: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', request_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '原始回复' }] }],
}
const summary = {
  type: 'aiSummary',
  attrs: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', request_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '原始总结' }] }],
}
const legacyUser = {
  type: 'legacyText',
  attrs: { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', raw_text: '旧文', author: 'user' },
}
const baseline = protectedSignature(doc([reply, summary, legacyUser]))

equal(protectedSignature(doc([reply, summary, legacyUser])), baseline, '同一文档签名必须稳定')

// aiReply 内容被改：拒绝（普通 PATCH 不得改 AI 回复正文）
const replyEdited = { ...reply, content: [{ type: 'paragraph', content: [{ type: 'text', text: '被改过' }] }] }
assert(protectedSignature(doc([replyEdited, summary, legacyUser])) !== baseline, 'aiReply 正文被改必须改变签名')

// aiSummary 正文可编辑，但来源不可改
const summaryEdited = { ...summary, content: [{ type: 'paragraph', content: [{ type: 'text', text: '用户改过' }] }] }
equal(protectedSignature(doc([reply, summaryEdited, legacyUser])), baseline, 'aiSummary 正文可编辑，不应改变签名')
const summaryResourced = { ...summary, attrs: { ...summary.attrs, request_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }
assert(protectedSignature(doc([reply, summaryResourced, legacyUser])) !== baseline, 'aiSummary 来源被改必须改变签名')

// 用户 legacyText 的 raw_text 可改，作者不可改
const legacyEdited = { ...legacyUser, attrs: { ...legacyUser.attrs, raw_text: '旧文（已改）' } }
equal(protectedSignature(doc([reply, summary, legacyEdited])), baseline, '用户 legacyText 原文可编辑，不应改变签名')
const legacyReauthored = { ...legacyUser, attrs: { ...legacyUser.attrs, author: 'ai' } }
assert(protectedSignature(doc([reply, summary, legacyReauthored])) !== baseline, 'legacyText 作者被改必须改变签名')

// 新增/删除受保护节点：拒绝
assert(protectedSignature(doc([reply, summary])) !== baseline, '删除 legacyText 必须改变签名')
assert(protectedSignature(doc([reply, summary, legacyUser, reply])) !== baseline, '伪造第二个 aiReply 必须改变签名')

// 受保护节点重排：服务端按 id 集合比较，不算改动
equal(protectedSignature(doc([summary, legacyUser, reply])), baseline, '受保护节点重排不应改变签名')

// 普通内容编辑与 Checklist 勾选：放行
const plain = { type: 'paragraph', content: [{ type: 'text', text: '普通' }] }
equal(protectedSignature(doc([plain, reply])), protectedSignature(doc([plain, reply])), '普通段落不参与签名')
const taskItem = (checked: boolean) => ({
  type: 'taskList',
  content: [{ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '待办' }] }] }],
})
equal(protectedSignature(doc([taskItem(true)])), protectedSignature(doc([taskItem(false)])), 'Checklist 勾选不应改变签名')

// 5. 链接白名单 -------------------------------------------------------------
assert(isSafeHref('https://example.com'), 'https 应允许')
assert(isSafeHref('mailto:a@example.com'), 'mailto 应允许')
assert(!isSafeHref('javascript:alert(1)'), 'javascript: 必须拒绝')
assert(!isSafeHref('data:text/html;base64,xx'), 'data: 必须拒绝')
assert(!isSafeHref('www.example.com'), '缺少协议的链接必须拒绝（与服务端 urlsplit 一致）')
assert(!isSafeHref('https://example.com/a b'), '含空格的链接必须拒绝')
assert(!isSafeHref(''), '空链接必须拒绝')

// 6. 文档装载与 ID 生成 -----------------------------------------------------
equal(toEditorDocument({ type: 'doc', content: [] }), { type: 'doc', content: [{ type: 'paragraph' }] }, '空文档应补一个可放光标的段落')
equal(toEditorDocument(null), { type: 'doc', content: [{ type: 'paragraph' }] }, 'null 文档应回退到空文档')

const withoutIds = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: '甲' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '乙' }] }] }] },
    reply,
  ],
} as unknown as JSONContent
const withIds = generateUniqueIds(withoutIds, buildExtensions()) as unknown as { content: Record<string, any>[] }
const ids = [withIds.content[0].attrs?.id, withIds.content[1].attrs?.id, withIds.content[1].content[0].attrs?.id]
for (const id of ids) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`基础块应获得 UUID，实际为 ${String(id)}`)
  }
}
if (new Set(ids).size !== ids.length) throw new Error('节点 ID 必须唯一')
equal(withIds.content[2].attrs.id, reply.attrs.id, '服务端已有的专用节点 ID 不得被重写')

// 只读模式只补 ID 到「不落库」：UniqueID 的 updateDocument 必须关闭
const readOnlyUniqueId = buildExtensions({ readOnly: true }).find((extension) => extension.name === 'uniqueID')
equal(readOnlyUniqueId?.options?.updateDocument, false, '只读模式不得自动补 ID')
const editableUniqueId = buildExtensions().find((extension) => extension.name === 'uniqueID')
equal(editableUniqueId?.options?.updateDocument, true, '编辑模式应自动补 ID')

console.log('editor schema, guard signature and id rules passed')
