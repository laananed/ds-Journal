function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function checklistCandidates(document: unknown): { id: string; text: string }[] {
  const result: { id: string; text: string }[] = []
  const blocks = object(document)?.content
  if (!Array.isArray(blocks)) return result
  for (const raw of blocks) {
    const list = object(raw)
    if (list?.type !== 'taskList' || !Array.isArray(list.content)) continue
    for (const entry of list.content) {
      const item = object(entry)
      const attrs = object(item?.attrs)
      if (item?.type !== 'taskItem' || typeof attrs?.id !== 'string' || !Array.isArray(item.content) || item.content.length !== 1) continue
      const para = object(item.content[0])
      if (para?.type !== 'paragraph') continue
      let value = ''
      let valid = true
      for (const rawChild of Array.isArray(para.content) ? para.content : []) {
        const child = object(rawChild)
        if (!child || (Array.isArray(child.marks) && child.marks.length > 0)) { valid = false; break }
        if (child.type === 'text' && typeof child.text === 'string') value += child.text
        else if (child.type === 'hardBreak') value += '\n'
        else { valid = false; break }
      }
      if (valid && value.trim() && Array.from(value).length <= 2000) result.push({ id: attrs.id, text: value })
    }
  }
  return result
}

/** 自动请求仅在文件已保存且队列空闲时执行；失败项交由用户决定是否重试。 */
export function nextAutomaticGoal(document: unknown, kind: string, ready: boolean, attempted: ReadonlySet<string>): string | null {
  if (kind !== 'set' || !ready) return null
  return checklistCandidates(document).find((item) => !attempted.has(item.id))?.id ?? null
}

/**
 * 自动转目标的前置闸门（S04 输入法缺陷修复）。
 *
 * 单独抽成纯函数的原因：这是「预编辑拼音被固化成目标」的唯一防线。
 * `imeComposing` 一旦漏判，拼音会先落库、再被当作 taskItem 文本快照进
 * `goalItem.attrs.text`，刷新也不会自愈。把判定从页面里提出来用纯逻辑测试钉住，
 * 可以避免页面接线再次漏掉组合状态。
 */
export interface GoalConversionGate {
  /** 页面级写锁（AI 在途等外部原因）。 */
  disabled: boolean
  /** 页面自身的显式动作或保存正在执行。 */
  busy: boolean
  status: string
  inFlight: boolean
  /** 输入法组合中：预编辑内容尚未上屏。 */
  imeComposing: boolean
  /** 草稿仍有未提交改动。 */
  dirty: boolean
}

export function goalConversionReady(gate: GoalConversionGate): boolean {
  return !gate.disabled && !gate.busy && gate.status === 'saved'
    && !gate.inFlight && !gate.imeComposing && !gate.dirty
}
