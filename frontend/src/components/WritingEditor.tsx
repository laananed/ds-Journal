/**
 * 写作编辑器入口（Stage 3 / S3-T04 → Stage 4 / S04-T03 过渡）。
 *
 * Stage 4 起正文权威是 **schema 1 JSON**（`content_doc`），编辑与阅读共用
 * `editor/RichTextEditor`。本组件因此变成一层很薄的适配：
 *
 * - 传入 `doc`（`ContentDocument`）→ 渲染统一的 Tiptap 编辑器；
 *   用户输入通过 `onDocumentChange` 上报**已按服务端白名单归一**的文档，
 *   保存队列仍归调用方（T02 的应用级会话），这里不做队列。
 * - 未传 `doc` → 保持 Stage 3 的 `content_blocks` 分段编辑（textarea + AI 块）。
 *   现存的 `JournalEditor` / `JournalDetail` / `InboxPage` 仍走这条路径，
 *   由 T06 / T11 逐步迁移，T12 收缩 `content_blocks` 后删除。
 *
 * 两条路径共用同一份 AI 标签文案与「AI 段不可当作用户正文」的语义，
 * 但它们**不是两套富文本实现**：旧路径只是尚未迁移的字符段渲染。
 */

import RichTextEditor from '../editor/RichTextEditor.tsx'
import type { EditorSelectionInfo } from '../editor/RichTextEditor.tsx'
import AiReplyBlock from './AiReplyBlock'
import { setBlockText } from '../utils/writingBlocks'
import type { Block } from '../types/writing'
import type { ContentDocument } from '../types/document'

export interface WritingEditorProps {
  /** Stage 4：schema 1 文档；传入即启用统一 Tiptap 编辑器。 */
  doc?: ContentDocument | null
  /** Stage 3 兼容：结构化字符块（未传 `doc` 时使用）。 */
  blocks?: Block[]
  disabled?: boolean
  /** AI 调用处理中锁定编辑（T07 使用；本期恒为 false）。 */
  locked?: boolean
  lockedMessage?: string
  /** 文档模式的用户输入回调。 */
  onDocumentChange?: (document: ContentDocument, schemaVersion: number) => void
  /** 文档模式的选区回调（Minds 范围分析用）。 */
  onSelection?: (selection: EditorSelectionInfo | null) => void
  /** 字符块模式的输入回调。 */
  onChange?: (blocks: Block[]) => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  /** 用户确认删除某个 AI 段；父级负责 flush + 专用接口。 */
  onRequestDeleteAiBlock?: (blockId: string) => void
  /** 正在删除的 AI 段 id（禁用重复操作）。 */
  deletingBlockId?: string | null
  onResolveLink?: (title: string) => void
}

function WritingEditor({
  doc, blocks, disabled, locked, lockedMessage, onDocumentChange, onSelection, onChange,
  onCompositionStart, onCompositionEnd, onRequestDeleteAiBlock, deletingBlockId, onResolveLink,
}: WritingEditorProps) {
  const readOnly = disabled === true || locked === true

  if (doc !== undefined) {
    return (
      <div className="writing-editor">
        {locked === true && (
          <p className="writing-locked" role="status">{lockedMessage ?? 'AI 正在处理，编辑与导航暂时锁定。'}</p>
        )}
        <RichTextEditor
          doc={doc}
          readOnly={readOnly}
          onUserChange={onDocumentChange === undefined ? undefined : (next, version) => onDocumentChange(next, version)}
          onSelection={onSelection}
          label="日记正文"
        />
      </div>
    )
  }

  return (
    <div className="writing-editor">
      {locked === true && (
        <p className="writing-locked" role="status">{lockedMessage ?? 'AI 正在处理，编辑与导航暂时锁定。'}</p>
      )}
      <ul className="writing-blocks">
        {(blocks ?? []).map((block) => (
          block.kind === 'user' ? (
            <li key={block.id} className="writing-block writing-block-user">
              <textarea
                className="writing-user-input"
                rows={6}
                value={block.text}
                aria-label="用户正文段"
                disabled={readOnly}
                placeholder="在这里继续写……"
                onChange={(event) => onChange?.(setBlockText(blocks ?? [], block.id, event.target.value))}
                onCompositionStart={onCompositionStart}
                onCompositionEnd={onCompositionEnd}
              />
            </li>
          ) : (
            <AiReplyBlock
              key={block.id}
              block={block}
              disabled={readOnly}
              deleting={deletingBlockId === block.id}
              onTextChange={(text) => onChange?.(setBlockText(blocks ?? [], block.id, text))}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              onRequestDelete={onRequestDeleteAiBlock}
              onResolveLink={onResolveLink}
            />
          )
        ))}
      </ul>
    </div>
  )
}

export default WritingEditor
