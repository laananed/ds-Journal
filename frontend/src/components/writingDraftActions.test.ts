/**
 * 草稿丢弃入口纯逻辑测试（Stage 4 / T02 缺陷修复：双丢弃入口）。
 *
 *   node --experimental-strip-types src/components/writingDraftActions.test.ts
 *
 * 不引入测试框架、不渲染组件、不连网络/数据库：验证的是
 * 「恢复计划 → 动作列表」这一纯函数，它决定了面板为每个候选渲染哪些按钮。
 *
 * 缺陷背景：动作列表曾包含 `'discard'`，循环渲染出第二个**免确认**的
 * 丢弃按钮，与带二次确认的独立「丢弃」按钮并存，可能误删本地草稿。
 *
 * 覆盖三种恢复计划的丢弃约束与全部计划的动作回归：
 * 1. 核心不变量：任何计划（含尚未探测）下动作列表都不得包含 `'discard'`——
 *    丢弃只有面板里唯一的「丢弃」按钮入口，且必须先经二次确认；
 * 2. 回归：恢复 / 对照 / 重放 / 另存 / 稍后各计划的动作与顺序保持不变，
 *    不顺带改变恢复、重放、另存或冲突处理语义。
 */

import { actionsFor } from './writingDraftActions.ts'
import type { CandidatePlan } from '../utils/writingSession.ts'

let passed = 0

function check(ok: boolean, label: string): void {
  if (!ok) throw new Error(`失败：${label}`)
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`失败：${label}，期望 ${e}，实际 ${a}`)
  passed += 1
}

/** 全部恢复计划，含「尚未探测」（plan = null）。 */
const plans: Array<{ label: string; plan: CandidatePlan | null }> = [
  { label: '尚未探测（plan=null）', plan: null },
  { label: 'editable：已有本地草稿、与服务器同版本', plan: { kind: 'editable' } },
  { label: 'fresh：从未发出创建请求', plan: { kind: 'fresh' } },
  { label: 'conflict：与服务器版本冲突', plan: { kind: 'conflict', localRevision: 1, serverRevision: 2 } },
  { label: 'server_missing：服务器文件已删除', plan: { kind: 'server_missing' } },
  { label: 'server_unreadable：服务器暂时读不到', plan: { kind: 'server_unreadable', message: '网络错误' } },
  { label: 'replay_pending：创建请求待重放', plan: { kind: 'replay_pending' } },
]

function testNoDirectDiscard(): void {
  for (const { label, plan } of plans) {
    const actions = actionsFor(plan)
    check(!actions.includes('discard'), `${label}：动作列表不得包含免确认的 discard 入口`)
  }
}

function testPlanActionsRegression(): void {
  expectEqual(actionsFor(null), ['restore', 'later'],
    '尚未探测：只提供恢复与稍后（先恢复以触发服务器探测）')
  expectEqual(actionsFor({ kind: 'editable' }), ['restore', 'later'],
    '已有本地草稿、同版本：恢复 + 稍后')
  expectEqual(actionsFor({ kind: 'fresh' }), ['restore', 'later'],
    '从未发出创建：恢复 + 稍后')
  expectEqual(actionsFor({ kind: 'conflict', localRevision: 1, serverRevision: 2 }), ['compare', 'later'],
    '冲突计划：对照服务器版本 + 稍后（不自动取舍）')
  expectEqual(actionsFor({ kind: 'server_missing' }), ['saveAsNew', 'later'],
    '服务器文件已删除：另存为新草稿 + 稍后（不自动新建）')
  expectEqual(actionsFor({ kind: 'server_unreadable', message: '网络错误' }), ['restore', 'later'],
    '服务器读不到：恢复 + 稍后')
  expectEqual(actionsFor({ kind: 'replay_pending' }), ['replayOriginal', 'saveAsNew', 'later'],
    '待重放：恢复原请求在最前、另存为新草稿其后、稍后收尾')
}

testNoDirectDiscard()
testPlanActionsRegression()

console.log(`writingDraftActions: ${passed} 项通过`)
