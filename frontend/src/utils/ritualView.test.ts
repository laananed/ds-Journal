/**
 * `utils/ritualView.ts` 的纯逻辑测试（S04-T10 自测，可离线运行）：
 *
 *   node --experimental-strip-types src/utils/ritualView.test.ts
 *
 * 覆盖：上海 04:00 换日与捕获日期、模板 0/4/5 问、问题快照插入、
 * 可复制块与复制/替换载荷、目标与回顾视图、关联不可用判定。
 * 断言失败即抛错并以非 0 退出。
 */

import {
  TEMPLATE_CAPACITY,
  addTemplateQuestion,
  applyBusinessDay,
  buildCopyPayload,
  buildRestorePayload,
  canAddGoalToEnd,
  captureDraft,
  copyCandidates,
  deletedRitualsOf,
  displayTitle,
  goalsOf,
  hasSavableBody,
  insertPositions,
  insertQuestion,
  isRitualDraftSavable,
  previewText,
  questionTextError,
  relatedRevisionsFor,
  removeTemplateQuestion,
  reviewCanWriteBack,
  reviewsOf,
  ritualDraftOf,
  ritualRecordMatches,
  shanghaiBusinessDate,
  templatesEqual,
  updateTemplateQuestion,
  userText,
  visibleQuestions,
} from './ritualView.ts'
import type { ContentDocument } from '../types/document.ts'
import type { Journal } from '../types/journal.ts'
import type { BusinessDay, RitualQuestion } from '../types/ritual.ts'

let checks = 0
function check(condition: boolean, message: string): void {
  checks += 1
  if (!condition) throw new Error(message)
}
function equal<T>(actual: T, expected: T, message: string): void {
  checks += 1
  if (actual !== expected) throw new Error(`${message}：期望 ${String(expected)}，实际 ${String(actual)}`)
}

/* ------------------------------------------------ 1. 上海 04:00 换日 */

equal(shanghaiBusinessDate('2026-10-30T03:59:59+08:00'), '2026-10-29', '03:59:59 属于前一个业务日')
equal(shanghaiBusinessDate('2026-10-30T04:00:00+08:00'), '2026-10-30', '04:00 属于新业务日')
equal(shanghaiBusinessDate('2026-10-30T23:59:59+08:00'), '2026-10-30', '同日深夜仍是同一业务日')
equal(shanghaiBusinessDate('2026-03-01T03:59:59+08:00'), '2026-02-28', '跨月边界不跳月')
equal(shanghaiBusinessDate('2027-01-01T03:30:00+08:00'), '2026-12-31', '跨年边界不跳年')
equal(shanghaiBusinessDate('2028-02-29T04:00:00+08:00'), '2028-02-29', '闰日 04:00 归当天')
equal(shanghaiBusinessDate(new Date('2026-10-29T20:00:00Z')), '2026-10-30', 'UTC 20:00 = 上海次日 04:00')
check((() => { try { shanghaiBusinessDate('not-a-time'); return false } catch { return true } })(), '非法时刻应抛错')

const day: BusinessDay = {
  timezone: 'Asia/Shanghai', day_start_hour: 4,
  server_time: '2026-10-30T23:50:00+08:00', business_date: '2026-10-30',
}
const captured = captureDraft(day)
equal(captured.journalDate, '2026-10-30', '捕获日期取服务端 business_date')
equal(captured.draftStartedAt, day.server_time, '捕获时刻取服务端时钟')

// 跨过 04:00 后服务端报出新的一天：已捕获的草稿不能换日。
const nextDay: BusinessDay = {
  timezone: 'Asia/Shanghai', day_start_hour: 4,
  server_time: '2026-10-31T04:10:00+08:00', business_date: '2026-10-31',
}
equal(applyBusinessDay(captured, nextDay).journalDate, '2026-10-30', '跨日后仍用原捕获日期')
equal(applyBusinessDay(captured, nextDay).draftStartedAt, day.server_time, '跨日后不重写捕获时刻')
equal(applyBusinessDay(null, nextDay).journalDate, '2026-10-31', '首次打开才新建捕获')

equal(displayTitle('set', '2026-10-30', null), '开始今天 2026-10-30', '空标题显示开始今天')
equal(displayTitle('end', '2026-10-30', '  '), '结束今天 2026-10-30', '空白标题同类兜底')
equal(displayTitle('set', '2026-10-30', '今天'), '今天', '有标题时用标题')

