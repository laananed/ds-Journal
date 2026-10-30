import type { ReactNode } from 'react'
import { GoalActions } from './GoalActions'
import './GoalReview.css'

type GoalReviewProps = {
  title: string
  goalText: string
  checked: boolean
  sourceAvailable: boolean
  busy?: boolean
  onToggle: (checked: boolean) => void
  onGoalTextChange: (value: string) => void
  children: ReactNode
}

/** The answer is supplied by the editor and is never reconstructed by this component. */
export function GoalReview({ title, goalText, checked, sourceAvailable, busy = false,
  onToggle, onGoalTextChange, children }: GoalReviewProps) {
  return <section className="goal-review" aria-label="目标回顾">
    <h3>{title}</h3>
    <label>目标
      <input value={goalText} disabled={!sourceAvailable || busy}
        onChange={event => onGoalTextChange(event.target.value)} />
    </label>
    {!sourceAvailable && <p role="status">目标来源不可用，已保留原有回顾和回答。</p>}
    <GoalActions checked={checked} available={sourceAvailable} busy={busy} onToggle={onToggle} />
    <div className="goal-review-answer">{children}</div>
  </section>
}
