/**
 * 本地草稿面板的动作计划（Stage 4 / T02 缺陷修复：双丢弃入口）。
 *
 * 从 `WritingDraftRecovery.tsx` 抽出的纯逻辑：给定恢复计划，
 * 返回该候选在动作列表里可用的动作。抽出来的目的是让这份
 * 「哪些入口存在」的决定可以被无框架 Node 测试直接验证，
 * 组件文件只保留渲染。
 *
 * **单一丢弃入口不变量**：丢弃本地草稿是破坏性动作，唯一入口是
 * 面板里独立的「丢弃」按钮——它先进入二次确认（确认 / 取消），
 * 用户明确确认后才执行删除；取消或关闭不删除、不写服务器。
 * 因此 `actionsFor` 的返回值**绝不允许包含 `'discard'`**：
 * 动作列表会被循环直接渲染成免确认按钮，历史上正是它和
 * 确认入口并存，形成了「双丢弃入口」缺陷。
 */

import type { CandidatePlan } from '../utils/writingSession'

/** 用户可以对一份本地草稿做的动作。 */
export type DraftAction =
  /** 继续这份草稿（未落库或同版本可编辑）。 */
  | 'restore'
  /** 版本不同：打开左右对照。 */
  | 'compare'
  /**
   * 创建结果未确认：用**原创建键 + 原首次 payload** 重放取回那次提交。
   * 与「另存为新草稿」是两件事：这条不会新建第二条记录。
   */
  | 'replayOriginal'
  /**
   * 服务器上已不存在 / 创建未确认：以**新的创建键**另存为一份独立新记录。
   * 这不是对原创建请求的恢复或重放——原内容会变成一篇新的服务器文件。
   */
  | 'saveAsNew'
  /** 稍后处理：关闭面板，记录继续保留。 */
  | 'later'
  /** 明确丢弃：删除本机记录（仅由面板的「丢弃」按钮经二次确认触发）。 */
  | 'discard'

/**
 * 计划决定动作列表；没有计划的候选先「恢复」以触发探测。
 *
 * 丢弃不在列表里：它由独立按钮统一提供并强制二次确认，
 * 对所有计划一视同仁，避免同一候选出现两个含义不同的「丢弃」。
 */
export function actionsFor(plan: CandidatePlan | null): DraftAction[] {
  if (plan === null) return ['restore', 'later']
  switch (plan.kind) {
    case 'editable':
    case 'fresh':
      return ['restore', 'later']
    case 'conflict':
      return ['compare', 'later']
    case 'server_missing':
      return ['saveAsNew', 'later']
    case 'replay_pending':
      // 「恢复原请求」必须在最前：它才是找回原来那次提交；
      // 「另存为新草稿」会在服务器上多出一篇独立记录。
      return ['replayOriginal', 'saveAsNew', 'later']
    case 'server_unreadable':
      return ['restore', 'later']
    default:
      return ['later']
  }
}

export const ACTION_LABELS: Record<DraftAction, string> = {
  restore: '恢复',
  compare: '对照服务器版本',
  replayOriginal: '恢复原请求',
  saveAsNew: '另存为新草稿',
  later: '稍后',
  discard: '丢弃',
}
