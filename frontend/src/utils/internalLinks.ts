/**
 * 内部链接 `[[显示标题]]` 的纯文本识别（Stage 4 / S04-T11，修复 D2）。
 *
 * Stage 4 起正文权威是 schema 1 JSON，`RichTextEditor` 里没有 Markdown 语法节点，
 * 因此「哪一段文字是内部链接」需要一层与渲染无关的纯逻辑：
 *
 * 1. 规则与 `utils/markdownReading.ts` 的 wiki-link 解析保持一致（同一份产品语义）：
 *    括号内允许空格与 `&`、`+`、`#`；`[[]]`、`[[[嵌套]]]`、未闭合的 `[[` 都不算；
 * 2. **只认普通文本**：代码区域（代码块、行内代码）由调用方按自己的结构判定后
 *    跳过，本模块不做 HTML / Markdown 上下文猜测；
 * 3. 不 trim、不改写标题：显示标题按原文逐字送去精确匹配（与 legacy 路径一致），
 *    找不到候选由候选面板说明，不自动新建、不改写正文。
 *
 * 本文件不依赖 React 与编辑器，可用 `node --experimental-strip-types` 直接测试。
 */

export interface InternalLinkToken {
  /** 括号内的显示标题（原文，不 trim）。 */
  title: string
  /** 完整原文，含两层方括号。 */
  raw: string
  /** 在所在文本段内的起始下标（含）。 */
  start: number
  /** 在所在文本段内的结束下标（不含）。 */
  end: number
}

/**
 * 与 `markdownReading` 的 wiki-link 规则相同的边界：
 * 前后不能再接方括号，避免把 `[[[嵌套]]]` 识别成链接；括号内不跨行、不允许 `[`。
 */
const TOKEN_PATTERN = /(?<!\[)\[\[([^\]\r\n[]+)\]\](?!\])/g

/** 扫描一段普通文本里的全部内部链接（按出现顺序）。 */
export function internalLinkTokens(text: string): InternalLinkToken[] {
  if (!text.includes('[[')) return []
  const tokens: InternalLinkToken[] = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index ?? 0
    const raw = match[0]
    tokens.push({ title: match[1], raw, start, end: start + raw.length })
  }
  return tokens
}

/**
 * 命中某个文本偏移的内部链接。
 *
 * `offset` 用半开区间判定，但允许等于 `end`：用户点在收尾的 `]]` 之后
 * 一格仍然算点了这条链接（阅读态里最后一个字的右侧没有更精确的落点）。
 */
export function findInternalLinkAt(text: string, offset: number): InternalLinkToken | null {
  if (!Number.isFinite(offset) || offset < 0) return null
  for (const token of internalLinkTokens(text)) {
    if (offset >= token.start && offset <= token.end) return token
  }
  return null
}
