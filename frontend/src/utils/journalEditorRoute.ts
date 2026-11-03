import type { Journal } from '../types/journal.ts'

/** Never send a legacy body update to a structured document. */
export function journalEditorRoute(journal: Pick<Journal, 'journal_kind' | 'content_doc'>): 'legacy' | 'structured' | 'ritual' {
  if (journal.content_doc == null) return 'legacy'
  if (journal.journal_kind === 'set' || journal.journal_kind === 'end') return 'ritual'
  return 'structured'
}
