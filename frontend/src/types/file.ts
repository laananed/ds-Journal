/** Stage 2 文件的共有只读字段。跨类型身份是 type + id。 */
export type FileType = 'journal' | 'inbox' | 'insight'
export interface FileIdentity { type: FileType; id: number }

/**
 * Stage 3 结构化正文块（`docs/stage3-api.md` §2）。
 *
 * 只声明读取所需的字段；本期（T02）不发送 content_blocks，
 * 仅在读取详情时用它判断「这个文件是否已经是结构化文件」。
 */
export interface Block {
  id: string
  kind: 'user' | 'ai_reply' | 'ai_summary'
  text: string
  request_id?: string
}

export interface ContentFile extends FileIdentity {
  title: string | null
  display_title: string
  content: string
  /** Stage 3 版本号：每次真实内容修改 +1，PATCH / 删除用它做条件写。 */
  revision: number
  folder_id: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}
export interface FilePage<T> {
  items: T[]
  page: number
  page_size: number
  total: number
  has_next: boolean
}
