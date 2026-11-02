/**
 * 沉浸式编辑的 React 接入（第二轮 UI）。
 *
 * 判定逻辑全在 `utils/immersiveChrome.ts`（纯函数、可单测）；这里只负责
 * 把 DOM 事件翻译成事件对象，并把 `hidden` 交给页面。
 *
 * 使用者约定：
 * - 页面根节点绑定 `onPointerMove` / `onKeyDown`；
 * - **辅助界面容器**（顶栏、侧栏）绑定 `onFocusIn` / `onFocusOut`，
 *   不要绑在页面根上：编辑器本身也 focusin，那样打字永远不会淡出。
 * - 真实输入后调用 `onType()`。
 */

import { useCallback, useReducer } from 'react'
import {
  INITIAL_IMMERSIVE,
  immersiveReducer,
  isRevealKey,
} from '../utils/immersiveChrome'

export interface ImmersiveChrome {
  /** 辅助界面是否应当淡出。 */
  hidden: boolean
  /** 真实用户输入后调用：淡出辅助界面。 */
  onType: () => void
  /** 指针移动：重新显示。 */
  reveal: () => void
  /** 页面根节点用：无输入按键重新显示。 */
  onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean }) => void
  /** 辅助界面容器用：焦点进入时暂停淡出。 */
  hold: () => void
  /** 辅助界面容器用：焦点离开时恢复。 */
  release: () => void
}

export function useImmersiveChrome(): ImmersiveChrome {
  const [state, dispatch] = useReducer(immersiveReducer, INITIAL_IMMERSIVE)

  const onType = useCallback(() => dispatch({ type: 'type' }), [])
  const reveal = useCallback(() => dispatch({ type: 'reveal' }), [])
  const hold = useCallback(() => dispatch({ type: 'hold' }), [])
  const release = useCallback(() => dispatch({ type: 'release' }), [])
  const onKeyDown = useCallback((event: { key: string; ctrlKey: boolean; metaKey: boolean }) => {
    if (isRevealKey(event)) dispatch({ type: 'reveal' })
  }, [])

  return { hidden: state.hidden, onType, reveal, onKeyDown, hold, release }
}
