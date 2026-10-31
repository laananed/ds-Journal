/**
 * 本地未提交草稿的发现、恢复与冲突对照（Stage 4 / S04-T06）。
 *
 * 权威依据：`docs/stage4.md` §10、`docs/stage4-api.md` §10、
 * `docs/stage4-architecture.md` §4.1、验收 S4-A19。
 *
 * 三条不可让步的规则，都由组件结构保证：
 *
 * 1. **不自动执行**：恢复、采用某一方、丢弃都必须由用户点按钮触发；
 * 2. **不静默覆盖**：版本不同时把两侧内容都摆出来，只读预览，不合并；
 * 3. **不假装已保存**：本机草稿与服务器保存分开表述，丢弃有二次确认。
 *
 * 本组件不读存储、不发请求：候选、计划与回调全部由 `WritingPage` 传入，
 * 因此它是纯展示层，页面逻辑仍集中在页面与 `utils/writingSession.ts`。
 */

import { useEffect, useRef, useState } from 'react'
import type { CandidatePlan } from '../utils/writingSession'
import {
  candidateMeta,
  candidateOriginLabel,
  planLabel,
} from '../utils/writingSession'
import type { DraftCandidate } from '../state/localJournalDrafts'
import { ACTION_LABELS, actionsFor } from './writingDraftActions'
import type { DraftAction } from './writingDraftActions'

/** 动作计划与文案见 `./writingDraftActions.ts`；对外类型保持原导出位置。 */
export type { DraftAction } from './writingDraftActions'

export interface DraftPanelItem {
  candidate: DraftCandidate
  /** 探测服务器版本后的计划；null 表示还没探测。 */
  plan: CandidatePlan | null
  /** 正在探测 / 正在执行动作。 */
  busy: boolean
}

export interface LocalDraftPanelProps {
  items: DraftPanelItem[]
  currentTabId: string
  /** 读取本地存储失败时的告警（不回显正文）。 */
  error: string
  /** 操作结果提示。 */
  notice: string
  disabled: boolean
  onAction: (candidate: DraftCandidate, action: DraftAction) => void
  onClose: () => void
  /** 用户明确清理本应用草稿；只清本命名空间。 */
  onClearAll: () => void
}

const PLAN_HINTS: Record<CandidatePlan['kind'], string> = {
  editable: '版本一致，可以恢复编辑；保存时仍按版本比对。',
  fresh: '这份草稿还没提交到服务器，可以继续写。',
  conflict: '服务器上已有更新的版本。两侧内容都会保留，需要你选择。',
  server_missing: '服务器上已经不存在这篇（可能在回收箱）。本地内容保留，不会自动新建。「另存为新草稿」会以新的创建键提交一篇独立记录。',
  server_unreadable: '暂时读不到服务器版本。可以稍后重试，本地内容不会丢。',
  replay_pending: '创建请求已发出但结果未确认。「恢复原请求」会用原创建键与当时的原内容重放，服务器不会因此多出一条记录；「另存为新草稿」则会用新的创建键再建一篇独立记录。',
}

