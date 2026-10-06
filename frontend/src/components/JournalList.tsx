/**
 * Journal 列表展示组件（Stage 1 / Task 8.1 列表，Task 8.2 同日编号，
 * Task 8.3 增加「打开详情」入口）。
 *
 * 纯展示：只接收父组件传入的 `journals`，不自己发请求、不改数据。
 *
 * 显示规则（`docs/stage1-api.md` 第 13 节）：
 *
 * - `title` 为 `null` 时，用 `journal_date` 作为显示标题；
 * - 同一天有多篇无标题记录时依次显示 `2026-10-02`、`2026-10-02 (2)`、`2026-10-02 (3)`；
 * - `(n)` 只存在于 UI：既不进入 API，也不写回数据库，
 *   `Journal` 对象与数据库里的 `title` 始终保持 `null`；
 * - 编号只在**无标题**记录之间累加；有自定义标题的记录不消耗编号；
 * - 有标题时按后端返回的原样显示，不做 `trim` 或其它规范化；
 * - 列表顺序完全沿用后端返回顺序（后端已按
 *   `journal_date DESC`、同时刻 `created_at DESC` 排好），前端不再排序；
 * - 以 `id` 作为 React key；
 * - 正文用普通文本渲染，不使用 `dangerouslySetInnerHTML`。
 *
 * 每条记录带一个「打开」入口：点它只把 `id` 交给父组件，
 * 由父组件去真实请求详情接口——列表里的这条数据不当作详情使用。
 * 主列表与创建表单的「当天已有记录」复用本组件，
 * 因此两处的标题、编号与打开行为天然一致。
 */

import type { Journal } from '../types/journal'

interface JournalListProps {
  journals: Journal[]
  /** 打开某一篇的详情（传入主键）。 */
  onOpen: (id: number) => void
  /** 当前已打开的 id，用于标出「正在查看」的那一条。 */
  selectedId?: number | null
  /**
   * 是否禁用打开入口。
   * 父组件在有写操作（保存 / 删除）进行中时传 `true`，
   * 避免在写入过程中切换目标。
   */
  openDisabled?: boolean
}

/**
 * 计算每条记录的显示标题。
 *
 * 按传入顺序遍历：无标题记录按 `journal_date` 分别计数，
 * 第 n 篇显示为 `日期` 或 `日期 (n)`。
 */
function buildDisplayTitles(journals: Journal[]): Map<number, string> {
  const counters = new Map<string, number>()
  const displayTitles = new Map<number, string>()

  for (const journal of journals) {
    if (journal.title !== null) {
      displayTitles.set(journal.id, journal.title)
      continue
    }

    const nextIndex = (counters.get(journal.journal_date) ?? 0) + 1
    counters.set(journal.journal_date, nextIndex)
    displayTitles.set(
      journal.id,
      nextIndex === 1 ? journal.journal_date : `${journal.journal_date} (${nextIndex})`,
    )
  }

  return displayTitles
}

function JournalList({
  journals,
  onOpen,
  selectedId = null,
  openDisabled = false,
}: JournalListProps) {
  const displayTitles = buildDisplayTitles(journals)

  return (
    <ul className="journal-list">
      {journals.map((journal) => {
        const displayTitle = displayTitles.get(journal.id) ?? journal.journal_date
        const hasCustomTitle = journal.title !== null
        const isSelected = journal.id === selectedId

        return (
          <li
            key={journal.id}
            className="journal-item"
            aria-current={isSelected ? 'true' : undefined}
          >
            <h2 className="journal-item-title">{displayTitle}</h2>
            {hasCustomTitle && (
              <p className="journal-item-date">{journal.journal_date}</p>
            )}
            <p className="journal-item-content">{journal.content}</p>
            <div className="journal-item-actions">
              <button
                type="button"
                onClick={() => onOpen(journal.id)}
                disabled={openDisabled}
              >
                {isSelected ? '正在查看' : '打开'}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export default JournalList
