type GoalActionsProps = {
  checked: boolean
  available: boolean
  busy?: boolean
  onToggle: (checked: boolean) => void
  onAddToEnd?: () => void
}

/** Controlled actions: the caller routes writes through the file command queue. */
export function GoalActions({ checked, available, busy = false, onToggle, onAddToEnd }: GoalActionsProps) {
  return <div className="goal-actions">
    <button type="button" disabled={!available || busy} onClick={() => onToggle(!checked)}>
      {checked ? '标记为未完成' : '标记为完成'}
    </button>
    {onAddToEnd && <button type="button" disabled={!available || busy} onClick={onAddToEnd}>加入结束今天</button>}
  </div>
}