/* --------------------------------------------------- 2. 模板 0/4/5 问 */

equal(questionTextError('  '), '问题不能为空。', '空白问题被拒绝')
equal(questionTextError('a'.repeat(500)), null, '500 码点合法')
equal(questionTextError('a'.repeat(501)), '问题最多 500 个字。', '501 码点被拒绝')
equal(questionTextError('😀'.repeat(500)), null, '码点而非 UTF-16 长度')

const empty: RitualQuestion[] = []
equal(visibleQuestions(empty).questions.length, 0, '0 问可见')
equal(visibleQuestions(empty).overflow, 0, '0 问无溢出')

const one = addTemplateQuestion(empty, '今天最重要的一件事？', 'q1')
check(one.ok, '0 问时可以添加')
if (one.ok) {
  equal(one.questions.length, 1, '添加后 1 问')
  equal(one.questions[0].text, '今天最重要的一件事？', '文本被 trim 保存')
  check(!addTemplateQuestion(one.questions, '重复', 'q1').ok, '同一 ID 不能重复添加')
  const trimmed = addTemplateQuestion(one.questions, '  第二问  ', 'q2')
  check(trimmed.ok && trimmed.questions[1].text === '第二问', '添加时去掉首尾空白')
}

const four: RitualQuestion[] = ['q1', 'q2', 'q3', 'q4'].map((id) => ({ id, text: `问题 ${id}` }))
equal(visibleQuestions(four).questions.length, TEMPLATE_CAPACITY, '4 问全部可见')
const five = [...four, { id: 'q5', text: '问题 q5' }]
equal(visibleQuestions(five).questions.length, 4, '超出 4 问只显示 4 个')
equal(visibleQuestions(five).overflow, 1, '超出的问数如实上报')

const atCapacity = addTemplateQuestion(four, '第五问', 'q5')
check(!atCapacity.ok, '4 问后不能再添加')
if (!atCapacity.ok) equal(atCapacity.message, '当前模板最多 4 个问题。', '容量提示明确')

const renamed = updateTemplateQuestion(four, 1, '改过的第二问')
check(renamed.ok && renamed.questions[1].text === '改过的第二问', '可以改问题文字')
check(renamed.ok && four[1].text === '问题 q2', '修改不就地改动入参')
check(!updateTemplateQuestion(four, 9, 'x').ok, '越界索引被拒绝')
check(!updateTemplateQuestion(four, 0, '   ').ok, '改成空白被拒绝')

const removed = removeTemplateQuestion(four, 0)
equal(removed.length, 3, '删除后剩 3 问')
equal(removed[0].id, 'q2', '删除按位置生效')

check(templatesEqual(four, [...four]), '相同模板相等')
check(!templatesEqual(four, [four[1], four[0], four[2], four[3]]), '顺序不同不算相等')
check(!templatesEqual(four, four.slice(0, 3)), '数量不同不算相等')

/* ------------------------------------------------- 3. 问题插入（快照） */

const body: ContentDocument = {
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: '今天想完成的事' }] }],
}
const before = JSON.stringify(body)
let sequence = 0
const inserted = insertQuestion(body, { id: 'tpl-1', text: '  今天最重要的事？ ' }, () => `id-${++sequence}`)
check(inserted.ok, '插入应当成功')
if (inserted.ok) {
  const doc = inserted.value.document
  equal(doc.content.length, 3, '原文保留 + 问题 + 答案段落')
  const question = doc.content[1]
  check(question.type === 'ritualQuestion', '插入的是问题节点')
  if (question.type === 'ritualQuestion') {
    equal(question.attrs.id, 'id-1', '问题节点有新的文档 ID')
    equal(question.attrs.template_question_id, 'tpl-1', '模板 ID 只作来源记录')
    equal(question.attrs.question_snapshot, '今天最重要的事？', '保存当时文字快照')
  }
  const answer = doc.content[2]
  check(answer.type === 'paragraph' && answer.attrs?.id === 'id-2', '答案位置是新的空段落')
  equal(inserted.value.questionId, 'id-1', '返回问题 ID')
  equal(inserted.value.answerId, 'id-2', '返回答案 ID')
}
equal(JSON.stringify(body), before, '插入不修改传入文档')
check(!insertQuestion(body, { id: 'tpl-2', text: '   ' }).ok, '空白问题不能插入')
check(!insertQuestion(null, { id: 'tpl-3', text: '问题' }).ok, '正文未加载时不能插入')

