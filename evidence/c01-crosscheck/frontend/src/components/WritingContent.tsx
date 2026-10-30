/**
 * 正文的**只读**呈现（Stage 3 / S3-T04 → Stage 4 / S04-T03 过渡）。
 *
 * - 传入 `doc`（schema 1 JSON）→ 用统一的 `RichTextEditor readOnly`，
 *   与编辑态共用同一套 schema、同一套 AI/系统节点呈现；只读模式不补节点
 *   ID、不发变更回调，因此不可能把阅读动作写回数据库。
 * - 未传入 → 保持 Stage 3 行为：`content_blocks` 分组渲染或安全 Markdown。
 *   Trash 详情、Inbox 详情等尚未迁移的消费者继续走这条路径（T11 / T12 收口）。
 *
 * 两种情况都**不把渲染结果写回数据**，也不执行正文 HTML。
 */

import RichTextEditor from '../editor/RichTextEditor.tsx'
import AiReplyBlock from './AiReplyBlock'
import MarkdownContent from './MarkdownContent'
import { groupReadingRuns } from '../utils/writingBlocks'
import type { Block } from '../types/writing'
import type { ContentDocument } from '../types/document'

interface WritingContentProps {
  /** Stage 4：schema 1 文档；传入即使用统一只读编辑器。 */
  doc?: ContentDocument | null
  /** 详情里的结构化正文；NULL / 省略表示普通文本文件。 */
  blocks?: Block[] | null
  /** 普通文本正文（结构化文件不使用，仅作兜底）。 */
  content: string
  onLink?: (title: string) => void
  disabled?: boolean
}

function WritingContent({ doc, blocks, content, onLink, disabled }: WritingContentProps) {
  if (doc !== undefined) {
    return (
      <div className="writing-reading">
        <RichTextEditor doc={doc} readOnly label="正文（只读）" />
      </div>
    )
  }
  if (blocks === undefined || blocks === null || blocks.length === 0) {
    return <MarkdownContent source={content} onLink={onLink} disabled={disabled} />
  }
  const runs = groupReadingRuns(blocks)
  return (
    <div className="writing-reading">
      {runs.map((run, index) => (
        run.kind === 'user' ? (
          <div className="writing-reading-user" key={`user-${index}`}>
            <MarkdownContent source={run.text} onLink={onLink} disabled={disabled} />
          </div>
        ) : (
          <ul className="writing-blocks" key={`${run.block.kind}-${run.block.id}`}>
            <AiReplyBlock block={run.block} readOnly disabled={disabled} onResolveLink={onLink} />
          </ul>
        )
      ))}
    </div>
  )
}

export default WritingContent
