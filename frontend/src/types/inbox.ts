import type { Block, ContentFile, FilePage } from './file'

/**
 * Inbox 的 `inbox_date` 与 `is_daily` 在创建时确定，编辑不可修改。
 * Daily 的身份靠这两个字段识别，而不是靠 title 是否等于日期。
 */
export interface Inbox extends ContentFile {
  type: 'inbox'
  inbox_date: string
  is_daily: boolean
  /** 仅在详情响应里出现；普通列表不返回 blocks。 */
  content_blocks?: Block[] | null
}
export type InboxPage = FilePage<Inbox>

/**
 * 创建请求。
 *
 * `title` 是唯一可选字段：省略时后端把 `inbox_date` 存成默认标题；
 * 显式提交 `null` / 空字符串表示主动无标题，原值分别保留。
 */
export interface InboxCreate {
  content: string
  inbox_date: string
  is_daily: boolean
  title?: string | null
  folder_id?: number | null
  client_create_id?: string
}

/** PATCH 实际提交的字段子集；只允许 title / content / folder_id。 */
export interface InboxUpdateFields {
  title?: string | null
  content?: string
  folder_id?: number | null
}

/** 对外 PATCH 请求体：Stage 3 起必须携带 expected_revision。 */
export interface InboxUpdate extends InboxUpdateFields {
  expected_revision: number
}

/** `GET /api/inboxes/daily` 只有 missing / active 两态；missing 不创建空行。 */
export interface DailyInboxState {
  state: 'missing' | 'active'
  id: number | null
  file: Inbox | null
}
