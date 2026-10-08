export const PAGE_SIZE = 20
export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE))
}
/** 删除后页面越界，读取最近有效页；无结果时保持第 1 页。 */
export function nearestValidPage(page: number, total: number): number {
  return Math.min(page, pageCount(total))
}