/* --------------------------------------------------- 4. 正文与可保存 */

const rich: ContentDocument = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: 'a' }, content: [{ type: 'text', text: '真实用户正文' }] },
    { type: 'ritualQuestion', attrs: { id: 'q', template_question_id: null, question_snapshot: '模板问题' } },
    { type: 'aiReply', attrs: { id: 'r', request_id: 'req' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AI 回复' }] }] },
    {
      type: 'goalReview',
      attrs: { id: 'g', link_id: null, goal_snapshot: '跑步', checked_snapshot: false, review_title: '跑步' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '今天跑完了' }] }],
    },
  ],
}
const text = userText(rich)
check(text.includes('真实用户正文'), '用户段落进入用户文字')
check(!text.includes('模板问题'), '问题模板不算用户事实')
check(!text.includes('AI 回复'), 'AI 回复不算用户事实')
check(text.includes('今天跑完了'), '回顾里的回答属于用户')

check(!hasSavableBody(null), '空文档不可保存')
check(!hasSavableBody({ type: 'doc', content: [] }), '空正文不可保存')
check(!hasSavableBody({ type: 'doc', content: [{ type: 'ritualQuestion', attrs: { id: 'x', template_question_id: null, question_snapshot: 'q' } }] }), '只有问题模板不形成文件')
check(hasSavableBody(rich), '有用户正文即可保存')

check(!isRitualDraftSavable({ title: '', content_doc: { type: 'doc', content: [] } }), '空标题空正文不落库')
check(isRitualDraftSavable({ title: '标题', content_doc: { type: 'doc', content: [] } }), '只写标题也形成文件')
check(isRitualDraftSavable({ title: '', content_doc: rich }), '只写正文也形成文件')

equal(previewText('  多   空白\n换行  '), '多 空白 换行', '预览折叠空白')
equal(previewText('一二三四五', 3), '一二三…', '预览按码点截断')

const draft = ritualDraftOf({ title: 'T', contentDoc: rich, journalDate: '2026-10-30', folderId: null })
equal(draft.date, '2026-10-30', '草稿带捕获日期')
equal(draft.folder_id, null, '草稿保留 Folder')
check(!('journal_date' in draft) || draft.date === '2026-10-30', '日期字段唯一')

/* ------------------------------------------------- 5. 复制块与插入位置 */

const sourceDoc: ContentDocument = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: 's1' }, content: [{ type: 'text', text: '旧版本第一段' }] },
    { type: 'bulletList', attrs: { id: 's2' }, content: [{ type: 'listItem', attrs: { id: 'si' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '列表项' }] }] }] },
    { type: 'aiPlaceholder', attrs: { id: 's3', request_id: 'r1' } },
    { type: 'paragraph', attrs: { id: 's4' }, content: [{ type: 'text', text: '带评论', marks: [{ type: 'mindComment', attrs: { comment_ids: ['c1'] } }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: '没有 ID 的段落' }] },
  ],
}
const candidates = copyCandidates(sourceDoc)
equal(candidates.length, 4, '只列带 ID 的顶层块')
equal(candidates[0].nodeId, 's1', '保持文档顺序')
equal(candidates[0].rangeSelectable, true, '段落支持块内范围')
equal(candidates[1].rangeSelectable, false, '列表只能整块复制')
equal(candidates[2].blockedReason, 'AI 正在处理的占位块不能复制。', 'AI 占位不可复制')
check(candidates[3].blockedReason !== null, '带评论 Mark 的块不可复制')
equal(copyCandidates(null).length, 0, '空文档没有可复制块')

const positions = insertPositions(body)
equal(positions.length, 1, '插入位置只列带 ID 的顶层块')
equal(positions[0].nodeId, 'p1', '插入位置取真实节点 ID')
equal(insertPositions({ type: 'doc', content: [{ type: 'paragraph', content: [] }] }).length, 0, '无 ID 段落不能作插入位置')

/* ------------------------------------------------------- 6. 请求载荷 */

const source = {
  id: 11, type: 'journal', title: null, content: '旧', revision: 3,
  journal_date: '2026-10-30', journal_kind: 'set', folder_id: null,
  deleted_at: '2026-10-30T10:00:00Z', created_at: '', updated_at: '',
  content_doc: sourceDoc,
} as unknown as Journal
const target = {
  id: 12, type: 'journal', title: null, content: '新', revision: 7,
  journal_date: '2026-10-30', journal_kind: 'set', folder_id: null,
  deleted_at: null, created_at: '', updated_at: '',
  content_doc: body,
  related_revisions: [{ type: 'journal', id: 12, revision: 7 }, { type: 'journal', id: 13, revision: 2 }, { type: 'journal', id: 11, revision: 3 }],
} as unknown as Journal

