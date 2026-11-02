/**
 * 沉浸式编辑：辅助界面的显隐状态（第二轮 UI）。
 *
 * 只做一件事——决定「顶部栏 / 侧栏 / 工具栏」此刻是否淡出。规则刻意保持
 * 极少，因为这里最容易把可发现性弄坏：
 *
 * 1. **只有真实用户输入才淡出**。程序化替换（加载详情、AI 应用、恢复草稿）
 *    不经过 `type`，所以不会让界面莫名消失。
 * 2. **指针移动、Tab/Escape 等无输入按键会重新显示**——键盘用户不必先动鼠标。
 * 3. **焦点停在辅助界面里时不淡出**（`hold`）：否则用户 Tab 到一半，按钮就
 *    在眼前消失。
 * 4. 重要信息（保存失败、冲突、本地草稿不可用）不归这里管：它们在页面里
 *    单独渲染，永远不进入淡出层。
 *
 * 状态用不可变对象返回：重复的 `reveal`（鼠标每移动一像素都会来一次）
 * 返回同一个引用，React 因此不会重渲染。
 */

export interface ImmersiveState {
  /** 辅助界面是否淡出。 */
  hidden: boolean
  /** 焦点停在辅助界面里的层数；>0 时不淡出。 */
  holds: number
}

export type ImmersiveEvent =
  /** 真实用户输入（打字、粘贴、勾选清单等会改变正文的操作）。 */
  | { type: 'type' }
  /** 指针移动或无输入按键（Tab / Escape / 快捷键）。 */
  | { type: 'reveal' }
  /** 焦点进入辅助界面。 */
  | { type: 'hold' }
  /** 焦点离开辅助界面。 */
  | { type: 'release' }

export const INITIAL_IMMERSIVE: ImmersiveState = { hidden: false, holds: 0 }

export function immersiveReducer(state: ImmersiveState, event: ImmersiveEvent): ImmersiveState {
  switch (event.type) {
    case 'type':
      if (state.holds > 0) return state
      return state.hidden ? state : { ...state, hidden: true }
    case 'reveal':
      return state.hidden ? { ...state, hidden: false } : state
    case 'hold':
      return state.hidden || state.holds > 0 ? { ...state, hidden: false, holds: state.holds + 1 } : { ...state, holds: 1 }
    case 'release':
      return state.holds === 0 ? state : { ...state, holds: state.holds - 1 }
    default:
      return state
  }
}

/**
 * 只有「不是打字」的按键才重新显示辅助界面。
 *
 * 回车、空格、字母、退格都会产生输入，淡出保持；方向键 / Home / End / Tab /
 * Escape / 快捷键是纯导航，淡出必须让路——否则键盘用户看不到任何按钮也找不到
 * 返回入口。
 */
const REVEAL_KEYS = new Set([
  'Tab', 'Escape', 'F6',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

export function isRevealKey(event: { key: string; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  if (REVEAL_KEYS.has(event.key)) return true
  if (event.ctrlKey === true || event.metaKey === true) return true
  return false
}
