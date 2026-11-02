/**
 * 清单标记（`- [ ] ` / `[x] `）的纯判定（第二轮 UI 修复）。
 *
 * 背景：Tiptap 自带的 `TaskItem` 输入规则只在**段落顶层**能成功 wrap。
 * 用户输入 `- ` 时 `BulletList` 的规则先把这一行变成列表项；此后 `[ ] `
 * 位于 `bulletList > listItem > paragraph` 里，`findWrapping` 拿不到合法
 * 包裹（listItem 的第一个子节点必须是段落），规则静默失败，结果就是
 * 「普通圆点 + 字面 `[ ] `」。
 *
 * 修复不再依赖 `findWrapping`：删掉标记后直接构造 `taskList > taskItem`
 * 替换这一行（见 `editor/schema.ts` 的 `TaskMarkerInput`）。这里集中放两件
 * 可测的事：
 *
 * 1. `taskMarkerChecked`：`[ ]` 与 `[x]` 的勾选判定；
 * 2. `canConvertTaskMarker`：结构性前置条件——只有「顶层段落 / 顶层列表项 /
 *    引用块里的段落 / 清单项本身」才动手；嵌套列表等复杂结构返回 false，
 *    由调用方原样保留用户输入的 `[ ]` 文字（宁可不转，也不猜着转）。
 */

/** 与内置 `TaskItem` 规则同形：光标前是行首的 `[ ]` / `[x]` / `[]` 加一个空格。 */
export const TASK_MARKER_PATTERN = /^\s*\[([ xX]?)\]\s$/

/** 普通列表的父节点（`listItem` 的外层）。 */
const LIST_PARENTS = new Set(['bulletList', 'orderedList'])

/** 标记是否表示「已完成」：`[x]` / `[X]`。 */
export function taskMarkerChecked(match: RegExpMatchArray | readonly string[]): boolean {
  const raw = match[1] ?? ''
  return raw.trim().toLowerCase() === 'x'
}

/**
 * 结构性前置判定。
 *
 * `path`：从当前文本块开始、逐层向上到 `doc` 的节点类型名。
 * 允许的形状只有四种（`L` 是 `bulletList` 或 `orderedList`）：
 *
 * - `paragraph > doc`：顶层段落，直接包成清单；
 * - `paragraph > blockquote > doc`：引用里的段落，挂在引用内部；
 * - `paragraph > listItem > L > doc`：顶层列表项，拆成清单项；
 * - `paragraph > taskItem > taskList > doc`：已经是清单项，只改勾选。
 *
 * 其余（嵌套列表、表格单元格、任何自定义容器）一律 false：那些位置
 * 的转换会改变父节点形状或作者归属，保留原文比猜一个结果安全。
 */
export function canConvertTaskMarker(path: readonly string[]): boolean {
  if (path.length < 2) return false
  if (path[0] !== 'paragraph') return false
  if (path[path.length - 1] !== 'doc') return false
  const between = path.slice(1, -1)
  if (between.length === 0) return true
  if (between.length === 1) return between[0] === 'blockquote'
  if (between.length === 2) {
    const [item, parent] = between
    if (item === 'taskItem' && parent === 'taskList') return true
    if (item === 'listItem' && LIST_PARENTS.has(parent as string)) return true
  }
  return false
}
