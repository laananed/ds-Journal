/**
 * 结构化写作编辑器（Stage 3 / S3-T04）。
 *
 * 用户正文用**原生 textarea 分段**编辑，AI 段由 `AiReplyBlock` 渲染成蓝块；
 * 两类段落交错排列，而不是在同一个 textarea 里着色
 * （`docs/stage3.md` §3、`docs/stage3-architecture.md` §3）。
 *
 * 交给父级（页面）的契约：
 *
 * - `blocks` + `onChange(blocks)`：组件是**受控**的，唯一状态源是父级草稿里的块数组；
 * - `onCompositionStart/End`：IME 组合期间页面暂停自动保存，避免存半个拼音；
 * - `onRequestDeleteAiBlock(blockId)`：**只上报意图**。父级必须先 `flush()` 待保存
 *   输入，再按最新 revision 调 `DELETE /api/files/{type}/{id}/ai-blocks/{block_id}`，
 *   成功后才重读详情更新基线（防止删除与自动保存竞态）；
 * - `locked` / `lockedMessage`：T07 的「AI 调用期间锁定当前编辑与导航」接口。
 *   本期不接模型调用，只保留这个锁定开关。
 *
 * 供 T07 复用的封口 / 空尾续写段是 `utils/writingBlocks.ts` 里的纯函数
 * （`appendContinuation`、`removeAiBlock`、`pruneBlocksToServer`），
 * 不在本组件里隐藏实现——AI 回复的插入位置由服务端按调用记录边界决定。
 */

import AiReplyBlock from './AiReplyBlock'
import { setBlockText } from '../utils/writingBlocks'
import type { Block } from '../types/writing'

export interface WritingEditorProps {
  blocks: Block[]
  disabled?: boolean
  /** AI 调用处理中锁定编辑（T07 使用；本期恒为 false）。 */
  locked?: boolean
  lockedMessage?: string
  onChange: (blocks: Block[]) => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  /** 用户确认删除某个 AI 段；父级负责 flush + 专用接口。 */
  onRequestDeleteAiBlock?: (blockId: string) => void
  /** 正在删除的 AI 段 id（禁用重复操作）。 */
  deletingBlockId?: string | null
  onResolveLink?: (title: string) => void
}

function WritingEditor({
  blocks, disabled, locked, lockedMessage, onChange, onCompositionStart, onCompositionEnd,
  onRequestDeleteAiBlock, deletingBlockId, onResolveLink,
}: WritingEditorProps) {
  const readOnly = disabled === true || locked === true

  return (
    <div className="writing-editor">
      {locked === true && (
        <p className="writing-locked" role="status">{lockedMessage ?? 'AI 正在处理，编辑与导航暂时锁定。'}</p>
      )}
      <ul className="writing-blocks">
        {blocks.map((block) => (
          block.kind === 'user' ? (
            <li key={block.id} className="writing-block writing-block-user">
              <textarea
                className="writing-user-input"
                rows={6}
                value={block.text}
                aria-label="用户正文段"
                disabled={readOnly}
                placeholder="在这里继续写……"
                onChange={(event) => onChange(setBlockText(blocks, block.id, event.target.value))}
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
              onTextChange={(text) => onChange(setBlockText(blocks, block.id, text))}
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
