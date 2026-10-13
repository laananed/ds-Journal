/**
 * 完整复盘的**可编辑预览**（Stage 3 / S3-T09）。
 *
 * 职责边界（`docs/stage3.md` §5、`docs/stage3-tasks.md` §11、`docs/stage3-api.md` §5～§6）：
 *
 * - **生成 ≠ 保存**：预览只是把后端已持久化的 `review` 展示出来，本组件
 *   **不创建、不修改任何目标文件**；
 * - **可编辑**：用户在这里改的就是最终提交的 `markdown`；取消只是 UI 离开，
 *   ready 结果仍可由请求 ID 恢复，不需要删除/取消上游接口；
 * - **一次确认**：保存只有一个按钮，防双击由上层 `disabled` 控制；
 * - **结构化要点只读**：事实/推测/角度/逻辑链/追问只用于核对依据，
 *   推测额外显示不确定性；`evidence.quote` 由后端保证是所选用户正文的子串；
 * - **T10 接入点**：`onAddInsight` 是给 Insight 草稿添加预留的回调。**未接入时
 *   不渲染按钮**，只展示草稿——查看草稿绝不触发 Insight 写入。
 */

import FolderSelect from './FolderSelect'
import type { AIInsightDraft, AIReviewObject, AIReviewPoint } from '../types/ai'
import type { ReviewTargetDraft } from '../utils/reviewSelection'
import { countCodePoints } from '../utils/contentValidation'

export interface ReviewPreviewProps {
  /** 后端返回并已严格解析的复盘对象。 */
  review: AIReviewObject
  /** 可编辑的完整复盘正文；确认保存时提交的就是它。 */
  markdown: string
  onMarkdownChange: (value: string) => void
  /** 保存目标草稿（默认值由上层按产品 §5 决定，可改标题/日期/Folder）。 */
  target: ReviewTargetDraft
  onTargetChange: (update: Partial<ReviewTargetDraft>) => void
  /** 只有单篇 Journal 才允许「追加到原文」；否则只能新建 Journal。 */
  appendAllowed: boolean
  /** 保存中 / 源冲突 / 结果不可保存时禁用编辑与确认。 */
  disabled: boolean
  /** 一次确认：只走 review save。 */
  onConfirm: () => void
  /** 取消预览：只是 UI 离开，不保存、不删除 ready 结果。 */
  onCancel: () => void
  saving: boolean
  /** 保存错误（保留用户预览，不丢输入）。 */
  error: string
  /**
   * T10 接入点：用户**明确点击**「添加为 Insight」时回调该草稿。
   * 未提供时按钮不出现，仅展示草稿。
   */
  onAddInsight?: (draft: AIInsightDraft) => void
  /** T10 接入后由上层给出的可用性（例如仍在编辑中则禁用）。 */
  insightDisabled?: boolean
}

