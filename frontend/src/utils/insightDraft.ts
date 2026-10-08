/**
 * Insight 编辑的纯逻辑（Stage 2 / S2-T06）。
 *
 * 关键规则来自 `docs/stage2-api.md` 第 5 节：
 *
 * - Insight **没有**所属日期，也没有「省略标题就用日期做默认标题」的规则；
 *   空标题由后端投影成「未命名 Insight」，**不写回**原始 `title`；
 * - 编辑框始终使用**原始** `title`（`null` 显示成空串），
 *   绝不把展示用的 `display_title` 回退值写回数据库；
 * - PATCH 省略字段表示不变，只提交真正改动的字段；清空标题显式提交 `null`。
 *
 * 创建和编辑均提交用户选择的 Folder；null 表示无 Folder。
 *
 * 本文件不依赖 React、不发请求，可用 `node --experimental-strip-types` 直接测试。
 */

import type { Insight, InsightCreate, InsightUpdate } from '../types/insight.ts'
import { draftTitleToValue } from './journalDetail.ts'

/** 创建与编辑共用的表单草稿；null 表示无 Folder。 */
export interface InsightEditDraft {
  title: string
  content: string
  folder_id: number | null
}

/** 把服务端记录转成表单草稿：`title` 为 `null` 时显示成空串，**不**回退成展示标题。 */
export function toInsightDraft(insight: Insight): InsightEditDraft {
  return { title: insight.title ?? '', content: insight.content, folder_id: insight.folder_id }
}

/**
 * 构造创建请求。
 *
 * `title` 显式提交：空输入（空串）按既有约定转成 `null`，
 * 后端把它保存为「无标题」，展示时投影成「未命名 Insight」。
 * 非空标题（含纯空白）原样提交，不 trim。
 */
export function buildInsightCreate(draft: InsightEditDraft): InsightCreate {
  return { content: draft.content, title: draftTitleToValue(draft.title), folder_id: draft.folder_id }
}

/**
 * 构造更新请求，只包含真正改动的字段。
 *
 * 初始输入把 `null` 显示成空串；比较输入与初始展示值，
 * 避免未编辑的历史 `title=null` / `title=""` 被误改成另一种空值。
 */
export function buildInsightUpdate(original: Insight, draft: InsightEditDraft): InsightUpdate {
  const update: InsightUpdate = {}
  if (draft.title !== (original.title ?? '')) update.title = draftTitleToValue(draft.title)
  if (draft.content !== original.content) update.content = draft.content
  // Folder 真实变化才进 PATCH：null 表示移出 Folder，未变化不制造更新。
  if (draft.folder_id !== original.folder_id) update.folder_id = draft.folder_id
  return update
}

/** 更新请求是否为空（没有任何字段需要提交）。 */
export function isInsightUpdateEmpty(update: InsightUpdate): boolean {
  return Object.keys(update).length === 0
}