equal(relatedRevisionsFor(target, [11, 12]).length, 1, '关联版本排除来源与目标')
equal(relatedRevisionsFor(target, [11, 12])[0].id, 13, '保留其它关联文件')
equal(relatedRevisionsFor(null).length, 0, '无详情时为空')

const copied = buildCopyPayload({
  source, target, copyId: 'c-1',
  selection: [{ node_id: 's1' }, { node_id: 's1', from: 0, to: 4 }],
  insertAfterNodeId: 'p1',
  relatedRevisions: relatedRevisionsFor(target, []),
})
check(!copied.ok, '同一块重复选择被拒绝')

const okCopy = buildCopyPayload({
  source, target, copyId: 'c-1',
  selection: [{ node_id: 's1' }, { node_id: 's2' }],
  insertAfterNodeId: 'p1',
  relatedRevisions: relatedRevisionsFor(target, []),
})
check(okCopy.ok, '合法复制载荷')
if (okCopy.ok) {
  equal(okCopy.payload.source_revision, 3, '来源版本来自回收箱详情')
  equal(okCopy.payload.expected_target_revision, 7, '目标版本来自当前文件')
  equal(okCopy.payload.selection.length, 2, '选择项完整保留')
  equal(okCopy.payload.insert_after_node_id, 'p1', '插入位置原样提交')
  equal(okCopy.payload.related_revisions.length, 1, '关联版本过滤后只剩无关文件')
  equal(okCopy.payload.related_revisions[0].id, 13, '过滤掉来源与目标自身')
  check(!('content' in okCopy.payload), '载荷不携带正文')
}

const rangeCopy = buildCopyPayload({
  source, target, copyId: 'c-2',
  selection: [{ node_id: 's1', from: 2, to: 6 }],
  insertAfterNodeId: 'p1',
})
check(rangeCopy.ok, '段落块内范围可复制')
if (rangeCopy.ok) equal(rangeCopy.payload.selection[0].from, 2, '保留码点起点')

check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [], insertAfterNodeId: 'p1' }).ok, '空选择被拒绝')
check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [{ node_id: 'missing' }], insertAfterNodeId: 'p1' }).ok, '不存在的块被拒绝')
check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [{ node_id: 's2' , from: 0, to: 2 }], insertAfterNodeId: 'p1' }).ok, '列表不接受块内范围')
check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [{ node_id: 's1', from: 4, to: 4 }], insertAfterNodeId: 'p1' }).ok, '空范围被拒绝')
check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [{ node_id: 's1', from: 5, to: 2 }], insertAfterNodeId: 'p1' }).ok, '反向范围被拒绝')
check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [{ node_id: 's1', from: 0 }], insertAfterNodeId: 'p1' }).ok, '半截范围被拒绝')
check(!buildCopyPayload({ source, target, copyId: 'c-3', selection: [{ node_id: 's1' }], insertAfterNodeId: 's1' }).ok, '插入位置必须在目标文档里')
check(!buildCopyPayload({ source, target, copyId: '  ', selection: [{ node_id: 's1' }], insertAfterNodeId: 'p1' }).ok, '缺少 copy_id 被拒绝')

const restore = buildRestorePayload(source, target, relatedRevisionsFor(target, []))
check(restore.ok, '合法替换载荷')
if (restore.ok) {
  equal(restore.payload.target_id, 12, '替换目标是当前有效文件')
  equal(restore.payload.expected_target_revision, 7, '目标版本用于 CAS')
  equal(restore.payload.related_revisions.length, 1, '替换同样过滤自身')
}
check(!buildRestorePayload(source, source, []).ok, '来源与目标相同被拒绝')
check(!buildRestorePayload({ ...source, revision: 0 } as unknown as Journal, target, []).ok, '缺少来源版本被拒绝')

/* ------------------------------------------------------- 7. 目标视图 */