/** 一条要点：正文 + 不确定性 + 逐条依据（来源与原文引用）。 */
function PointList({ title, points, hint }: {
  title: string
  points: AIReviewPoint[]
  hint?: string
}) {
  if (points.length === 0) return null
  return (
    <section className="review-section">
      <h4 className="review-section-title">{title}{hint ? `（${hint}）` : ''}</h4>
      <ul className="review-points">
        {points.map((point, index) => (
          <li key={`${title}-${index}`} className="review-point">
            <p className="review-point-text">{point.text}</p>
            {point.uncertainty !== undefined && point.uncertainty !== '' && (
              <p className="review-point-uncertainty">不确定性：{point.uncertainty}</p>
            )}
            <ul className="review-evidence">
              {point.evidence.map((evidence, evidenceIndex) => (
                <li key={`${title}-${index}-${evidenceIndex}`}>
                  依据 [{evidence.source.type}:{evidence.source.id}]：{evidence.quote}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ReviewPreview({
  review, markdown, onMarkdownChange, target, onTargetChange,
  appendAllowed, disabled, onConfirm, onCancel, saving, error, onAddInsight, insightDisabled,
}: ReviewPreviewProps) {
  const markdownLength = countCodePoints(markdown)
  const editingLocked = disabled || saving

  return (
    <section className="review-preview" aria-label="复盘预览">
      <div className="review-preview-head">
        <h3 className="review-preview-title">复盘预览（{editingLocked ? '已锁定' : '可编辑'}）</h3>
        <span className="review-preview-hint">事实与推测分开显示；每一条依据都能回到所选源文件。</span>
      </div>

      <PointList title="事实" points={review.facts} />
      <PointList title="情绪推测" points={review.emotion_hypotheses} hint="含不确定性" />
      <PointList title="可能解释" points={review.possible_explanations} hint="含不确定性" />

      {review.angles.length > 0 && (
        <section className="review-section">
          <h4 className="review-section-title">三个角度</h4>
          <ul className="review-angles">
            {review.angles.map((angle) => (
              <li key={angle.title} className="review-angle">
                <h5 className="review-angle-title">{angle.title}</h5>
                <p className="review-angle-content">{angle.content}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {review.logic_chain.length > 0 && (
        <section className="review-section">
          <h4 className="review-section-title">行为与思考逻辑</h4>
          <ul className="review-points">
            {review.logic_chain.map((step, index) => (
              <li key={`logic-${index}`} className="review-point-text">{step}</li>
            ))}
          </ul>
        </section>
      )}

      {review.follow_up_questions.length > 0 && (
        <section className="review-section">
          <h4 className="review-section-title">追问</h4>
          <ul className="review-points">
            {review.follow_up_questions.map((question, index) => (
              <li key={`q-${index}`} className="review-point-text">{question}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="review-section" aria-label="Insight 草稿">
        <h4 className="review-section-title">Insight 草稿（{review.insight_drafts.length} 份，一个观点一份）</h4>
        {review.insight_drafts.length === 0
          ? <p className="review-preview-hint">这次没有可提炼的独立观点，草稿可以是零份。</p>
          : (
            <ul className="review-drafts">
              {review.insight_drafts.map((draft) => (
                <li key={draft.draft_id} className="review-draft">
                  <h5 className="review-draft-title">{draft.title}</h5>
                  <p className="review-draft-viewpoint">观点：{draft.viewpoint}</p>
                  <p className="review-draft-content">{draft.content}</p>
                  <ul className="review-evidence">
                    {draft.evidence.map((evidence, index) => (
                      <li key={`${draft.draft_id}-${index}`}>
                        依据 [{evidence.source.type}:{evidence.source.id}]：{evidence.quote}
                      </li>
                    ))}
                  </ul>
                  {onAddInsight !== undefined
                    ? (
                      <button type="button" className="review-draft-add"
                        onClick={() => onAddInsight(draft)}
                        disabled={editingLocked || insightDisabled === true}>
                        添加为 Insight
                      </button>
                    )
                    : (
                      <p className="review-draft-pending" role="note">
                        添加为 Insight 待与 T10 组件整合后组合复测；本轮不接入，查看草稿不会写入任何 Insight 文件。
                      </p>
                    )}
                </li>
              ))}
            </ul>
          )}
      </section>

      <label className="editor-field">
        <span>完整复盘正文（可编辑；确认保存的就是这份文本，共 {markdownLength} 字）</span>
        <textarea className="review-markdown" rows={14} value={markdown}
          disabled={editingLocked}
          onChange={(event) => onMarkdownChange(event.target.value)} />
      </label>

      <fieldset className="review-target" disabled={editingLocked}>
        <legend>保存到哪里（一次确认后直接落库）</legend>
        {appendAllowed && (
          <label className="review-target-option">
            <input type="radio" name="review-target-mode" checked={target.mode === 'append_source'}
              onChange={() => onTargetChange({ mode: 'append_source' })} />
            追加到原 Journal 底部（`---` 分隔，保留来源标记）
          </label>
        )}
        <label className="review-target-option">
          <input type="radio" name="review-target-mode" checked={target.mode === 'new_journal'}
            onChange={() => onTargetChange({ mode: 'new_journal' })} />
          新建 Journal（Inbox 单篇与多篇都走这里；源文件不改动）
        </label>
        {target.mode === 'new_journal' && (
          <>
            <label className="editor-field">
              <span>标题（留空则用「AI 复盘 YYYY-MM-DD」）</span>
              <input type="text" value={target.title}
                onChange={(event) => onTargetChange({ title: event.target.value })} />
            </label>
            <label className="editor-field">
              <span>业务日期（默认取发起复盘时的本地 04:00 业务日期）</span>
              <input type="date" value={target.journal_date}
                onChange={(event) => onTargetChange({ journal_date: event.target.value })} />
            </label>
            <FolderSelect value={target.folder_id}
              onChange={(folderId) => onTargetChange({ folder_id: folderId })} />
          </>
        )}
      </fieldset>

      {error !== '' && <p className="detail-error" role="alert">{error}</p>}

      <div className="review-actions">
        <button type="button" className="review-confirm" onClick={onConfirm} disabled={editingLocked}>
          {saving ? '正在保存……' : '确认保存（只此一次）'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>取消预览</button>
      </div>
      <p className="review-preview-hint">
        取消只是离开预览，不会写入原文件，也不会创建空目标；ready 结果仍可用请求 ID 恢复。
      </p>
    </section>
  )
}

export default ReviewPreview
