/**
 * Journal 列表展示组件（Stage 1 / Task 8.1）。
 *
 * 纯展示：只接收父组件传入的 `journals`，不自己发请求、不改数据。
 *
 * 显示规则：
 *
 * - `title` 为 `null` 时，用 `journal_date` 作为显示标题（**仅 UI**，不写回数据库）；
 * - 有标题时按后端返回的原样显示，不做 `trim` 或其它规范化；
 * - 列表顺序完全沿用后端返回顺序（后端已按
 *   `journal_date DESC`、同时刻 `created_at DESC` 排好），前端不再排序；
 * - 以 `id` 作为 React key；
 * - 正文用普通文本渲染，不使用 `dangerouslySetInnerHTML`。
 */

import type { Journal } from '../types/journal'

interface JournalListProps {
  journals: Journal[]
}

function JournalList({ journals }: JournalListProps) {
  return (
    <ul className="journal-list">
      {journals.map((journal) => {
        // title 为 null 时回退到日期；有标题时只用标题。
        const displayTitle = journal.title ?? journal.journal_date
        const hasCustomTitle = journal.title !== null

        return (
          <li key={journal.id} className="journal-item">
            <h2 className="journal-item-title">{displayTitle}</h2>
            {hasCustomTitle && (
              <p className="journal-item-date">{journal.journal_date}</p>
            )}
            <p className="journal-item-content">{journal.content}</p>
          </li>
        )
      })}
    </ul>
  )
}

export default JournalList
