/**
 * Journal 数据类型（Stage 1 / Task 8.1）。
 *
 * 与 `docs/stage1-api.md` 第 3 节的 Journal Object 一一对应，共六个字段。
 *
 * 日期与时间字段在前端**保持字符串**，不做 `Date` 转换：
 *
 * - `journal_date` 是 `YYYY-MM-DD` 的业务日期，一旦经 `new Date()` 解析再格式化，
 *   就会因本地时区产生日期偏移（例如把 2026-10-02 显示成 2026-10-01）；
 * - `created_at` / `updated_at` 是后端返回的时间戳字符串，本阶段只做展示，不需要计算。
 */
export interface Journal {
  id: number
  title: string | null
  content: string
  /** 业务日期，格式 `YYYY-MM-DD`，保持字符串。 */
  journal_date: string
  /** 创建时间字符串，保持字符串。 */
  created_at: string
  /** 更新时间字符串，保持字符串。 */
  updated_at: string
}
