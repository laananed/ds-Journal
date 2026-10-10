/**
 * AI 段（回复 / 总结）的展示与删除入口（Stage 3 / S3-T04）。
 *
 * 视觉与行为依据 `docs/stage3.md` §3 与 `docs/stage3-architecture.md` §3：
 * - 蓝字 + 左侧蓝色竖线，与用户 textarea 明确区分；
 * - `ai_reply` 文本**不可编辑**（服务端也拒绝修改）；
 * - `ai_summary` 文本可编辑，但 `kind` / `id` / `request_id` 保持不变；
 * - 删除有三条入口：明确菜单按钮、右键（context menu）、移动端长按；
 *   菜单可用键盘操作（Tab 聚焦、Enter/Space 触发、Esc 关闭）。
 *
 * 组件本身**不发删除请求**：由父级先 flush 待保存输入、再按最新 revision
 * 调用专用接口（`api/writing.ts::deleteAiBlock`），避免与自动保存竞态。
 */

import { useEffect, useRef, useState } from 'react'
import MarkdownContent from './MarkdownContent'
import { BLOCK_LABELS } from '../utils/writingBlocks'
import type { AiBlock } from '../types/writing'

interface AiReplyBlockProps {
  block: AiBlock
  disabled?: boolean
  /** 只读场景（阅读 / Trash 详情）：不显示编辑与删除控件。 */
  readOnly?: boolean
  /** 正在删除该段（禁用重复操作）。 */
  deleting?: boolean
  /** 编辑 `ai_summary.text`；`ai_reply` 不提供该回调。 */
  onTextChange?: (text: string) => void
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  /** 用户确认删除该 AI 段（父级负责 flush + 专用接口）。 */
  onRequestDelete?: (blockId: string) => void
  /** Markdown 内部链接跳转（阅读时）。 */
  onResolveLink?: (title: string) => void
}

const LONG_PRESS_MS = 550

function AiReplyBlock({
  block, disabled, readOnly, deleting, onTextChange, onCompositionStart, onCompositionEnd, onRequestDelete, onResolveLink,
}: AiReplyBlockProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const label = BLOCK_LABELS[block.kind]
  const interactive = readOnly !== true && onRequestDelete !== undefined
  const editable = readOnly !== true && block.kind === 'ai_summary' && onTextChange !== undefined

  function cancelLongPress(): void {
    if (longPressTimer.current !== null) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  // 菜单打开后：点击外部 / 按 Esc 关闭。监听只在打开期间挂载。
  useEffect(() => {
    if (!menuOpen) return
    function handlePointerDown(event: PointerEvent): void {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  // 卸载时清掉长按计时器，避免在已卸载组件上 setState。
  useEffect(() => cancelLongPress, [])

  function confirmDelete(): void {
    setMenuOpen(false)
    onRequestDelete?.(block.id)
  }

  return (
    <li className={`writing-block writing-block-${block.kind}`}
      aria-label={`${label}段`}
      onContextMenu={(event) => {
        if (!interactive) return
        event.preventDefault()
        setMenuOpen(true)
      }}
      onPointerDown={(event) => {
        if (!interactive || event.pointerType === 'mouse') return
        cancelLongPress()
        longPressTimer.current = setTimeout(() => setMenuOpen(true), LONG_PRESS_MS)
      }}
      onPointerUp={cancelLongPress}
      onPointerLeave={cancelLongPress}
      onPointerCancel={cancelLongPress}
    >
      <div className="writing-block-head">
        <span className="writing-block-tag">{label}</span>
        <span className="writing-block-source">AI 内容 · 不计入用户正文</span>
        {interactive && (
          <div className="writing-block-menu-wrap" ref={wrapRef}>
            <button type="button" className="writing-block-menu-button"
              aria-haspopup="menu" aria-expanded={menuOpen}
              aria-label={`${label}段操作菜单`}
              disabled={disabled === true || deleting === true}
              onClick={() => setMenuOpen((open) => !open)}>操作 ▾</button>
            {menuOpen && (
              <div className="writing-block-menu" role="menu">
                <button type="button" role="menuitem" className="writing-block-menu-item danger"
                  disabled={disabled === true || deleting === true} onClick={confirmDelete}>
                  {deleting === true ? '正在删除……' : `删除该${label}段`}
                </button>
                <button type="button" role="menuitem" className="writing-block-menu-item"
                  onClick={() => setMenuOpen(false)}>取消</button>
              </div>
            )}
          </div>
        )}
      </div>
      {editable ? (
        <textarea className="writing-summary-input" rows={4} value={block.text}
          aria-label="AI 复盘内容（可编辑，来源身份不变）"
          disabled={disabled === true}
          onChange={(event) => onTextChange?.(event.target.value)}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd} />
      ) : (
        <div className="writing-ai-text markdown-body">
          <MarkdownContent source={block.text} onLink={onResolveLink} disabled={disabled} />
        </div>
      )}
    </li>
  )
}

export default AiReplyBlock
