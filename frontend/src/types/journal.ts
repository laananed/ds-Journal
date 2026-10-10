import type { Block, ContentFile, FilePage } from './file'
/** 日期与时间保留服务器字符串，避免业务日期时区偏移。 */
export interface Journal extends ContentFile {
  type: 'journal'
  journal_date: string
  /** 仅在详情响应里出现；普通列表不返回 blocks。 */
  content_blocks?: Block[] | null
}
export type JournalPage = FilePage<Journal>

/** 创建请求；Stage 3 起 UI 必须携带稳定的 client_create_id。 */
export interface JournalCreate {
  title: string | null
  content: string
  journal_date: string
  folder_id?: number | null
  client_create_id?: string
}

/** PATCH 实际提交的字段子集（只包含真正改动的字段）。 */
export interface JournalUpdateFields {
  title?: string | null
  content?: string
  journal_date?: string
  folder_id?: number | null
}

/** 对外 PATCH 请求体：Stage 3 起必须携带 expected_revision。 */
export interface JournalUpdate extends JournalUpdateFields {
  expected_revision: number
}
