import type { ContentDocument } from '../types/document.ts'

type RelatedRevision = { type: 'journal'; id: number; revision: number }
type GoalMetadata = {
  goal_links?: ReadonlyArray<{ goal_id: string; end_id: number | null }>
  related_revisions?: ReadonlyArray<RelatedRevision>
}

export function goalRelatedRevisions(before: ContentDocument | null | undefined, after: ContentDocument | null | undefined, metadata: GoalMetadata): RelatedRevision[] {
  const goals = (doc: ContentDocument | null | undefined) => new Map((doc?.content ?? [])
    .filter((node) => node.type === 'goalItem')
    .map((node) => [node.attrs.goal_id, node.attrs] as const))
  const oldGoals = goals(before)
  const newGoals = goals(after)
  const changed = new Set([...oldGoals.keys(), ...newGoals.keys()].filter((id) => {
    const a = oldGoals.get(id); const b = newGoals.get(id)
    return a === undefined || b === undefined || a.text !== b.text || a.checked !== b.checked || a.id !== b.id
  }))
  const ids = new Set((metadata.goal_links ?? []).filter((link) => changed.has(link.goal_id)).map((link) => link.end_id))
  if (ids.has(null)) throw new Error('关联目标的复盘不可用，请重新读取后再保存。')
  const available = metadata.related_revisions ?? []
  return [...ids].map((id) => {
    const revision = available.find((item) => item.id === id && item.type === 'journal')
    if (revision === undefined) throw new Error('关联复盘的版本未知，请重新读取后再保存。')
    return revision
  }).sort((a, b) => a.id - b.id)
}

export function validGoalText(value: string): boolean {
  return value.trim().length > 0 && Array.from(value).length <= 2000
}

export function editGoalText(doc: ContentDocument, goalId: string, text: string): ContentDocument {
  const content = doc.content.map((node) => node.type === 'goalItem' && node.attrs.goal_id === goalId
    ? { ...node, attrs: { ...node.attrs, text } }
    : node)
  return { ...doc, content }
}
