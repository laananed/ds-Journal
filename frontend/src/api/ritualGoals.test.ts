import { relatedMutationFromPatch, toGoalFileMutation } from './ritualGoals.ts'
import type { Journal } from '../types/journal.ts'

const file = { type: 'journal', id: 12, revision: 4, title: null, journal_date: '2026-10-30',
  display_title: 'test', content: 'test', created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T00:00:00Z', deleted_at: null,
  folder_id: null, content_doc: { type: 'doc', content: [] } } as Journal
const result = toGoalFileMutation({ files: [file], effects: [{ type: 'journal', id: 12,
  base_revision: 3, revision: 4, ops: [{ kind: 'goal_fields', node_id: 'node' }] }], request_id: null })
if (result.files[0].file.id !== 12 || result.files[0].file.revision !== 4 ||
    result.files[0].file.draft.content_doc !== file.content_doc ||
    result.effects[0].ops[0].node_id !== 'node') throw new Error('FileMutation 适配丢失身份、正文或效果')
const other = { ...file, id: 13 }
const related = relatedMutationFromPatch({ ...file, file_mutation: { files: [file, other], effects: [
  { type: 'journal', id: 12, base_revision: 3, revision: 4, ops: [] },
  { type: 'journal', id: 13, base_revision: 3, revision: 4, ops: [{ kind: 'goal_fields', node_id: 'node' }] },
], request_id: null } })
if (related?.effects.length !== 1 || related.effects[0].id !== 13 || related.files.length !== 1)
  throw new Error('PATCH 附带效果只应再次应用其他文件')
