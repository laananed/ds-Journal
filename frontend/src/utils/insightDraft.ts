/**
 * Insight 编辑的纯逻辑（Stage 2 / S2-T06）。
 *
 * 关键规则来自 `docs/stage2-api.md` 第 5 节：
 *
 * - Insight **没有**所属日期，也没有「省略标题就用日期做默认标题」的规则；
 *   空标题由后端投影成「未命名 Insight」，**不写回**原始 `title`；
 * - 编辑框始终使用**原始** `title`（`null` 显示成空串），
 *   绝不把展示用的 `display_title` 回退值写回数据库；
 * - PATCH 省略字段表示不变，只提交真正改动的字段；清空标题显式提交 `null`。
 *
 * 创建和编辑均提交用户选择的 Folder；null 表示无 Folder。
 *
 * 本文件不依赖 React、不发请求，可用 `node --experimental-strip-types` 直接测试。
 */

import type { Insight, InsightCreate, InsightUpdate, InsightUpdateFields } from '../types/insight.ts'
import type { ContentDocument, InlineNode } from '../types/document.ts'
import type { DocumentDraft, DraftPatch } from '../state/editSessions.ts'
import type { InsightDraftSeed } from './insightAiDraft.ts'
import { countCodePoints, isBlankText } from './contentValidation.ts'
import { draftTitleToValue } from './journalDetail.ts'

/** 创建与编辑共用的表单草稿；null 表示无 Folder。 */
export interface InsightEditDraft {
  title: string
  content: string
  folder_id: number | null
}

/** 把服务端记录转成表单草稿：`title` 为 `null` 时显示成空串，**不**回退成展示标题。 */
export function toInsightDraft(insight: Insight): InsightEditDraft {
  return { title: insight.title ?? '', content: insight.content, folder_id: insight.folder_id }
}

/**
 * 构造创建请求。
 *
 * `title` 显式提交：空输入（空串）按既有约定转成 `null`，
 * 后端把它保存为「无标题」，展示时投影成「未命名 Insight」。
 * 非空标题（含纯空白）原样提交，不 trim。
 */
export function buildInsightCreate(draft: InsightEditDraft): InsightCreate {
  return { content: draft.content, title: draftTitleToValue(draft.title), folder_id: draft.folder_id }
}

/**
 * 构造更新请求，只包含真正改动的字段。
 *
 * 初始输入把 `null` 显示成空串；比较输入与初始展示值，
 * 避免未编辑的历史 `title=null` / `title=""` 被误改成另一种空值。
 */
export function buildInsightUpdate(original: Insight, draft: InsightEditDraft): InsightUpdateFields {
  const update: InsightUpdateFields = {}
  if (draft.title !== (original.title ?? '')) update.title = draftTitleToValue(draft.title)
  if (draft.content !== original.content) update.content = draft.content
  // Folder 真实变化才进 PATCH：null 表示移出 Folder，未变化不制造更新。
  if (draft.folder_id !== original.folder_id) update.folder_id = draft.folder_id
  return update
}

/** 更新请求是否为空（没有任何字段需要提交）。 */
export function isInsightUpdateEmpty(update: InsightUpdateFields): boolean {
  return Object.keys(update).length === 0
}

/* --------------------------------------- Stage 4 正文 JSON（S04-T11） */

/**
 * Stage 4 起 Insight 的正文权威是 schema 1 JSON（`docs/stage4-api.md` §2），
 * 上面的 `buildInsightCreate` / `buildInsightUpdate` 是 **Stage 2 旧接口** 的
 * 请求构造：页面已不再调用它们（旧 `content` 写入口在已转换文件上会被服务端
 * 409 `legacy_conversion_required` 拒绝），保留仅为既有纯逻辑测试与历史比对。
 *
 * 下面这一组是 T11 页面实际使用的纯函数，三条边界：
 *
 * 1. 新文件只提交 `content_doc`：不发送 `content`，也不发送 `content_blocks`，
 *    避免用旧写入口绕过新 JSON 的作者身份保护（产品 §8、API §2）。
 * 2. 旧格式（`content_doc IS NULL` 且没有 blocks）**不自动转换**：服务端只接受
 *    「单个 user `legacyText`、`raw_text` 与原文逐字相同」这一种等价转换，
 *    因此 `legacyTextDocument` / `isExactLegacyDocument` 严格按这个口径构造与判定。
 * 3. 带旧 blocks 的记录（Insight 不会出现）不在这里构造任何映射：
 *    无法证明等价时必须保留 legacy，而不是用前端猜测的转换覆盖原文。
 */

/** 与服务端 `_validate_content` 相同口径的上限（阅读投影码点数）。 */
export const INSIGHT_DOCUMENT_MAX_CODE_POINTS = 50_000

/** 空白新草稿：ProseMirror 需要一个可放光标的块，服务端据此判为空白正文。 */
export function emptyInsightDocument(): ContentDocument {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** 是否为结构合法的 schema 1 根文档；只做形状判断，语义校验仍在服务端。 */
export function isContentDocument(value: unknown): value is ContentDocument {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; content?: unknown }
  return candidate.type === 'doc' && Array.isArray(candidate.content)
}

/** 顶层块或行内节点（`text` / `hardBreak`）在纯文本投影里的贡献。 */
type AnyDocNode = ContentDocument['content'][number] | InlineNode

function nodePlainText(node: AnyDocNode): string {
  switch (node.type) {
    case 'text': return node.text
    case 'hardBreak': return '\n'
    case 'legacyText': return node.attrs.raw_text
    case 'goalItem': return node.attrs.text
    case 'ritualQuestion': return node.attrs.question_snapshot
    case 'aiPlaceholder':
    case 'horizontalRule': return ''
    default: {
      const children = (node as { content?: AnyDocNode[] }).content ?? []
      const separator = node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' ? '' : '\n'
      return children.map(nodePlainText).join(separator)
    }
  }
}

