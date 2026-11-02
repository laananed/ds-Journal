/**
 * 沉浸式显隐状态机（第二轮 UI）。
 *
 * 这几条断言对应产品要求：输入时淡出、指针移动/无输入按键恢复、焦点停在
 * 辅助界面里时不淡出。它们都不依赖 DOM，改状态机就该先改这里。
 */
import {
  INITIAL_IMMERSIVE,
  immersiveReducer,
  isRevealKey,
  type ImmersiveEvent,
} from './immersiveChrome.ts'

let checks = 0
function equal(actual: unknown, expected: unknown, message: string): void {
  checks += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
  }
}

const run = (events: ImmersiveEvent[]) => events.reduce(immersiveReducer, INITIAL_IMMERSIVE)

/* ---------------------------------------------------------- 基本流转 */
equal(run([]), { hidden: false, holds: 0 }, '初始状态是显示')
equal(run([{ type: 'type' }]).hidden, true, '输入后淡出')
equal(run([{ type: 'type' }, { type: 'reveal' }]).hidden, false, '指针移动后恢复')
equal(
  run([{ type: 'type' }, { type: 'reveal' }, { type: 'type' }]).hidden,
  true,
  '恢复后再输入仍然淡出',
)

/* -------------------------------------------------- 引用稳定（不重渲染） */
const hidden = immersiveReducer(INITIAL_IMMERSIVE, { type: 'type' })
equal(immersiveReducer(hidden, { type: 'type' }) === hidden, true, '已淡出时重复输入返回同一对象')
const shown = INITIAL_IMMERSIVE
equal(immersiveReducer(shown, { type: 'reveal' }) === shown, true, '已显示时重复恢复返回同一对象')
equal(immersiveReducer(shown, { type: 'release' }) === shown, true, '没有持有时 release 是空操作')

/* ------------------------------------------------------------ 焦点持有 */
const holding = run([{ type: 'type' }, { type: 'hold' }])
equal(holding, { hidden: false, holds: 1 }, '焦点进入辅助界面立即恢复并记一次持有')
equal(immersiveReducer(holding, { type: 'type' }), holding, '持有期间打字不淡出')
equal(
  run([{ type: 'hold' }, { type: 'hold' }]).holds,
  2,
  '嵌套持有按层计数',
)
equal(
  run([{ type: 'hold' }, { type: 'hold' }, { type: 'release' }]).holds,
  1,
  '释放一层后仍持有',
)
equal(
  run([{ type: 'hold' }, { type: 'release' }]).hidden,
  false,
  '释放后保持显示（由下一次输入决定是否淡出）',
)

/* ---------------------------------------------------------- 恢复按键集 */
const key = (value: string, extra: { ctrlKey?: boolean; metaKey?: boolean } = {}) =>
  isRevealKey({ key: value, ...extra })

for (const value of ['Tab', 'Escape', 'F6', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
  equal(key(value), true, `${value} 是无输入按键，应当恢复辅助界面`)
}
for (const value of ['a', 'Enter', ' ', 'Backspace', '中']) {
  equal(key(value), false, `${value} 会产生输入，不应当恢复`)
}
equal(key('s', { ctrlKey: true }), true, 'Ctrl 组合键恢复（保存快捷键要看得见按钮）')
equal(key('s', { metaKey: true }), true, 'Meta 组合键恢复')

console.log(`immersiveChrome: ${checks} 项通过`)
