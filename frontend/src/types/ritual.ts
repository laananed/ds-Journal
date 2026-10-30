import type { Journal } from './journal'
export interface BusinessDay { timezone: 'Asia/Shanghai'; day_start_hour: 4; server_time: string; business_date: string }
export interface Rituals { journal_date: string; set: Journal | null; end: Journal | null }
export interface RitualQuestion { id: string; text: string }
export interface RitualTemplates { set: { questions: RitualQuestion[]; revision: number }; end: { questions: RitualQuestion[]; revision: number } }
export type RitualKind = 'set' | 'end'
export interface RitualSelection { node_id: string; from?: number; to?: number }
export interface RitualCopyRequest {
  source_revision: number
  target_id: number
  expected_target_revision: number
  copy_id: string
  selection: RitualSelection[]
  insert_after_node_id: string
  related_revisions: Array<{ type: string; id: number; revision: number }>
}
export interface RitualRestoreRequest {
  target_id: number
  expected_target_revision: number
  related_revisions: Array<{ type: string; id: number; revision: number }>
}
export interface RitualMutation {
  files: Journal[]
  effects: Array<{ type: 'journal'; id: number; base_revision: number; revision: number; ops: Array<{ kind: string }> }>
  request_id: null
}
