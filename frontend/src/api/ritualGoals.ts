import { JournalApiError } from './journals.ts'
import { journalToServerFile } from '../state/journalSession.ts'
import type { FileEffect, FileMutation } from '../state/editSessions.ts'
import type { Journal } from '../types/journal.ts'

export interface GoalLinkRequest {
  source_set_id: number
  goal_ids: string[]
  expected_set_revision: number
  end_id: number | null
  expected_end_revision: number
  client_create_id?: string
  draft_started_at?: string
}
export interface GoalUpdateRequest {
  expected_set_revision: number
  expected_end_revision?: number
  text?: string
  checked?: boolean
}
export interface GoalLinkIdentity {
  link_id: string
  set_id: number
  end_id: number
  goal_id: string
  end_node_id: string
}
export type GoalJournalDetail = Journal & {
  goal_links?: GoalLinkIdentity[]
  related_revisions?: Array<{ type: 'journal'; id: number; revision: number }>
  file_mutation?: GoalMutationResponse | null
}
export interface GoalMutationResponse {
  files: Journal[]
  effects: FileEffect[]
  request_id: string | null
}

/** Adapt the HTTP shape to T02's application-level session shape. */
export function toGoalFileMutation(result: GoalMutationResponse): FileMutation {
  return { files: result.files.map(file => ({ type: 'journal', file: journalToServerFile(file) })),
    effects: result.effects, request_id: result.request_id }
}

/** The PATCH transport already acknowledges its own file; apply only its peers. */
export function relatedMutationFromPatch(file: GoalJournalDetail): FileMutation | null {
  if (!file.file_mutation) return null
  const result = toGoalFileMutation(file.file_mutation)
  return { ...result, files: result.files.filter(item => item.file.id !== file.id),
    effects: result.effects.filter(effect => effect.id !== file.id) }
}

async function command(path: string, method: 'POST' | 'PATCH', payload: unknown): Promise<FileMutation> {
  const configured: unknown = import.meta.env.VITE_API_BASE_URL
  const base = (typeof configured === 'string' && configured.trim() ? configured.trim() : 'http://127.0.0.1:8000').replace(/\/+$/, '')
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined
    throw new JournalApiError(response.status, `目标操作失败（HTTP ${response.status}）`, code)
  }
  return toGoalFileMutation(await response.json() as GoalMutationResponse)
}

export function linkGoals(payload: GoalLinkRequest): Promise<FileMutation> {
  return command('/api/ritual-goal-links', 'POST', payload)
}

export function updateGoal(setId: number, goalId: string, payload: GoalUpdateRequest): Promise<FileMutation> {
  return command(`/api/ritual-goals/${setId}/${encodeURIComponent(goalId)}`, 'PATCH', payload)
}
