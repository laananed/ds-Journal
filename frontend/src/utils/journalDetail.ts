/**
 * 详情 / 编辑视图的纯逻辑（Stage 1 / Task 8.3）。
 *
 * 这里不依赖 React，也不发任何请求，只做两件可以直接测试的事：
 *
 * 1. 由「原始 Journal + 编辑表单草稿」算出 PATCH 请求体，
 *    只包含用户**真正改过**的字段；
 * 2. 把后端返回的时间戳字符串排版成可读形式。
 *
 * 独立成文件的原因只有一个：这两段是纯函数，可以脱离浏览器用
 * `node --experimental-strip-types` 直接跑，不需要引入测试框架。
 */

import type { Journal, JournalUpdate } from '../types/journal.ts'

/**
 * 编辑表单里的三个字段。
 *
 * `title` 用**空字符串**表示「没有标题」：`<input type="text">` 的值只能是字符串，
 * 由 `draftTitleToValue()` 统一转成契约要求的 `null`。
 */
export interface JournalEditDraft {
  title: string
  content: string
  journal_date: string
}

/**
 * 把表单里的标题转成请求契约要求的取值：
 * 空字符串 → `null`（按创建表单同样的约定），其它字符串**原样保留**（不做 trim）。
 */
export function draftTitleToValue(title: string): string | null {
  return title === '' ? null : title
}

/**
 * 计算 PATCH 请求体，只包含与原始记录**真正不同**的字段。
 *
 * 几个刻意的行为：
 *
 * - 标题先经 `draftTitleToValue()` 归一化再比较，
 *   因此「原文标题本来就是 `null`」不会被空表单误判成一次修改；
 * - `content` 与 `journal_date` 只在值不同时出现；
 *   后端要求这两个字段不可为 `null`，所以它们只在「改成了别的合法值」时进入请求体；
 * - 比较的是原始记录的**当前值**，不是表单打开时的快照之外的东西；
 * - 一个字段都没变时返回 `{}`，沿用后端已确认的空更新语义
 *   （返回原记录、不改变 `updated_at`）。
 *
 * `id` / `created_at` / `updated_at` 不会出现在返回值里：
 * 它们由后端维护，前端不发送。
 */
export function buildJournalUpdate(
  original: Journal,
  draft: JournalEditDraft,
): JournalUpdate {
  const update: JournalUpdate = {}

  const nextTitle = draftTitleToValue(draft.title)
  if (nextTitle !== original.title) {
    update.title = nextTitle
  }

  if (draft.content !== original.content) {
    update.content = draft.content
  }

  if (draft.journal_date !== original.journal_date) {
    update.journal_date = draft.journal_date
  }

  return update
}

/** 请求体是否为空，也就是「用户什么都没改」。 */
export function isJournalUpdateEmpty(update: JournalUpdate): boolean {
  return Object.keys(update).length === 0
}

/**
 * 详情面板的展示标题（Stage 1.5 / S1.5-T2）。
 *
 * 规则：`title` 为 `null` **或空字符串**时显示 `journal_date`；
 * 非空标题（含纯空白的「手工标题」）原样显示，**不做 trim**。
 *
 * 与列表的「无标题」判定保持一致（`null` 与 `''` 都算无标题），
 * 但**不引入**列表里的同日编号——编号是列表上下文的产物，
 * 详情只需要「标题，没有标题就用日期」这一条规则。
 *
 * 这里只影响**显示**：数据库里的空字符串不会被改写或归一化。
 */
export function displayJournalTitle(
  title: string | null,
  journalDate: string,
): string {
  return title === null || title === '' ? journalDate : title
}

/**
 * 排版后端返回的时间戳字符串，只做**字符串层面**的整理：
 *
 * ```text
 * 2026-10-06T09:33:15.123456+00:00  →  2026-10-06 09:33:15+00:00
 * ```
 *
 * 刻意**不使用 `new Date()`**：那会把时间换算到浏览器本地时区，
 * 而 Stage 1 只要求如实展示后端记录的创建 / 修改时间，
 * 换算带来的偏移会让「刚刚保存过」看起来像别的时间。
 *
 * 遇到不认识的格式时原样返回，不做猜测。
 */
export function formatServerTimestamp(value: string): string {
  const separatorIndex = value.indexOf('T')
  if (separatorIndex <= 0) {
    return value
  }

  const datePart = value.slice(0, separatorIndex)
  const timePart = value.slice(separatorIndex + 1)

  const seconds = /^(\d{2}:\d{2}:\d{2})/.exec(timePart)
  if (seconds === null) {
    return value
  }

  const zone = /([+-]\d{2}:\d{2}|Z)$/.exec(timePart)

  return `${datePart} ${seconds[1]}${zone === null ? '' : zone[1]}`
}