const setDoc: ContentDocument = {
  type: 'doc',
  content: [
    { type: 'goalItem', attrs: { id: 'g1', goal_id: 'goal-a', text: '跑步 5km', checked: false } },
    { type: 'goalItem', attrs: { id: 'g2', goal_id: 'goal-b', text: '读完一章', checked: true } },
    { type: 'paragraph', attrs: { id: 'p2' }, content: [{ type: 'text', text: '备注' }] },
  ],
}
const goals = goalsOf(setDoc)
equal(goals.length, 2, '识别两个目标')
equal(goals[0].goalId, 'goal-a', '目标 ID 保留')
equal(goals[1].checked, true, '完成状态读自 attrs')
equal(goalsOf(null).length, 0, '空文档无目标')

const endDoc: ContentDocument = {
  type: 'doc',
  content: [
    { type: 'goalReview', attrs: { id: 'r1', link_id: 'link-1', goal_snapshot: '跑步 5km', checked_snapshot: true, review_title: '跑步 5km' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '跑得不错' }] }] },
    { type: 'goalReview', attrs: { id: 'r2', link_id: null, goal_snapshot: '读完一章', checked_snapshot: false, review_title: '读完一章' }, content: [] },
  ],
}
const reviews = reviewsOf(endDoc, [{ link_id: 'link-1', set_id: 11, end_id: 12, goal_id: 'goal-a', end_node_id: 'r1' }])
equal(reviews.length, 2, '识别两个回顾')
equal(reviews[0].sourceAvailable, true, '有关联即来源可用')
equal(reviews[0].answer, '跑得不错', '回答独立读取')
equal(reviews[0].goalId, 'goal-a', '通过 link 反查目标')
equal(reviews[0].setId, 11, '通过 link 反查开始今天')
equal(reviewCanWriteBack(reviews[0]), true, '身份齐全可回写')
equal(reviews[1].sourceAvailable, false, '解除关联后来源不可用')
equal(reviewCanWriteBack(reviews[1]), false, '来源不可用不能回写')
check(reviews[1].answer === '', '解除关联不影响回答内容')

const absent = canAddGoalToEnd(null)
check(!absent.available, '缺结束今天时不可加入')
if (!absent.available) check(absent.reason.includes('fail-closed'), '说明服务端限制')
check(canAddGoalToEnd(target).available, '有结束今天时可以加入')

/* ------------------------------------------------- 8. 回收箱筛选 */

const trash = [
  { id: 1, journal_kind: 'set', journal_date: '2026-10-30' },
  { id: 2, journal_kind: 'end', journal_date: '2026-10-30' },
  { id: 3, journal_kind: 'set', journal_date: '2026-10-29' },
  { id: 4, journal_kind: 'writing', journal_date: '2026-10-30' },
] as unknown as Journal[]
equal(deletedRitualsOf(trash, 'set', '2026-10-30').length, 1, '只取同日同类的开始今天')
equal(deletedRitualsOf(trash, 'set', '2026-10-30')[0].id, 1, '取到正确的旧版本')
equal(deletedRitualsOf(trash, 'end', '2026-10-30')[0].id, 2, '结束今天分别筛选')
equal(deletedRitualsOf(trash, 'end', '2026-10-29').length, 0, '不同日期不混入')

/* ------------------------------------------------- 9. 本地草稿归属筛选 */

const todayPage = { kind: 'set' as const, journalDate: '2026-10-30', fileId: null }
equal(
  ritualRecordMatches({ journal_kind: 'set', business_date: '2026-10-30', file_id: null }, todayPage),
  true,
  '同日同类的未落库草稿属于本页',
)
equal(
  ritualRecordMatches({ journal_kind: 'set', business_date: '2026-10-29', file_id: null }, todayPage),
  false,
  '不同业务日的草稿不混进本页（恢复它会隐式改日期）',
)
equal(
  ritualRecordMatches({ journal_kind: 'end', business_date: '2026-10-30', file_id: null }, todayPage),
  false,
  '结束今天的草稿不出现在开始今天页',
)
equal(
  ritualRecordMatches({ journal_kind: 'set', business_date: '2026-10-28', file_id: 77 }, {
    kind: 'set', journalDate: '2026-10-30', fileId: 77,
  }),
  true,
  '当前文件的草稿即使业务日记成别的日期仍属于本页',
)
equal(
  ritualRecordMatches({ journal_kind: 'set', business_date: '2026-10-30', file_id: 78 }, {
    kind: 'set', journalDate: '', fileId: 77,
  }),
  false,
  '业务日未知时只按当前文件匹配，不按日期瞎匹配',
)

console.log(`ritualView: ${checks} 项断言通过`)