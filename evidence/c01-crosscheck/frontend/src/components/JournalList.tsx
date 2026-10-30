import type { Journal } from '../types/journal'
import FileCard from './FileCard'
interface JournalListProps {
  journals: Journal[]
  onOpen: (id: number) => void
  selectedId?: number | null
  openDisabled?: boolean
}
/** 只显示服务器display_title；禁止在分页items上重算同日编号。 */
function JournalList({ journals, onOpen, selectedId = null, openDisabled = false }: JournalListProps) {
  return (
    <ul className="journal-list">
      {journals.map((journal) => (
        <li key={`${journal.type}:${journal.id}`}>
          <FileCard file={journal} onOpen={(file) => onOpen(file.id)}
            selected={journal.id === selectedId} disabled={openDisabled} />
        </li>
      ))}
    </ul>
  )
}
export default JournalList
