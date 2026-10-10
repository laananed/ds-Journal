/**
 * 结构化正文的**只读阅读**视图（Stage 3 / S3-T04）。
 *
 * 复用现有安全 Markdown 阅读（`MarkdownContent` → `react-markdown` + remark-gfm
 * + 内部链接 transform），不新建解析框架，也**不把渲染后的 HTML 写回数据**。
 *
 * 渲染策略（`docs/stage3-architecture.md` §3「阅读时 user 跨段还原」）：
 * - 普通文件（`content_blocks` 为 NULL）→ 直接渲染 `content`，与 Stage 2 完全一致；
 * - 结构化文件 → 用 `groupReadingRuns` 把**连续 user 段合并成一段**再渲染，
 *   使跨 textarea 的 Markdown 连续语法（列表 / 代码块 / 引用）在阅读时重新连起来；
 *   AI 段保持独立片段，加蓝色竖线与来源标签，并天然打断 Markdown 语法。
 *
 * 只读：不提供编辑与删除控件（Trash 详情、正常详情查看态共用）。
 */

import AiReplyBlock from './AiReplyBlock'
import MarkdownContent from './MarkdownContent'
import { groupReadingRuns } from '../utils/writingBlocks'
import type { Block } from '../types/writing'

interface WritingContentProps {
  /** 详情里的结构化正文；NULL / 省略表示普通文本文件。 */
  blocks?: Block[] | null
  /** 普通文本正文（结构化文件不使用，仅作兜底）。 */
  content: string
  onLink?: (title: string) => void
  disabled?: boolean
}

function WritingContent({ blocks, content, onLink, disabled }: WritingContentProps) {
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
