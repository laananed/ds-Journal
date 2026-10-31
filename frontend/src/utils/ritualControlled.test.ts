/**
 * Set Checklist → 目标候选筛选（API §4、产品 §7）。
 *
 * 与服务端 `convert_ritual_task_item` 同一口径：只把「顶层 taskList 中、单段纯文字
 * （可含 hardBreak）、无 Mark、非空白、≤2000 码点」的条目列为候选。格式、评论、
 * 嵌套结构一律不列出——`goalItem` 只有 text/checked，装不下它们，列出来只会让
 * 用户在点击后收到 422。
 */
import { checklistCandidates, goalConversionReady, nextAutomaticGoal } from './ritualControlled.ts'

let checks = 0
function equal(actual: unknown, expected: unknown, message: string): void {
  checks += 1
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`)
  }
}

const text = (value: string, marks?: unknown[]) =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks }
const item = (id: string, children: unknown[], checked = false) => ({
  type: 'taskItem', attrs: { id, checked }, content: [{ type: 'paragraph', content: children }],
})
const list = (items: unknown[]) => ({ type: 'taskList', content: items })

const doc = { type: 'doc', content: [list([
  item('one', [text('可转换')]),
  item('two', [text('带格式', [{ type: 'bold' }])]),
  item('three', [text('带评论', [{ type: 'mindComment', attrs: { comment_ids: ['c1'] } }])]),
  item('four', [text('第一行'), { type: 'hardBreak' }, text('第二行')]),
  item('five', [text('   ')]),
])] }
equal(nextAutomaticGoal(doc, 'set', true, new Set()), 'one', '已保存的 Set 清单自动选择第一个安全条目')
equal(nextAutomaticGoal(doc, 'end', true, new Set()), null, 'End 的清单不自动成为目标')
equal(nextAutomaticGoal(doc, 'set', false, new Set()), null, '未保存或冲突时不发自动请求')
equal(nextAutomaticGoal(doc, 'set', true, new Set(['one'])), 'four', '尝试过的条目不自动重复')
equal(checklistCandidates(doc), [
  { id: 'one', text: '可转换' },
  { id: 'four', text: '第一行\n第二行' },
], '只列出可安全转换的纯文字条目')

/* 嵌套：条目内多段、条目内再嵌清单、清单嵌在列表里 —— 都不是顶层候选 */
equal(checklistCandidates({ type: 'doc', content: [list([
  { type: 'taskItem', attrs: { id: 'a', checked: false }, content: [
    { type: 'paragraph', content: [text('两段')] },
    { type: 'paragraph', content: [text('第二段')] },
  ] },
  { type: 'taskItem', attrs: { id: 'b', checked: true }, content: [
    { type: 'paragraph', content: [text('带子清单')] },
    list([item('nested', [text('嵌套')])]),
  ] },
])] }), [], '多段或嵌套条目不得列为候选')
equal(checklistCandidates({ type: 'doc', content: [
  { type: 'bulletList', content: [{ type: 'listItem', content: [list([item('deep', [text('深层')])])] }] },
] }), [], '非顶层 taskList 不参与转换')

/* 结构缺失与长度上限 */
equal(checklistCandidates({ type: 'doc', content: [list([
  { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [text('无 ID')] }] },
  item('ok', [text('正常')]),
])] }), [{ id: 'ok', text: '正常' }], '缺少稳定 ID 的条目不能转换')
equal(checklistCandidates({ type: 'doc', content: [list([
  item('long', [text('字'.repeat(2001))]),
  item('limit', [text('字'.repeat(2000))]),
])] }).map((entry) => entry.id), ['limit'], '超过 2000 码点的条目被排除')
equal(checklistCandidates({ type: 'doc', content: [list([
  item('emoji', [text('😀'.repeat(2000))]),
])] }).length, 1, '长度按 Unicode 码点而不是 UTF-16 单元计算')

/* 非文档输入与空文档 */
for (const value of [null, undefined, {}, { type: 'doc' }, { type: 'doc', content: [] }, 'x', 3]) {
  equal(checklistCandidates(value), [], '非文档或空文档没有候选')
}

/* 自动转目标前置闸门：组合中的预编辑内容绝不能被固化成目标（S04 输入法修复） */
const gate = {
  disabled: false, busy: false, status: 'saved', inFlight: false, imeComposing: false, dirty: false,
}
equal(goalConversionReady(gate), true, '空闲且已保存时允许自动转目标')
equal(goalConversionReady({ ...gate, imeComposing: true }), false, '输入法组合中不得自动转目标')
equal(goalConversionReady({ ...gate, dirty: true }), false, '有未提交改动时不转目标')
equal(goalConversionReady({ ...gate, inFlight: true }), false, '保存在途时不转目标')
equal(goalConversionReady({ ...gate, status: 'saving' }), false, '保存中状态不转目标')
equal(goalConversionReady({ ...gate, disabled: true }), false, '页面级写锁时不转目标')
equal(goalConversionReady({ ...gate, busy: true }), false, '页面显式动作进行时不转目标')

console.log(`ritualControlled: ${checks} 项检查通过`)