/**
 * 文档的纯文本投影：顶层块之间单个换行。
 *
 * 只用于**本地空白/长度判定**，不是服务端阅读投影 R（R 会做 Markdown 转义）。
 * 空白或超长的草稿本地不提交，与服务端 `_validate_content` 的拒绝口径保持一致。
 */
export function documentPlainText(document: unknown): string {
  if (!isContentDocument(document)) return ''
  return document.content.map(nodePlainText).join('\n')
}

/**
 * 纯文本 → 文档：**每行一个段落、逐字保留**（不 trim、不合并空行）。
 *
 * 用途：把 AI 草稿种子（`InsightDraftSeed.content`）填进统一编辑器。
 * 这是新建文件的初始输入，不是旧数据的转换，因此可以用这条可证明等价的映射：
 * `documentPlainText(textToDocument(text)) === text`（见同名测试）。
 */
export function textToDocument(text: string): ContentDocument {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => (line === ''
      ? { type: 'paragraph' as const }
      : { type: 'paragraph' as const, content: [{ type: 'text' as const, text: line }] })),
  }
}

/**
 * 旧格式正文的**等价转换文档**：单个 user `legacyText`，原文逐字保留。
 *
 * 与服务端 `convert_legacy_text()` 的形状一致：只有 `content_doc IS NULL`
 * 且没有 blocks 的文件才允许这一步，并且 `raw_text` 必须与旧 `content`
 * 完全相同，否则服务端返回 409 `legacy_conversion_required`。
 */
export function legacyTextDocument(text: string, nodeId: string): ContentDocument {
  return {
    type: 'doc',
    content: [{ type: 'legacyText', attrs: { id: nodeId, raw_text: text, author: 'user' } }],
  }
}

/** 这份文档是否就是「原文逐字」的等价转换（服务端唯一接受的 legacy → JSON 转换）。 */
export function isExactLegacyDocument(document: unknown, text: string): boolean {
  if (!isContentDocument(document) || document.content.length !== 1) return false
  const [node] = document.content
  return node.type === 'legacyText'
    && node.attrs.author === 'user'
    && node.attrs.raw_text === text
}

/**
 * 打开编辑器时载入的文档。
 *
 * - 已是 tiptap：用服务端 `content_doc`（深拷贝，避免编辑器与响应对象共享结构）；
 * - 仍是 legacy：用等价转换文档先**只读**呈现，用户显式转换后才可编辑，
 *   这样不会因为「打开就写」而改变旧记录，也不会把未知 blocks 猜成结构。
 */
export function insightEditingDocument(insight: Insight, legacyNodeId: string): ContentDocument {
  if (isContentDocument(insight.content_doc)) {
    return JSON.parse(JSON.stringify(insight.content_doc)) as ContentDocument
  }
  return legacyTextDocument(insight.content, legacyNodeId)
}

/** 服务端详情 → 会话草稿（Insight 没有业务日期，`date` 恒为空串）。 */
export function insightToDraft(insight: Insight, legacyNodeId: string): DocumentDraft {
  return {
    title: insight.title ?? '',
    content_doc: insightEditingDocument(insight, legacyNodeId),
    date: '',
    folder_id: insight.folder_id,
  }
}

/** 空白新建草稿（种子只用于初始化内容，创建键由调用方固定）。 */
export function blankInsightDraft(): DocumentDraft {
  return { title: '', content_doc: emptyInsightDocument(), date: '', folder_id: null }
}

/** AI 草稿种子 → 会话草稿：正文逐行原样进入统一编辑器。 */
export function seedInsightDraft(seed: InsightDraftSeed): DocumentDraft {
  return {
    title: seed.title,
    content_doc: textToDocument(seed.content),
    date: '',
    folder_id: seed.folder_id,
  }
}

export type InsightDraftIssue = '' | 'blank' | 'too_long'

/** 本地可提交判定：空白或超长的正文不发送，也不创建空记录。 */
export function insightDraftIssue(draft: DocumentDraft): InsightDraftIssue {
  const text = documentPlainText(draft.content_doc)
  if (isBlankText(text)) return 'blank'
  if (countCodePoints(text) > INSIGHT_DOCUMENT_MAX_CODE_POINTS) return 'too_long'
  return ''
}

/** 会话 `isSavable` 口径：与页面提示使用同一个判定。 */
export function insightDraftSavable(draft: DocumentDraft): boolean {
  return insightDraftIssue(draft) === ''
}

/**
 * 创建请求：**只有** `content_doc`（外加标题 / Folder / 创建键）。
 *
 * 刻意不接受 `content`：旧写入口会绕过 JSON 作者校验，T11 不再使用。
 */
export function insightCreatePayload(draft: DocumentDraft, createKey: string): InsightCreate {
  return {
    title: draftTitleToValue(draft.title),
    content_doc: draft.content_doc as ContentDocument,
    document_schema_version: 1,
    folder_id: draft.folder_id,
    client_create_id: createKey,
  }
}

/** 更新请求：只提交真正变化的字段；带正文时才附 `document_schema_version`。 */
export function insightUpdatePayload(patch: DraftPatch, expectedRevision: number): InsightUpdate {
  const payload: InsightUpdate = { expected_revision: expectedRevision }
  if (patch.title !== undefined) payload.title = patch.title
  if (patch.content_doc !== undefined) {
    payload.content_doc = patch.content_doc as ContentDocument
    payload.document_schema_version = 1
  }
  if (patch.folder_id !== undefined) payload.folder_id = patch.folder_id
  // Insight 没有业务日期：会话里即使出现 journal_date 也不提交。
  return payload
}

