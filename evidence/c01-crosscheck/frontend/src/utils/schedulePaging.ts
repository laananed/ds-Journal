/**
 * 独立日程（C01）的分页收敛纯逻辑。
 *
 * 为什么单独一个文件：D2 的问题是「删除末页最后一条后，页面停在一个空页上，
 * 却显示『还没有日程』」——这是**分页判定**错误，不是渲染错误。
 * 把判定抽成纯函数，就能在没有 React 测试运行器的前提下用 node 直接验证，
 * 页面只负责执行判定结果。
 *
 * 契约依据 `docs/stage4-api.md` §13：`GET /api/schedules?page=N` 返回
 * `{items,page,has_next}`，每页 20。§13 没有定义「请求越界页码」的行为，
 * 因此这里**不假设**服务端会 clamp，而是按「读到的空页」自行收敛。
 */

/** 读取结果中与分页判定有关的最小形状（便于测试构造，不绑定 Schedule）。 */
export type SchedulePageShape = {
  /** 服务端回显的页码。 */
  page: number
  /** 本页条目（只关心条数）。 */
  items: readonly unknown[]
}

/**
 * 读到的页为空且不在第一页时，应回退到的页码；不需要回退时返回 `null`。
 *
 * 只退**一页**：一次删除最多让一页变空，逐页回退（而不是直接跳第一页）
 * 既符合「回到有效的前一页」，也不会在并发删除时跳过中间仍有效的数据。
 * 第一页为空表示整体确实没有日程，此时不回退，交给正常的空状态文案。
 *
 * `page` 不是合法整数（脏数据）时不回退，避免 `page - 1` 产生 0 或 NaN 造成死循环。
 */
export function pageAfterEmptyRead(result: SchedulePageShape): number | null {
  if (result.items.length > 0) return null
  if (!Number.isInteger(result.page) || result.page <= 1) return null
  return result.page - 1
}
