/**
 * Stage 4 / S04-T03：统一的 Tiptap schema 1 装配与两条边界。
 *
 * 这个文件是前端唯一声明「本项目正文长什么样」的地方，与
 * `docs/stage4-api.md` §2/§2.1 的节点表一一对应；作者权限的最终裁决
 * 仍在服务端 `backend/app/writing/documents.py`，前端只负责不制造
 * 服务端一定会拒绝的文档，并在本地拦住明显越权的编辑。
 *
 * 三个关键约定：
 *
 * 1. **序列化归口**：`editor.getJSON()` 会带上 Tiptap 的全量属性
 *    （未生成的 `id: null`、`link` 的 `target/rel/class` 等），
 *    而服务端只接受白名单属性。`toServerDocument()` 是保存前唯一的
 *    转换入口，避免把 `attrs: {id: null}` 送成 422。
 * 2. **受保护边界**：AI/系统/旧文兼容节点由服务端创建，普通 PATCH 不得
 *    增删改。`DocumentGuards` 用「受保护签名」比较事务前后的文档，
 *    而不是逐条分析 step，规则简单且可测。
 * 3. **粘贴不授予身份**：外部剪贴板一律按用户输入处理，AI/系统节点被
 *    降级为普通段落文字，评论 Mark 与节点 ID 一并剥离。
 */

import { Extension } from '@tiptap/core'
import type { Extensions, JSONContent } from '@tiptap/core'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { UniqueID } from '@tiptap/extension-unique-id'
import StarterKit from '@tiptap/starter-kit'
import { Fragment, Slice } from '@tiptap/pm/model'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { ContentDocument, Mark } from '../types/document.ts'
import { AiPlaceholder } from './extensions/AiPlaceholder.ts'
import { AiReply } from './extensions/AiReply.ts'
import { AiSummary } from './extensions/AiSummary.ts'
import { GoalItem } from './extensions/GoalItem.ts'
import { GoalReview } from './extensions/GoalReview.ts'
import { LegacyText } from './extensions/LegacyText.ts'
import { LegacyBlocks } from './extensions/LegacyBlocks.ts'
import { MindComment } from './extensions/MindComment.ts'
import { RitualQuestion } from './extensions/RitualQuestion.ts'

/** 与后端 `document_schema_version` 对齐；格式不匹配由服务端 422。 */
export const DOCUMENT_SCHEMA_VERSION = 1 as const

/**
 * 系统来源标记：程序化替换文档（加载服务端详情、后续 AI apply）必须带上它，
 * 否则会被 `DocumentGuards` 当成用户伪造受保护节点而拒绝。
 * 对应架构 §7.3 的 `origin=system`。
 */
export const SYSTEM_ORIGIN = 'stage4System'

/** 只有这些节点由服务端创建/维护，用户侧不得增删改。 */
export const SERVER_OWNED_TYPES = new Set([
  'aiReply',
  'aiSummary',
  'aiPlaceholder',
  'ritualQuestion',
  'goalItem',
  'goalReview',
  'legacyText',
  'legacyBlocks',
])

/** 需要稳定 `id` 的基础块；`text`/`hardBreak` 不分配 ID（API §2.1）。 */
export const ID_NODE_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
] as const

/** 新建空白正文：ProseMirror 需要一个可放光标的块。 */
export const EMPTY_DOCUMENT: ContentDocument = { type: 'doc', content: [{ type: 'paragraph' }] }

const BASIC_ATTR_KEYS: Record<string, readonly string[]> = {
  heading: ['level'],
  orderedList: ['start'],
  taskItem: ['checked'],
  codeBlock: ['language'],
}

