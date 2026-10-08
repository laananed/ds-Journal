import type { ContentFile, FilePage } from './file'

/**
 * Inbox 的 `inbox_date` 与 `is_daily` 在创建时确定，编辑不可修改。
 * Daily 的身份靠这两个字段识别，而不是靠 title 是否等于日期。
 */
export interface Inbox extends ContentFile {
  type: 'inbox'
  inbox_date: string
  is_daily: boolean
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
}

/** 修改只允许 title / content / folder_id；日期与 Daily 身份不可改。 */
export interface InboxUpdate {
  title?: string | null
  content?: string
  folder_id?: number | null
}

/** `GET /api/inboxes/daily` 只有 missing / active 两态；missing 不创建空行。 */
export interface DailyInboxState {
  state: 'missing' | 'active'
  id: number | null
  file: Inbox | null
}
