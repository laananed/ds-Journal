import type { FileIdentity, FilePage } from './file'

export interface LinkCandidate extends FileIdentity {
  title: string | null
  display_title: string
  journal_date?: string
  created_at: string
}
export type LinkPage = FilePage<LinkCandidate>
