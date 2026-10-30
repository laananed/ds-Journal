/**
 * 全局 AI 请求状态入口（Stage 4 / S04-T09）。
 *
 * 依据 `docs/stage4-tasks.md` §3.10（「全局请求入口」）、
 * `docs/stage4-architecture.md` §4（「全局失败入口分别显示文件、保存/AI 状态与操作，
 * 不因任一文件失败锁全应用」）、`docs/stage4-api.md` §7（pending/unknown 先查询，
 * 不自动换键重发）。
 *
 * 这个组件只做三件事：**显示**在途/失败/未知的写作请求、**查询**状态、
 * **跳转**到对应文件。它不发新请求、不自动重试，也不锁导航——切页是允许的。
 */

import './WritingAiPanel.css'
import { phaseLabel, type WritingPhase } from '../state/writingRequests'

export interface GlobalRequestItem {
  requestId: string
  kind: 'go_deeper' | 'minds_comments'
  fileId: number
  phase: WritingPhase
  message: string
  /** 是否可能已经消耗 Token（不承诺账单精确）。 */
  mayHaveCharged: boolean
}

export interface GlobalRequestStatusProps {
  items: GlobalRequestItem[]
  /** 当前正在编辑的文件（用于标出「这篇」）。 */
  currentFileId?: number | null
  disabled?: boolean
  /** 打开请求所属文件；不做隐式跳转。 */
  onOpenFile?: (fileId: number) => void
  /** 只查询状态：不发新请求。 */
  onQuery: (requestId: string) => void
  /** 已就绪且用户明确要写入正文。 */
  onApply?: (requestId: string) => void
  /** 清除本地入口（不动服务端记录与已消耗 usage）。 */
  onForget: (requestId: string) => void
}

function kindLabel(kind: GlobalRequestItem['kind']): string {
  return kind === 'minds_comments' ? 'Minds 评论' : 'Go Deeper'
}

/** 只有「运行中/未知」需要用户关注；已写入的留一条即可。 */
function needsAttention(item: GlobalRequestItem): boolean {
  return item.phase === 'running' || item.phase === 'unknown' || item.phase === 'failed'
    || item.phase === 'conflict' || item.phase === 'ready'
}

function GlobalRequestStatus({
  items,
  currentFileId = null,
  disabled = false,
  onOpenFile,
  onQuery,
  onApply,
  onForget,
}: GlobalRequestStatusProps) {
  if (items.length === 0) return null
  const attention = items.filter(needsAttention)
  const rest = items.filter((item) => !needsAttention(item))

  return (
    <section className="global-ai" aria-label="AI 请求状态">
      <header className="global-ai-head">
        <h4>AI 请求</h4>
        <span className="global-ai-count">
          {attention.length > 0 ? `${attention.length} 项待处理` : '都在正常状态'}
        </span>
      </header>

      {attention.length > 0 && (
        <ul className="global-ai-list">
          {attention.map((item) => (
            <li key={item.requestId} className={`global-ai-item global-ai-${item.phase}`}>
              <div className="global-ai-line">
                <span className="global-ai-kind">{kindLabel(item.kind)}</span>
                <span className="global-ai-file">
                  Journal #{item.fileId}{currentFileId === item.fileId ? '（当前这篇）' : ''}
                </span>
                <span className="global-ai-phase">{phaseLabel(item.phase)}</span>
              </div>
              <p className="global-ai-message">{item.message}</p>
              {item.mayHaveCharged && (item.phase === 'unknown' || item.phase === 'failed') && (
                <p className="global-ai-warn">
                  这次请求可能已经消耗 Token：不会自动重发，也不会换新的 request_id 重复付费。
                </p>
              )}
              <div className="global-ai-actions">
                {item.phase === 'running' || item.phase === 'unknown' ? (
                  <button type="button" disabled={disabled} onClick={() => onQuery(item.requestId)}>
                    查询状态
                  </button>
                ) : null}
                {item.phase === 'ready' && onApply !== undefined ? (
                  <button type="button" disabled={disabled} onClick={() => onApply(item.requestId)}>
                    写入正文
                  </button>
                ) : null}
                {onOpenFile !== undefined && currentFileId !== item.fileId && (
                  <button type="button" disabled={disabled} onClick={() => onOpenFile(item.fileId)}>
                    打开这篇
                  </button>
                )}
                {(item.phase === 'failed' || item.phase === 'conflict' || item.phase === 'unknown') && (
                  <button type="button" disabled={disabled} onClick={() => onForget(item.requestId)}>
                    清除入口
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {rest.length > 0 && (
        <p className="global-ai-rest">
          另有 {rest.length} 项已完成或已取消的请求（不占导航，也不影响继续写）。
        </p>
      )}

      <p className="global-ai-footnote">
        AI 处理期间可以继续写、可以切页；结果回来后会原位附着，不会把你带回别的页面。
      </p>
    </section>
  )
}

export default GlobalRequestStatus