/** 专用节点必须带齐这些属性（服务端要求与声明完全一致）。 */
const SPECIAL_ATTR_KEYS: Record<string, readonly string[]> = {
  aiReply: ['id', 'request_id'],
  aiSummary: ['id', 'request_id'],
  aiPlaceholder: ['id', 'request_id'],
  ritualQuestion: ['id', 'template_question_id', 'question_snapshot'],
  goalItem: ['id', 'goal_id', 'text', 'checked'],
  goalReview: ['id', 'link_id', 'goal_snapshot', 'checked_snapshot', 'review_title'],
  legacyText: ['id', 'raw_text', 'author'],
  legacyBlocks: ['id', 'format_version', 'blocks'],
}

const SPECIAL_ATTR_DEFAULTS: Record<string, Record<string, unknown>> = {
  ritualQuestion: { question_snapshot: '' },
  goalItem: { text: '', checked: false },
  goalReview: { goal_snapshot: '', checked_snapshot: false, review_title: '' },
  legacyText: { raw_text: '', author: 'user' },
}

const ATOMIC_TYPES = new Set(['hardBreak', 'horizontalRule', 'aiPlaceholder', 'ritualQuestion', 'goalItem', 'legacyText', 'legacyBlocks'])
const SIMPLE_MARKS = new Set(['bold', 'italic', 'strike', 'code'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type LooseNode = { type: string } & Record<string, unknown>

/** 与服务端 `urlsplit(href).scheme in (http, https, mailto)` + 无控制字符一致。 */
export function isSafeHref(href: unknown): boolean {
  if (typeof href !== 'string' || href.length === 0) return false
  // 对应 Python `any(ord(c) <= 32 for c in href)`：空白与控制字符一律拒绝。
  for (let index = 0; index < href.length; index += 1) {
    if (href.charCodeAt(index) <= 0x20) return false
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href)
  return match !== null && ['http', 'https', 'mailto'].includes(match[1].toLowerCase())
}

function serverMarks(marks: readonly { type: string; attrs?: Record<string, unknown> }[] | undefined): Mark[] | undefined {
  const result: Mark[] = []
  for (const mark of marks ?? []) {
    if (SIMPLE_MARKS.has(mark.type)) {
      result.push({ type: mark.type as 'bold' | 'italic' | 'strike' | 'code' })
    } else if (mark.type === 'link' && isSafeHref(mark.attrs?.href)) {
      result.push({ type: 'link', attrs: { href: String(mark.attrs?.href) } })
    } else if (mark.type === 'mindComment') {
      const raw = mark.attrs?.comment_ids
      const ids = Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === 'string' && UUID_PATTERN.test(value))
        : []
      const unique = [...new Set(ids)]
      if (unique.length > 0) result.push({ type: 'mindComment', attrs: { comment_ids: unique } })
    }
  }
  return result.length > 0 ? result : undefined
}

function serverAttrs(type: string, attrs: Record<string, unknown>): Record<string, unknown> | undefined {
  const specialKeys = SPECIAL_ATTR_KEYS[type]
  if (specialKeys !== undefined) {
    const defaults = SPECIAL_ATTR_DEFAULTS[type] ?? {}
    const result: Record<string, unknown> = {}
    for (const key of specialKeys) {
      // 允许为 null 的身份字段（template_question_id / link_id）保持 null，
      // 其余缺失走默认值；真正的必填校验在服务端。
      result[key] = attrs[key] ?? defaults[key] ?? null
    }
    return result
  }
  const result: Record<string, unknown> = {}
  if (typeof attrs.id === 'string' && UUID_PATTERN.test(attrs.id)) result.id = attrs.id
  for (const key of BASIC_ATTR_KEYS[type] ?? []) {
    const value = attrs[key]
    if (key === 'level' && typeof value === 'number') result.level = Math.min(3, Math.max(1, Math.trunc(value)))
    else if (key === 'start' && typeof value === 'number' && value >= 1) result.start = Math.trunc(value)
    else if (key === 'checked' && typeof value === 'boolean') result.checked = value
    else if (key === 'language' && typeof value === 'string' && value.length > 0) result.language = value
  }
  // taskItem.checked 与 heading.level 在服务端是必填的强类型属性。
  if (type === 'taskItem' && typeof result.checked !== 'boolean') result.checked = false
  if (type === 'heading' && typeof result.level !== 'number') result.level = 1
  return Object.keys(result).length > 0 ? result : undefined
}

function serverNode(node: JSONContent): LooseNode | null {
  const type = typeof node.type === 'string' ? node.type : ''
  const attrs = (node.attrs ?? {}) as Record<string, unknown>
  if (type === 'text') {
    const text = typeof node.text === 'string' ? node.text : ''
    if (text.length === 0) return null
    const marks = serverMarks(node.marks as { type: string; attrs?: Record<string, unknown> }[] | undefined)
    return marks === undefined ? { type: 'text', text } : { type: 'text', text, marks }
  }
  const cleanAttrs = serverAttrs(type, attrs)
  if (ATOMIC_TYPES.has(type)) {
    return cleanAttrs === undefined ? { type } : { type, attrs: cleanAttrs }
  }
  const content: LooseNode[] = []
  for (const child of node.content ?? []) {
    const converted = serverNode(child)
    if (converted !== null) content.push(converted)
  }
  return cleanAttrs === undefined ? { type, content } : { type, attrs: cleanAttrs, content }
}

/**
 * 把编辑器 JSON 转成服务端 `content_doc` 形状。
 *
 * 只保留 API §2.1 白名单内的节点/属性/Mark：剥离 `id: null`、链接的
 * `target/rel/class`、空文本节点与非法协议链接。保存前必须走这里。
 */
export function toServerDocument(document: JSONContent): ContentDocument {
  const content: LooseNode[] = []
  for (const node of document.content ?? []) {
    const converted = serverNode(node)
    if (converted !== null) content.push(converted)
  }
  return { type: 'doc', content } as unknown as ContentDocument
}

/**
 * 把服务端 `content_doc` 转成编辑器可加载的 JSON。
 *
 * 服务端允许 `content: []`（空文档合法），但 ProseMirror 需要一个可放置
 * 光标的块，因此空文档替换为 `EMPTY_DOCUMENT`。结构合法性仍由服务端
 * 契约保证，这里不重复实现一套校验器。
 */
export function toEditorDocument(document: unknown): JSONContent {
  const candidate = document as { type?: unknown; content?: unknown } | null | undefined
  if (candidate === null || typeof candidate !== 'object' || candidate.type !== 'doc'
    || !Array.isArray(candidate.content) || candidate.content.length === 0) {
    return JSON.parse(JSON.stringify(EMPTY_DOCUMENT)) as JSONContent
  }
  return JSON.parse(JSON.stringify(document)) as JSONContent
}

/**
 * 受保护部分的签名：同一份文档同样的受保护内容 → 同样的字符串。
 *
 * 规则与 `documents.py::validate_author_changes` 一致：
 * - 只比较服务端专用节点（按内容排序，所以重排不算改动）；
 * - `aiSummary` / `goalReview` 的 content 是用户可写的，只比较属性；
 * - 用户 `legacyText` 的 `raw_text` 可编辑，只比较 `id` / `author`；
 *   其余专用节点连内容一起比较。
 */
export function protectedSignature(document: PMNode): string {
  const entries: string[] = []
  document.descendants((node) => {
    const type = node.type.name
    if (!SERVER_OWNED_TYPES.has(type)) return true
    const attrs: Record<string, unknown> = {}
    for (const key of Object.keys(node.attrs).sort()) attrs[key] = (node.attrs as Record<string, unknown>)[key]
    if (type === 'legacyText' && attrs.author === 'user') delete attrs.raw_text
    if (type === 'legacyBlocks' && Array.isArray(attrs.blocks)) attrs.blocks = attrs.blocks.map((block: Record<string, unknown>) => {
      const copy = { ...block }; if (copy.kind === 'user' || copy.kind === 'ai_summary') delete copy.text; return copy
    })
    const editableContent = type === 'aiSummary' || type === 'goalReview'
    const content = editableContent ? null : ((node.toJSON() as { content?: unknown }).content ?? null)
    entries.push(JSON.stringify([type, attrs, content]))
    return false
  })
  return entries.sort().join('\n')
}

function stripMarks(node: PMNode, schema: Schema): PMNode {
  let changed = false
  const marks = node.marks.filter((mark) => {
    const keep = mark.type.name !== 'mindComment'
      && (mark.type.name !== 'link' || isSafeHref(mark.attrs.href))
    if (!keep) changed = true
    return keep
  })
  if (!changed) return node
  return node.isText ? schema.text(node.text ?? '', marks) : node.mark(marks)
}

function sanitizeFragment(fragment: Fragment, schema: Schema): Fragment {
  const nodes: PMNode[] = []
  fragment.forEach((node) => {
    const type = node.type.name
    if (SERVER_OWNED_TYPES.has(type)) {
      // 外部/跨文档粘贴不授予 AI 或系统身份，只保留可读文字。
      const text = node.textContent
      if (text.length > 0) nodes.push(schema.nodes.paragraph.create(null, schema.text(text)))
      return
    }
    if (node.isText) {
      const clean = stripMarks(node, schema)
      if ((clean.text ?? '').length > 0) nodes.push(clean)
      return
    }
    const content = sanitizeFragment(node.content, schema)
    const attrs: Record<string, unknown> = { ...node.attrs }
    if ((ID_NODE_TYPES as readonly string[]).includes(type)) attrs.id = null
    nodes.push(stripMarks(node.type.create(attrs, content), schema))
  })
  return Fragment.fromArray(nodes)
}

function sanitizePastedSlice(slice: Slice, schema: Schema): Slice {
  return new Slice(sanitizeFragment(slice.content, schema), slice.openStart, slice.openEnd)
}

/**
 * 编辑器事务守卫：拒绝任何改动受保护节点的事务。
 *
 * 之所以在事务层拒绝而不是只在服务端拒绝：服务端 `validate_author_changes`
 * 会对「受保护节点被改」整体报错，若前端放行，用户会先丢掉这次输入再看到
 * 保存失败。这里让编辑当场不生效，界面与持久化保持一致。
 */
const DocumentGuards = Extension.create({
  name: 'documentGuards',
  // 高于 UniqueID（10000）：粘贴清洗要先于其他 transformPasted 生效。
  priority: 20_000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('stage4DocumentGuards'),
        filterTransaction: (transaction) => {
          if (!transaction.docChanged) return true
          // 系统来源（加载详情、AI apply）与 UniqueID 补 ID 的合成事务放行。
          if (transaction.getMeta(SYSTEM_ORIGIN) === true) return true
          if (transaction.getMeta('__uniqueIDTransaction') === true) return true
          // Transform.before / .doc 是事务前后的文档快照。
          return protectedSignature(transaction.before) === protectedSignature(transaction.doc)
        },
        props: {
          transformPasted: (slice) => sanitizePastedSlice(slice, this.editor.schema),
        },
      }),
    ]
  },
})

export interface EditorExtensionOptions {
  /** 只读模式不补 ID、不落库（API §1：GET 零写）。 */
  readOnly?: boolean
}

/**
 * 统一扩展集：普通 Journal、开始今天、结束今天、Insight 共用同一份 schema。
 *
 * StarterKit 自带的 `underline` 在本项目 schema 中不存在，必须显式关闭，
 * 否则用户能造出服务端一定拒绝的 Mark。
 */
export function buildExtensions({ readOnly = false }: EditorExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      underline: false,
      trailingNode: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto'],
        isAllowedUri: (url) => isSafeHref(url),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    UniqueID.configure({
      types: [...ID_NODE_TYPES],
      updateDocument: !readOnly,
    }),
    DocumentGuards,
    AiReply,
    AiSummary,
    AiPlaceholder,
    RitualQuestion,
    GoalItem,
    GoalReview,
    LegacyText,
    LegacyBlocks,
    MindComment,
  ]
}
