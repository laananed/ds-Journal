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

/**
 * 创建 Journal 的请求体（Stage 1 / Task 8.2）。
 *
 * 对应 `POST /api/journals` 的请求契约，只包含客户端可以提供的三个字段；
 * `id` / `created_at` / `updated_at` 由后端生成，
 * 这里**不声明**，避免前端把它们发出去。
 *
 * - `title`：传 `null` 表示不设标题（不是空字符串）；
 * - `content`：必填，但允许空字符串；
 * - `journal_date`：必填，`YYYY-MM-DD`。
 */
export interface JournalCreate {
  title: string | null
  content: string
  journal_date: string
}

/**
 * 修改 Journal 的请求体（Stage 1 / Task 8.3）。
 *
 * 对应 `PATCH /api/journals/{id}`，三个可更新字段**都可以省略**：
 *
 * - 省略表示「本次不修改该字段」，**不是**把该字段置成 `null`；
 * - `title`：省略不修改；显式 `null` 表示清空标题；字符串（含空字符串）原样保留；
 * - `content`：省略不修改；一旦提交必须是字符串，**不允许 `null`**；
 * - `journal_date`：省略不修改；一旦提交必须是 `YYYY-MM-DD`，**不允许 `null`**。
 *
 * `id` / `created_at` / `updated_at` 由后端维护，
 * 这里刻意不声明，避免前端把它们放进请求体。
 *
 * 三个字段都是可选的，因此 `{}` 是合法请求体：
 * 后端对空更新返回当前记录且不改变 `updated_at`。
 */
export interface JournalUpdate {
  title?: string | null
  content?: string
  journal_date?: string
}
