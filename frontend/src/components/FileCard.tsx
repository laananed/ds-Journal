import type { ContentFile, FileIdentity } from '../types/file'
import { formatServerTimestamp } from '../utils/journalDetail'
interface FileCardProps {
  file: ContentFile & { journal_date?: string }
  onOpen: (file: FileIdentity) => void
  selected?: boolean
  disabled?: boolean
}
/** 单个原生button覆盖整张卡片，鼠标、Enter和Space使用同一打开动作。 */
function FileCard({ file, onOpen, selected = false, disabled = false }: FileCardProps) {
  const typeLabel = { journal: 'Journal', inbox: 'Inbox', insight: 'Insight' }[file.type]
  return (
    <button type="button" className="file-card" onClick={() => onOpen({ type: file.type, id: file.id })}
      disabled={disabled} aria-current={selected ? 'true' : undefined}
      aria-label={`${typeLabel}：${file.display_title}，打开`}>
      <span className="journal-item-title" title={file.display_title}>{file.display_title}</span>
      <span className="journal-item-date">
        {typeLabel} · {file.journal_date ?? formatServerTimestamp(file.created_at)}
      </span>
      <span className="journal-item-content">{file.content}</span>
      <span className="journal-item-open">{selected ? '正在查看' : '打开'}</span>
    </button>
  )
}
export default FileCard
