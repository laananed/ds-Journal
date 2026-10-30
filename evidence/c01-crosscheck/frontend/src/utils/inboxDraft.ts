/**
 * Inbox 编辑的纯逻辑（Stage 2 / S2-T05）。
 *
 * 关键规则来自 `docs/stage2-api.md` 第 4 节与 `docs/stage2.md` §15 的 P1/P2：
 *
 * - **创建时省略 `title`**：后端把本次请求的 `inbox_date` 存成默认标题。
 *   因此「用户没有编辑标题」必须**省略** title，而不是提交空值。
 * - **主动清空标题**：必须显式提交 `null`（或空串），不能省略成默认创建。
 * - **PATCH 省略字段表示不变**，只提交真正改动的字段；清空必须显式提交。
 *
 * `inbox_date` 与 `is_daily` 创建后不可修改，所以不进入更新请求。
 *
 * 本文件不依赖 React、不发请求，可用 `node --experimental-strip-types` 直接测试。
 */

import type { DailyInboxState, Inbox, InboxCreate, InboxUpdateFields } from '../types/inbox.ts'
import { draftTitleToValue } from './journalDetail.ts'

/** 创建与编辑共用的表单草稿；null 表示无 Folder。 */
export interface InboxEditDraft {
  title: string
  content: string
  folder_id: number | null
}

/** 把服务端记录转成表单草稿：`title` 为 null 时显示成空串，但**不**回退成日期。 */
export function toInboxDraft(inbox: Inbox): InboxEditDraft {
  return { title: inbox.title ?? '', content: inbox.content, folder_id: inbox.folder_id }
}

export interface InboxCreateContext {
  inboxDate: string
  isDaily: boolean
  /** 用户是否真正编辑过标题输入框。 */
  titleEdited: boolean
}

/**
 * 构造创建请求。
 *
 * - `titleEdited === false`：省略 `title`，让后端存日期默认标题；
 * - `titleEdited === true`：显式提交标题；清空（空串）按既有约定转成 `null`。
 */
export function buildInboxCreate(draft: InboxEditDraft, context: InboxCreateContext): InboxCreate {
  const payload: InboxCreate = {
    content: draft.content,
    inbox_date: context.inboxDate,
    is_daily: context.isDaily,
    folder_id: draft.folder_id,
  }
  if (context.titleEdited) {
    payload.title = draftTitleToValue(draft.title)
  }
  return payload
}

/**
 * 构造更新请求，只包含真正改动的字段。
 *
 * 初始输入把 `null` 显示成空串；比较输入与初始展示值，
 * 避免未编辑的历史 `title=null` / `title=""` 被误改成另一种空值。
 */
export function buildInboxUpdate(original: Inbox, draft: InboxEditDraft): InboxUpdateFields {
  const update: InboxUpdateFields = {}
  if (draft.title !== (original.title ?? '')) update.title = draftTitleToValue(draft.title)
  if (draft.content !== original.content) update.content = draft.content
  // Folder 真实变化才进 PATCH：null 表示移出 Folder，未变化不制造更新。
  if (draft.folder_id !== original.folder_id) update.folder_id = draft.folder_id
  return update
}

/** 每日入口的两种目标：已有记录直接打开，否则打开空编辑器（不创建）。 */
export type DailyEntryPlan = { kind: 'existing'; id: number } | { kind: 'missing' }

/**
 * 根据只读 Daily 查询结果决定进入方式。
 *
 * `active` 但缺少 id 属于异常响应，按 missing 处理，避免拿空身份去请求详情。
 */
export function planDailyEntry(state: DailyInboxState): DailyEntryPlan {
  if (state.state === 'active' && typeof state.id === 'number') {
    return { kind: 'existing', id: state.id }
  }
  return { kind: 'missing' }
}
