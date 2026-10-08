/** Stage 2 文件的共有只读字段。跨类型身份是 type + id。 */
export type FileType = 'journal' | 'inbox' | 'insight'
export interface FileIdentity { type: FileType; id: number }
export interface ContentFile extends FileIdentity {
  title: string | null
  display_title: string
  content: string
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
