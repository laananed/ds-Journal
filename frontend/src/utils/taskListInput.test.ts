/**
 * 清单标记判定（第二轮 UI 修复的可测部分）。
 *
 * 只测纯函数：真正的输入规则在 `editor/schema.ts`，靠浏览器验证（见
 * `s04-ui-round2/checklist-report.json`）。这里保证「什么形状允许转」这条
 * 边界不会因为后续改动悄悄放宽。
 */
import {
  TASK_MARKER_PATTERN,
  canConvertTaskMarker,
  taskMarkerChecked,
} from './taskListInput.ts'

let checks = 0
function equal(actual: unknown, expected: unknown, message: string): void {
  checks += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
  }
}

const marker = (text: string) => {
  const match = TASK_MARKER_PATTERN.exec(text)
  if (match === null) throw new Error(`应当匹配：${JSON.stringify(text)}`)
  return taskMarkerChecked(match)
}

/* ------------------------------------------------------------ 勾选判定 */
equal(marker('[ ] '), false, '空方框表示未完成')
equal(marker('[x] '), true, '小写 x 表示完成')
equal(marker('[X] '), true, '大写 X 表示完成')
equal(marker('[] '), false, '没有空格视为未完成')
equal(marker('  [ ] '), false, '行首空白不影响匹配')
equal(TASK_MARKER_PATTERN.test('[] '), true, '`[] ` 与内置规则同形')
equal(TASK_MARKER_PATTERN.test('[ ]'), false, '缺少结尾空格不匹配（避免打断正常方括号文字）')
equal(TASK_MARKER_PATTERN.test('见 [ ] '), false, '不在行首不匹配')
equal(TASK_MARKER_PATTERN.test('[y] '), false, '非 x 的字符不匹配')

/* ---------------------------------------------------------- 结构白名单 */
equal(canConvertTaskMarker(['paragraph', 'doc']), true, '顶层段落可以转')
equal(
  canConvertTaskMarker(['paragraph', 'blockquote', 'doc']),
  true,
  '引用块里的段落可以转',
)
equal(
  canConvertTaskMarker(['paragraph', 'listItem', 'bulletList', 'doc']),
  true,
  '无序列表项可以转（这就是「- [ ] 」的实际路径）',
)
equal(
  canConvertTaskMarker(['paragraph', 'listItem', 'orderedList', 'doc']),
  true,
  '有序列表项可以转（「1. [ ] 」）',
)
equal(
  canConvertTaskMarker(['paragraph', 'taskItem', 'taskList', 'doc']),
  true,
  '已经是清单项：只改勾选',
)

equal(canConvertTaskMarker([]), false, '空路径不转')
equal(canConvertTaskMarker(['doc']), false, '路径必须以段落开头')
equal(
  canConvertTaskMarker(['paragraph', 'listItem', 'bulletList', 'listItem', 'bulletList', 'doc']),
  false,
  '嵌套列表不转：拆列表会改变父节点形状',
)
equal(
  canConvertTaskMarker(['paragraph', 'tableCell', 'tableRow', 'table', 'doc']),
  false,
  '表格单元格不转',
)
equal(
  canConvertTaskMarker(['paragraph', 'aiSummary', 'doc']),
  false,
  '受保护容器不转，保留原文',
)
equal(
  canConvertTaskMarker(['paragraph', 'listItem', 'taskList', 'doc']),
  false,
  'listItem 直接挂 taskList 不是合法形状，不转',
)
equal(
  canConvertTaskMarker(['heading', 'doc']),
  false,
  '标题不是段落，不转',
)

console.log(`taskListInput: ${checks} 项通过`)
