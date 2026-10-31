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