function LocalDraftPanel({
  items, currentTabId, error, notice, disabled, onAction, onClose, onClearAll,
}: LocalDraftPanelProps) {
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  /**
   * 进入确认态时把焦点放到「取消」上：键盘用户不会因为「丢弃」按钮被替换
   * 而掉到页面顶部，默认回车执行的是安全动作（保留草稿）。
   */
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  /** 记录每个候选的「丢弃」按钮，取消后把焦点还回去，键盘不丢位置。 */
  const discardRefs = useRef(new Map<string, HTMLButtonElement>())
  const refocusKey = useRef<string | null>(null)

  useEffect(() => {
    if (confirmDiscard !== null) {
      cancelRef.current?.focus()
      return
    }
    const key = refocusKey.current
    if (key === null) return
    refocusKey.current = null
    discardRefs.current.get(key)?.focus()
  }, [confirmDiscard])

  /** 取消 = 只复位本地确认状态；不调用 onAction，不删除，不写服务器。 */
  function cancelDiscard(key: string): void {
    refocusKey.current = key
    setConfirmDiscard(null)
  }

  return (
    <section className="writing-drafts" aria-label="本地未提交草稿">
      <header className="writing-drafts-head">
        <div>
          <h3>本地未提交草稿</h3>
          <p className="writing-drafts-sub">
            这些内容只保存在本机浏览器里，不代表服务器已经保存。可以恢复、稍后处理或明确丢弃。
          </p>
        </div>
        <button type="button" onClick={onClose}>关闭</button>
      </header>

      {notice !== '' && <p className="writing-drafts-notice" role="status">{notice}</p>}
      {error !== '' && <p className="writing-drafts-error" role="alert">{error}</p>}

      {items.length === 0 && !error && (
        <p className="writing-drafts-empty">本机没有未提交的草稿。</p>
      )}

      {items.length > 0 && (
        <ul className="writing-draft-list">
          {items.map(({ candidate, plan, busy }) => {
            const actions = actionsFor(plan)
            const discarding = confirmDiscard === candidate.key
            return (
              <li key={candidate.key} className="writing-draft-item">
                <div className="writing-draft-body">
                  <p className="writing-draft-title">
                    {candidate.title.trim() === '' ? '（无标题草稿）' : candidate.title}
                  </p>
                  <p className="writing-draft-meta">
                    {candidateOriginLabel(candidate, currentTabId)} · {candidateMeta(candidate)}
                  </p>
                  <p className="writing-draft-plan">
                    {plan === null ? '尚未读取服务器版本。' : planLabel(plan)}
                    {plan !== null && PLAN_HINTS[plan.kind] !== undefined && ` ${PLAN_HINTS[plan.kind]}`}
                  </p>
                </div>
                <div className="writing-draft-actions">
                  {/* 动作列表来自 `actionsFor`，不含 'discard'：丢弃只有下方
                      唯一的「丢弃」按钮这一个入口，且必须先经二次确认。 */}
                  {!discarding && actions.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={action === 'restore' ? 'writing-primary' : undefined}
                      disabled={disabled || busy}
                      onClick={() => { setConfirmDiscard(null); onAction(candidate, action) }}
                    >
                      {busy ? '处理中……' : ACTION_LABELS[action]}
                    </button>
                  ))}
                  {discarding && (
                    <>
                      <span className="writing-draft-confirm" role="alert">丢弃后本机这份草稿就没了。</span>
                      <button
                        type="button"
                        className="writing-danger"
                        disabled={disabled || busy}
                        onClick={() => { setConfirmDiscard(null); onAction(candidate, 'discard') }}
                      >
                        确认丢弃
                      </button>
                      <button type="button" disabled={busy} onClick={() => cancelDiscard(candidate.key)} ref={cancelRef}>取消</button>
                    </>
                  )}
                  {!discarding && (
                    <button
                      type="button"
                      disabled={disabled || busy}
                      ref={(node) => {
                        if (node === null) discardRefs.current.delete(candidate.key)
                        else discardRefs.current.set(candidate.key, node)
                      }}
                      onClick={() => setConfirmDiscard(candidate.key)}
                    >
                      丢弃
                    </button>
                  )}
                  {/* 确认态：确认才执行丢弃；「取消」只复位本地状态，
                      不触发 onAction、不删除、不写服务器。 */}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <footer className="writing-drafts-foot">
        {confirmClear ? (
          <>
            <span role="alert">会清空本应用存在这台浏览器上的全部草稿。</span>
            <button type="button" className="writing-danger" disabled={disabled}
              onClick={() => { setConfirmClear(false); onClearAll() }}>确认清空</button>
            <button type="button" onClick={() => setConfirmClear(false)}>取消</button>
          </>
        ) : (
          <button type="button" disabled={disabled || items.length === 0}
            onClick={() => setConfirmClear(true)}>清空本应用草稿</button>
        )}
      </footer>
    </section>
  )
}

export interface DraftConflictViewProps {
  /** 冲突来源说明，例如「这篇日记的服务器版本已更新」。 */
  title: string
  localHeading: string
  localText: string
  localMeta: string
  serverHeading: string
  serverText: string
  serverMeta: string
  keepLocalLabel: string
  takeServerLabel: string
  busy: boolean
  onKeepLocal: () => void
  onTakeServer: () => void
  onLater: () => void
}

/**
 * 两侧并排的冲突对照。
 *
 * 只读预览：不做自动合并、不做智能取舍、不在「查看」时写入任何一方。
 * 两个选择都需要用户点击；「稍后」保持双方原样。
 */
function DraftConflictView({
  title, localHeading, localText, localMeta, serverHeading, serverText, serverMeta,
  keepLocalLabel, takeServerLabel, busy, onKeepLocal, onTakeServer, onLater,
}: DraftConflictViewProps) {
  return (
    <section className="writing-conflict" aria-labelledby="writing-conflict-title">
      <h3 id="writing-conflict-title">{title}</h3>
      <p className="writing-conflict-hint">
        服务器与本地都保存着不同内容。这里只做只读对照，不会自动合并；选好之后仍需你确认保存。
      </p>
      <div className="writing-conflict-grid">
        <article className="writing-conflict-side" aria-label={localHeading}>
          <h4>{localHeading}</h4>
          <p className="writing-conflict-meta">{localMeta}</p>
          <div className="writing-conflict-text" tabIndex={0}>{localText.trim() === '' ? '（没有正文）' : localText}</div>
        </article>
        <article className="writing-conflict-side" aria-label={serverHeading}>
          <h4>{serverHeading}</h4>
          <p className="writing-conflict-meta">{serverMeta}</p>
          <div className="writing-conflict-text" tabIndex={0}>{serverText.trim() === '' ? '（没有正文）' : serverText}</div>
        </article>
      </div>
      <div className="writing-conflict-actions">
        <button type="button" className="writing-primary" disabled={busy} onClick={onKeepLocal}>{keepLocalLabel}</button>
        <button type="button" disabled={busy} onClick={onTakeServer}>{takeServerLabel}</button>
        <button type="button" disabled={busy} onClick={onLater}>稍后处理（双方都保留）</button>
      </div>
    </section>
  )
}

export { LocalDraftPanel, DraftConflictView }
export default LocalDraftPanel
