import {
  TRASH_PURGE_CONFIRM_MESSAGE,
  TRASH_TARGET_GONE_MESSAGE,
  trashActionDoneMessage,
} from './trashFeedback.ts'

let passed = 0
function equal(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  passed += 1
}

// 恢复成功：说明保留 Folder 关系与去向，不提“刷新”字样（刷新反馈由列表区负责）。
equal(
  trashActionDoneMessage('restore', '2026-10-08 (2)'),
  '已恢复「2026-10-08 (2)」，原 Folder 关系已保留，可到 Journal / Insight 查看。',
  'restore done message',
)
// 永久删除成功：明确“永久”语义。
equal(trashActionDoneMessage('purge', '旧笔记'), '已永久删除「旧笔记」。', 'purge done message')
// 标题只做插值，不做裁剪：详情标题来自服务端 display_title。
equal(
  trashActionDoneMessage('restore', '  含空格标题  '),
  '已恢复「  含空格标题  」，原 Folder 关系已保留，可到 Journal / Insight 查看。',
  'title passed through verbatim',
)

// 404：不声称本次动作成功。
if (TRASH_TARGET_GONE_MESSAGE.includes('已恢复') || TRASH_TARGET_GONE_MESSAGE.includes('已永久删除')) {
  throw new Error('target-gone message must not claim the action succeeded')
}
if (!TRASH_TARGET_GONE_MESSAGE.includes('恢复或永久删除')) {
  throw new Error('target-gone message should mention both possible causes')
}
passed += 1

// 确认文案必须包含“无法恢复”；取消零请求由 UI 保证，这里锁定文案本身。
if (!TRASH_PURGE_CONFIRM_MESSAGE.includes('无法恢复')) {
  throw new Error('purge confirm message must state irreversibility')
}
passed += 1

console.log(`trashFeedback: ${passed} assertions passed`)
