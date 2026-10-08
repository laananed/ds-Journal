import { pageCount } from '../utils/pagination'
interface PaginationProps {
  page: number
  total: number
  hasNext: boolean
  onPageChange: (page: number) => void
  disabled?: boolean
  label?: string
}
function Pagination({ page, total, hasNext, onPageChange, disabled = false, label = '列表分页' }: PaginationProps) {
  return (
    <nav className="pagination" aria-label={label}>
      <button type="button" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>上一页</button>
      <span>第 {page} / {pageCount(total)} 页 · 共 {total} 篇</span>
      <button type="button" disabled={disabled || !hasNext} onClick={() => onPageChange(page + 1)}>下一页</button>
    </nav>
  )
}
export default Pagination
