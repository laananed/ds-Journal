/**
 * 创建 / 编辑请求体的输入校验（Stage 1.5 / S1.5-T2）。
 *
 * 规则来自 `docs/stage1.5-bugfix.md` 第 2 节「Bug 2 / Bug 4」，
 * 与后端 `backend/app/journal/schemas.py` 保持**同一套口径**：
 *
 * - `title`：可省略 / `null` / 空字符串，最多 80 个 Unicode 码点；
 *   非空标题原样保留（不 trim），纯空白但非空的标题仍算手工标题、不拒绝；
 * - `content`：原始字符串最多 50,000 个 Unicode 码点，
 *   且必须至少包含一个非空白字符。
 *
 * 两个容易踩的点：
 *
 * 1. **必须按 Unicode 码点计数，不能用 `String.length`。**
 *    `length` 数的是 UTF-16 code unit：非 BMP 字符（例如 emoji 🧭）
 *    在 `length` 里占 2，在「码点」里占 1。用 `length` 会把合法的
 *    80 个 emoji 标题误判成 160 而拒绝。这里统一用「按码点迭代」计数。
 * 2. **不能只依赖 HTML `maxlength`。**
 *    `maxlength` 同样按 UTF-16 计数，会在浏览器输入阶段就砍掉合法 emoji 内容，
 *    而且是「默默截断」而不是给出明确错误。因此长度判断放在这里，
 *    由表单在提交前显式校验并给出可读的错误提示。
 *
 * 校验只用于**判断**，不会把任何 `trim` 结果写回请求：
 * Markdown 缩进、首尾空格与换行都原样提交。
 *
 * 本文件不依赖 React，也不发请求，因此可以用
 * `node --experimental-strip-types` 直接测试。
 */

import type { JournalUpdate } from '../types/journal.ts'

/** 标题允许的最大 Unicode 码点数。 */
export const TITLE_MAX_CODE_POINTS = 80

/** 正文允许的最大 Unicode 码点数。 */
export const CONTENT_MAX_CODE_POINTS = 50_000

/**
 * 空白字符集合：与后端 `backend/app/journal/schemas.py` 的
 * `_WHITESPACE_CODE_POINTS` 一一对应，保证两边对「纯空白正文」判断一致。
 *
 * 至少覆盖普通空格、Tab、换行、全角空格与 NBSP，另含常见的 Unicode 空白。
 */
function buildWhitespaceCodePoints(): Set<number> {
  const codePoints = [
    0x0009, // TAB
    0x000a, // LINE FEED
    0x000b, // LINE TABULATION
    0x000c, // FORM FEED
    0x000d, // CARRIAGE RETURN
    0x0020, // SPACE
    0x00a0, // NO-BREAK SPACE
    0x1680, // OGHAM SPACE MARK
    0x2028, // LINE SEPARATOR
    0x2029, // PARAGRAPH SEPARATOR
    0x202f, // NARROW NO-BREAK SPACE
    0x205f, // MEDIUM MATHEMATICAL SPACE
    0x3000, // IDEOGRAPHIC SPACE（全角空格）
    0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
  ]
  // EN QUAD (U+2000) … HAIR SPACE (U+200A)
  for (let codePoint = 0x2000; codePoint <= 0x200a; codePoint += 1) {
    codePoints.push(codePoint)
  }
  return new Set(codePoints)
}

const WHITESPACE_CODE_POINTS = buildWhitespaceCodePoints()

/**
 * 按 Unicode 码点计数。
 *
 * `Array.from` 会按码点迭代字符串，因此非 BMP 字符只算 1 个；
 * 这正是后端 Python `len(str)` 的计数口径。
 * 不要用 `String.length`：它数的是 UTF-16 code unit，会把 emoji 算成 2。
 */
export function countCodePoints(text: string): number {
  return Array.from(text).length
}

/** 整串是否只由空白字符组成；空字符串也算空白。 */
export function isBlankText(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || !WHITESPACE_CODE_POINTS.has(codePoint)) {
      return false
    }
  }
  return true
}

/** 校验标题；合法返回 `undefined`，否则返回可读的错误说明。 */
export function validateTitle(title: string | null): string | undefined {
  if (title === null) {
    return undefined
  }
  const count = countCodePoints(title)
  if (count > TITLE_MAX_CODE_POINTS) {
    return `最多 ${TITLE_MAX_CODE_POINTS} 个字符（emoji 按 1 个算），当前 ${count} 个。`
  }
  return undefined
}

/** 校验正文；合法返回 `undefined`，否则返回可读的错误说明。 */
export function validateContent(content: string): string | undefined {
  const count = countCodePoints(content)
  if (count > CONTENT_MAX_CODE_POINTS) {
    return `最多 ${CONTENT_MAX_CODE_POINTS} 个字符，当前 ${count} 个。`
  }
  if (isBlankText(content)) {
    return '不能为空，也不能只包含空格、Tab 或换行。'
  }
  return undefined
}

/** 逐字段的错误信息；没有错误的字段不会出现在对象里。 */
export interface ContentValidationErrors {
  title?: string
  content?: string
}

/** 创建请求里参与校验的字段（`journal_date` 由日期输入框保证，不在本文件校验）。 */
export interface CreateValidationInput {
  title: string | null
  content: string
}

/** 校验创建请求的全部待创建字段。 */
export function validateCreateInput(
  input: CreateValidationInput,
): ContentValidationErrors {
  const errors: ContentValidationErrors = {}

  const titleError = validateTitle(input.title)
  if (titleError !== undefined) {
    errors.title = titleError
  }

  const contentError = validateContent(input.content)
  if (contentError !== undefined) {
    errors.content = contentError
  }

  return errors
}

/**
 * 校验一次 PATCH 请求体，**只校验其中实际提交的字段**。
 *
 * 这一点很关键：编辑旧记录时，请求体是「真正改过的字段」的子集
 * （见 `buildJournalUpdate()`）。因此：
 *
 * - 旧正文超长 / 空白但本次没提交正文 → 不校验正文，只改标题或日期照样放行；
 * - 旧标题超长但本次没提交标题 → 同理；
 * - 用户真的把非法值提交进来（例如把正文清空）→ 仍然拒绝。
 */
export function validateUpdateInput(
  update: JournalUpdate,
): ContentValidationErrors {
  const errors: ContentValidationErrors = {}

  if ('title' in update) {
    const titleError = validateTitle(update.title ?? null)
    if (titleError !== undefined) {
      errors.title = titleError
    }
  }

  if ('content' in update) {
    const content = update.content
    const contentError =
      typeof content === 'string' ? validateContent(content) : '必须是字符串。'
    if (contentError !== undefined) {
      errors.content = contentError
    }
  }

  return errors
}

/** 是否存在任一字段错误。 */
export function hasContentValidationErrors(
  errors: ContentValidationErrors,
): boolean {
  return errors.title !== undefined || errors.content !== undefined
}

/** 把逐字段错误拼成一行可读文案，供表单直接展示。 */
export function formatContentValidationErrors(
  errors: ContentValidationErrors,
): string {
  const messages: string[] = []
  if (errors.title !== undefined) {
    messages.push(`标题：${errors.title}`)
  }
  if (errors.content !== undefined) {
    messages.push(`正文：${errors.content}`)
  }
  return messages.join(' ')
}
