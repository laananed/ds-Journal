import {
  TRASH_PURGE_CONFIRM_MESSAGE,
  TRASH_TARGET_GONE_MESSAGE,
  trashActionDoneMessage,
  trashWriteFailureMessage,
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

// ---- Stage 4 / T11：写入失败按 code 分类，不把不可重试的冲突说成「重读再试」。----

function check(condition: boolean, label: string) {
  if (!condition) throw new Error(label)
  passed += 1
}

// 普通版本过期（无 code 的 409）：保持 Stage 3 文案与「重读后再确认」的行为。
const stale = trashWriteFailureMessage('restore', { status: 409 })
equal(stale.message, '这条记录已在别处发生变化，已重新读取，请再确认一次。', 'stale 409 message')
check(stale.reread === true, 'stale 409 should trigger a reread')
check(stale.retriable === true, 'stale 409 is retriable after reread')

// 有 code 的 409 优先级高于 status：不能落到「版本变化」文案上。
const ritual = trashWriteFailureMessage('restore', { status: 409, code: 'ritual_slot_conflict' })
check(ritual.message.includes('restore-replace'), 'ritual conflict must name the pending replace path')
check(ritual.message.includes('没有改动'), 'ritual conflict must state that nothing was written')
check(ritual.reread === false, 'ritual conflict does not need a reread to be understood')
check(ritual.retriable === false, 'ritual conflict must not be advertised as retriable')
check(ritual.message !== stale.message, 'ritual conflict must not reuse the stale-revision wording')

const related = trashWriteFailureMessage('restore', { status: 409, code: 'related_files_changed' })
check(related.retriable === false, 'related_files_changed is blocked, not retriable')
check(related.message.includes('只恢复一部分'), 'related_files_changed must explain the half-write risk')

// 旧格式正文：回收箱不做转换，指引回到编辑页。
const legacy = trashWriteFailureMessage('restore', { status: 409, code: 'legacy_conversion_required' })
check(legacy.retriable === false, 'legacy_conversion_required is not retriable in Trash')
check(legacy.message.includes('转换为富文本'), 'legacy failure must point to the explicit conversion entry')
// 旧文不可恢复是硬约束：文案不得暗示“可以自动转换”。
check(!legacy.message.includes('自动转换'), 'legacy failure must not promise automatic conversion')

// 428 缺版本：明说本次没有写入。
const precondition = trashWriteFailureMessage('purge', { status: 428 })
check(precondition.message.includes('428'), 'missing If-Match must surface the 428 status')
check(precondition.message.includes('没有修改任何记录'), 'missing If-Match must state no write happened')
check(precondition.reread === true, 'missing If-Match should reread before retry')

// 其余失败：沿用后端 detail，没有 detail 时按动作给出兜底，且都可重试。
const boom = trashWriteFailureMessage('purge', { status: 500, message: '数据库暂时不可用' })
equal(boom.message, '数据库暂时不可用', 'server detail is shown verbatim')
check(boom.retriable === true && boom.reread === false, 'plain failure stays a simple retry')
equal(trashWriteFailureMessage('restore', { status: 500 }).message, '恢复失败，请稍后重试', 'restore fallback')
equal(trashWriteFailureMessage('purge', { status: 500 }).message, '永久删除失败，请稍后重试', 'purge fallback')

console.log(`trashFeedback: ${passed} assertions passed`)
