/** Journal 编辑的纯逻辑。只提交真实修改的原始字段，日期与时间保留字符串。 */
import type { Journal, JournalUpdateFields } from '../types/journal.ts'

export interface JournalEditDraft {
  title: string
  content: string
  journal_date: string
  /** S2-T08：null 为「无 Folder」，与请求契约一致。 */
  folder_id: number | null
}
/** 空输入清空已有标题；非空字符串原样保存，不trim。 */
export function draftTitleToValue(title: string): string | null {
  return title === '' ? null : title
}
export function buildJournalUpdate(original: Journal, draft: JournalEditDraft): JournalUpdateFields {
  const update: JournalUpdateFields = {}
  // 初始输入把NULL显示成空串。先比较输入与初始展示值，避免未编辑的历史空串被改成NULL。
  if (draft.title !== (original.title ?? '')) update.title = draftTitleToValue(draft.title)
  if (draft.content !== original.content) update.content = draft.content
  if (draft.journal_date !== original.journal_date) update.journal_date = draft.journal_date
  // Folder 真实变化才进 PATCH：null 表示移出 Folder，未变化不制造更新。
  if (draft.folder_id !== original.folder_id) update.folder_id = draft.folder_id
  return update
}
export function isJournalUpdateEmpty(update: JournalUpdateFields): boolean {
  return Object.keys(update).length === 0
}
/** Stage1.5显示格式的历史回归。当前UI使用服务器display_title。 */
export function displayJournalTitle(title: string | null, journalDate: string): string {
  return title === null || title === '' ? journalDate : title
}
/** 不做时区换算，仅排版服务器时间戳。 */
export function formatServerTimestamp(value: string): string {
  const separatorIndex = value.indexOf('T')
  if (separatorIndex <= 0) return value
  const datePart = value.slice(0, separatorIndex)
  const timePart = value.slice(separatorIndex + 1)
  const seconds = /^(\d{2}:\d{2}:\d{2})/.exec(timePart)
  if (seconds === null) return value
  const zone = /([+-]\d{2}:\d{2}|Z)$/.exec(timePart)
  return `${datePart} ${seconds[1]}${zone === null ? '' : zone[1]}`
}
