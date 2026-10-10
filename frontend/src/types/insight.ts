import type { ContentFile, FilePage } from './file'

/**
 * Insight 是三类文件里字段最少的一种：**没有所属日期**，
 * 也没有来源 Journal、AI 状态等字段。
 */
export interface Insight extends ContentFile {
  type: 'insight'
}
export type InsightPage = FilePage<Insight>

/**
 * 创建请求：只有 `content` 必填。
 *
 * `title` 可省略 / `null`；空标题由后端投影成「未命名 Insight」，
 * **没有**类似 Inbox 的「省略即用业务日期做默认标题」规则。
 */
export interface InsightCreate {
  content: string
  title?: string | null
  folder_id?: number | null
  client_create_id?: string
}

/** PATCH 实际提交的字段子集；省略表示不修改。 */
export interface InsightUpdateFields {
  title?: string | null
  content?: string
  folder_id?: number | null
}

/** 对外 PATCH 请求体：Stage 3 起必须携带 expected_revision。 */
export interface InsightUpdate extends InsightUpdateFields {
  expected_revision: number
}
