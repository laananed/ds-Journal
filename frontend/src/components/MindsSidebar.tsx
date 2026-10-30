/**
 * Minds 评论侧栏（Stage 4 / S04-T09）。
 *
 * 契约：`docs/stage4-api.md` §8（固定三个预置：温和陪伴 / 换个角度 / 思维陷阱）、
 * §9（`GET /api/journals/{id}/comments` 固定 20 条、`anchor_state` 可为
 * `unavailable`、删除评论不回退 usage/C）、`docs/stage4-architecture.md` §7.2
 * （失锚只落侧栏结果、不给 Go Deeper 推进 C；`GET` 零写、打开不回模型）。
 *
 * 组件只做展示与回调，不发请求：
 * - 预置只允许 1～3 个，去重后由父级提交；本期没有「自定义 Mind」入口；
 * - `anchor_state='unavailable'` 明确写出「正文已改动，评论保留但不挂位置」，
 *   不给用户「点一下就能跳过去」的假承诺；
 * - 删除交给父级先保存最新输入再按 revision 调专用接口；
 * - 查看评论不产生任何模型调用，也不改变已消耗的 usage。
 */

import { useMemo, useState } from 'react'
import './MindsSidebar.css'
import type { AIComment, MindPresetId } from '../types/ai'

import { MIND_PRESETS } from '../state/autoAi.ts'

export interface MindsSidebarProps {
  /** 当前文件的评论（固定 20 条分页，父级负责翻页）。 */
  comments: AIComment[]
  loading: boolean
  error: string
  disabled?: boolean
  /** 设置里保存的预置集合；界面上的勾选从这个值初始化。 */
  presets: MindPresetId[]
  onPresetsChange: (next: MindPresetId[]) => void
  /** 请求一次 Minds 评论（手动）。 */
  onRequest: () => void
  /** 用户明确删除一条评论。 */
  onDelete: (comment: AIComment) => void
  /** 失锚评论的定位提示（不做假跳转）。 */
  onFocusAnchor?: (comment: AIComment) => void
  onReload?: () => void
  /** 处理中状态说明（例如「正在分析选区」「结果正在写入」）。 */
  statusMessage?: string
  /** 选区说明：`all` 或「已选 N 段」。 */
  scopeLabel?: string
  total?: number
  page?: number
  hasNext?: boolean
  onPageChange?: (page: number) => void
}

function presetLabel(id: MindPresetId): string {
  return MIND_PRESETS.find((preset) => preset.id === id)?.label ?? id
}

function MindsSidebar({
  comments,
  loading,
  error,
  disabled = false,
  presets,
  onPresetsChange,
  onRequest,
  onDelete,
  onFocusAnchor,
  onReload,
  statusMessage = '',
  scopeLabel = '整篇',
  total,
  page = 1,
  hasNext = false,
  onPageChange,
}: MindsSidebarProps) {
  const [open, setOpen] = useState(true)
  const selected = useMemo(() => new Set(presets), [presets])

  function toggle(id: MindPresetId): void {
    if (selected.has(id)) {
      // 至少保留一个预置：全取消会让请求没有分析视角。
      if (presets.length === 1) return
      onPresetsChange(presets.filter((item) => item !== id))
      return
    }
    if (presets.length >= 3) return
    onPresetsChange([...presets, id])
  }

  return (
    <aside className="minds-sidebar" aria-label="Minds 评论">
      <header className="minds-head">
        <h3>Minds 评论</h3>
        <button type="button" className="minds-toggle" aria-expanded={open}
          onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开'}
        </button>
      </header>

      {!open && comments.length > 0 && (
        <p className="minds-collapsed-hint">已收起，{comments.length} 条评论（不影响正文）。</p>
      )}

      {open && (
        <>
          <section className="minds-presets" aria-label="预置视角">
            <p className="minds-section-title">预置视角（1～3 个，本期没有自定义 Mind）</p>
            <ul className="minds-preset-list">
              {MIND_PRESETS.map((preset) => {
                const active = selected.has(preset.id)
                return (
                  <li key={preset.id}>
                    <button type="button" aria-pressed={active}
                      className={`minds-preset${active ? ' is-active' : ''}`}
                      disabled={disabled || (!active && presets.length >= 3)}
                      title={preset.hint}
                      onClick={() => toggle(preset.id)}>
                      <span className="minds-preset-label">{preset.label}</span>
                      <span className="minds-preset-hint">{preset.hint}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="minds-scope">分析范围：{scopeLabel}</p>
            <div className="minds-actions">
              <button type="button" className="minds-primary" disabled={disabled} onClick={onRequest}>
                请 Minds 看这段
              </button>
              {onReload !== undefined && (
                <button type="button" disabled={disabled || loading} onClick={onReload}>重新读取评论</button>
              )}
            </div>
            {statusMessage !== '' && <p className="minds-status" role="status">{statusMessage}</p>}
          </section>

          <section className="minds-comments" aria-label="已有评论">
            <p className="minds-section-title">
              评论{typeof total === 'number' ? `（共 ${total} 条）` : `（${comments.length} 条）`}
            </p>
            {loading && <p className="minds-state" role="status">正在读取评论……</p>}
            {error !== '' && (
              <p className="minds-state minds-state-error" role="alert">{error}</p>
            )}
            {!loading && error === '' && comments.length === 0 && (
              <p className="minds-state">还没有评论。评论不会自动生成，除非你打开自动开关或手动请求。</p>
            )}
            {comments.length > 0 && (
              <ul className="minds-items">
                {comments.map((comment) => {
                  const unavailable = comment.anchor_state === 'unavailable'
                  return (
                    <li key={comment.id} className={`minds-item${unavailable ? ' is-unavailable' : ''}`}>
                      <div className="minds-item-head">
                        <span className="minds-item-preset">{presetLabel(comment.mind_preset_id)}</span>
                        <span className={`minds-item-anchor minds-item-anchor-${comment.anchor_state}`}>
                          {unavailable ? '失锚（正文已改动）' : '已挂到正文'}
                        </span>
                      </div>
                      <blockquote className="minds-item-quote">{comment.quote}</blockquote>
                      <p className="minds-item-text">{comment.text}</p>
                      {unavailable && (
                        <p className="minds-item-note">
                          这段原文已被改动，评论保留在侧栏，但不再指向任何位置；不会挂到相近的重复文字上。
                        </p>
                      )}
                      <div className="minds-item-actions">
                        {!unavailable && onFocusAnchor !== undefined && (
                          <button type="button" disabled={disabled}
                            onClick={() => onFocusAnchor(comment)}>定位原文</button>
                        )}
                        <button type="button" className="minds-danger" disabled={disabled}
                          onClick={() => onDelete(comment)}>删除评论</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            {(hasNext || page > 1) && onPageChange !== undefined && (
              <div className="minds-paging">
                <button type="button" disabled={disabled || page <= 1}
                  onClick={() => onPageChange(page - 1)}>上一页</button>
                <span>第 {page} 页</span>
                <button type="button" disabled={disabled || !hasNext}
                  onClick={() => onPageChange(page + 1)}>下一页</button>
              </div>
            )}
            <p className="minds-footnote">
              查看评论不会调用模型；删除评论只删这条评论与它的 Mark，已消耗的 Token 不会回退。
            </p>
          </section>
        </>
      )}
    </aside>
  )
}

export default MindsSidebar
