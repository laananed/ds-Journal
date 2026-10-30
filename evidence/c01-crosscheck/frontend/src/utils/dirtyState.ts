export interface ContentDraft {
  title: string
  content: string
  journal_date?: string
  folder_id?: number | null
}
/** 比较原始输入；默认值是基线，恢复到基线后就不再 Dirty。 */
export function isDraftDirty(initial: ContentDraft, current: ContentDraft): boolean {
  return initial.title !== current.title ||
    initial.content !== current.content ||
    initial.journal_date !== current.journal_date ||
    initial.folder_id !== current.folder_id
}
