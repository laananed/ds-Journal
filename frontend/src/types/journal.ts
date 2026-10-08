import type { ContentFile, FilePage } from './file'
/** 日期与时间保留服务器字符串，避免业务日期时区偏移。 */
export interface Journal extends ContentFile {
  type: 'journal'
  journal_date: string
}
export type JournalPage = FilePage<Journal>
export interface JournalCreate {
  title: string | null
  content: string
  journal_date: string
  folder_id?: number | null
}
export interface JournalUpdate {
  title?: string | null
  content?: string
  journal_date?: string
  folder_id?: number | null
}
