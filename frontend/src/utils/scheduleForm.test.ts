/**
 * 日程表单/错误纯逻辑测试（C01）。
 *
 * 运行：`node --experimental-strip-types src/utils/scheduleForm.test.ts`
 *
 * 覆盖 §13 里最容易写错的几条：标题按**码点**限 80、结束必须晚于开始、
 * 缺时间不替用户猜、PATCH 只提交变化字段、`client_create_id` 只在显式新建时生成、
 * 候选只是候选（零写入）、错误状态码映射到可恢复的动作。
 */

import type { Schedule } from '../types/schedule.ts'
import {
  buildCreateInput,
  candidateToDraft,
  countCodePoints,
  describeRangeIssue,
  describeScheduleFailure,
  draftFromSchedule,
  draftToUpdateInput,
  emptyScheduleDraft,
  newClientCreateId,
  SCHEDULE_TITLE_MAX_CODE_POINTS,
  validateScheduleDraft,
} from './scheduleForm.ts'

let assertions = 0

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  assertions += 1
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${String(expected)}，实际 ${String(actual)}`)
  }
}

function expectTrue(value: boolean, label: string): void {
  assertions += 1
  if (!value) throw new Error(`${label}：期望 true`)
}

function expectNull(value: unknown, label: string): void {
  assertions += 1
  if (value !== null) throw new Error(`${label}：期望 null，实际 ${String(value)}`)
}

const baseline: Schedule = {
  id: 5,
  title: '与导师讨论提纲',
  starts_at: '2026-10-30T06:30:00.000Z',
  ends_at: '2026-10-30T07:30:00.000Z',
  completed: false,
  revision: 3,
  created_at: '2026-10-29T00:00:00.000Z',
  updated_at: '2026-10-29T00:00:00.000Z',
}

/* ------------------------------------------------ 码点计数 */

expectEqual(SCHEDULE_TITLE_MAX_CODE_POINTS, 80, '上限常量')
expectEqual(countCodePoints('😀'), 1, 'emoji 是 1 个码点')
expectEqual(countCodePoints('中文abc'), 5, '中英文混合')
expectEqual('😀'.length, 2, '对照组：UTF-16 长度会把 emoji 当 2')

/* ------------------------------------------------ 标题校验 */

const emptyTitle = validateScheduleDraft({ ...emptyScheduleDraft(), startsAtInput: '2026-10-30T14:30' })
expectNull(emptyTitle.payload, '空标题不通过')
expectEqual(emptyTitle.errors.title, '标题不能为空。', '空标题提示')

const blankTitle = validateScheduleDraft({
  title: '    ',
  startsAtInput: '2026-10-30T14:30',
  endsAtInput: '',
  completed: false,
})
expectNull(blankTitle.payload, '全空白标题等同空标题')

const eightyEmoji = validateScheduleDraft({
  title: '😀'.repeat(80),
  startsAtInput: '2026-10-30T14:30',
  endsAtInput: '',
  completed: false,
})
expectTrue(eightyEmoji.payload !== null, '80 个 emoji（160 UTF-16 单元）应通过')
expectEqual(countCodePoints('😀'.repeat(80)), 80, '80 emoji 的码点数')

const eightyOneEmoji = validateScheduleDraft({
  title: '😀'.repeat(81),
  startsAtInput: '2026-10-30T14:30',
  endsAtInput: '',
  completed: false,
})
expectNull(eightyOneEmoji.payload, '81 个码点不通过')
expectTrue((eightyOneEmoji.errors.title ?? '').includes('80'), '超限提示含上限值')

/* ------------------------------------------------ 时间校验 */

const noStart = validateScheduleDraft({ title: '跑步', startsAtInput: '', endsAtInput: '', completed: false })
expectNull(noStart.payload, '缺开始时间不通过')
expectEqual(noStart.errors.startsAt, '需要开始时间。', '缺开始时间提示')

const badStart = validateScheduleDraft({
  title: '跑步',
  startsAtInput: '2026-02-30T10:00',
  endsAtInput: '',
  completed: false,
})
expectNull(badStart.payload, '不存在的日期不通过')

const equalRange = validateScheduleDraft({
  title: '跑步',
  startsAtInput: '2026-10-30T10:00',
  endsAtInput: '2026-10-30T10:00',
  completed: false,
})
expectNull(equalRange.payload, '结束等于开始不通过')
expectEqual(equalRange.errors.endsAt, '结束时间必须晚于开始时间。', '相等时的提示')

const reversedRange = validateScheduleDraft({
  title: '跑步',
  startsAtInput: '2026-10-30T10:00',
  endsAtInput: '2026-10-30T09:30',
  completed: false,
})
expectNull(reversedRange.payload, '结束早于开始不通过')

const reversedAcrossDay = validateScheduleDraft({
  title: '跨天',
  startsAtInput: '2026-10-30T23:00',
  endsAtInput: '2026-10-30T01:00',
  completed: false,
})
expectNull(reversedAcrossDay.payload, '跨天但结束早于开始不通过')

const okDraft = validateScheduleDraft({
  title: '  与导师讨论  ',
  startsAtInput: '2026-10-30T14:30',
  endsAtInput: '2026-10-30T16:00',
  completed: false,
})
expectTrue(okDraft.payload !== null, '合法草稿通过')
expectEqual(okDraft.payload?.title, '与导师讨论', '标题按 trim 后提交')
expectEqual(okDraft.payload?.starts_at, '2026-10-30T06:30:00.000Z', '开始时间转为 UTC ISO')
expectEqual(okDraft.payload?.ends_at, '2026-10-30T08:00:00.000Z', '结束时间转为 UTC ISO')

const noEnd = validateScheduleDraft({ title: '散步', startsAtInput: '2026-10-30T20:00', endsAtInput: '', completed: true })
expectEqual(noEnd.payload?.ends_at, null, '空结束时间提交为 null')
expectEqual(noEnd.payload?.completed, true, 'completed 原样带入')

/* ------------------------------------------------ 时间区间提示（D3） */

/*
 * D3 的根因是浏览器原生 `min` 先拦截，产品中文提示没机会出现。
 * 页面已改为 `noValidate` + 这里的中文判定，所以这组用例是那条提示的唯一来源，
 * 必须覆盖「早于 / 等于 / 晚于」三态。
 */
const rangeEarly = describeRangeIssue({
  title: '跑步',
  startsAtInput: '2026-10-30T10:00',
  endsAtInput: '2026-10-30T09:59',
  completed: false,
})
expectEqual(rangeEarly, '结束时间必须晚于开始时间。', '结束早于开始有中文提示')

const rangeEqual = describeRangeIssue({
  title: '跑步',
  startsAtInput: '2026-10-30T10:00',
  endsAtInput: '2026-10-30T10:00',
  completed: false,
})
expectEqual(rangeEqual, '结束时间必须晚于开始时间。', '结束等于开始同样提示')

const rangeLater = describeRangeIssue({
  title: '跑步',
  startsAtInput: '2026-10-30T10:00',
  endsAtInput: '2026-10-30T10:01',
  completed: false,
})
expectEqual(rangeLater, null, '结束晚于开始一秒即通过')

const rangeNextDay = describeRangeIssue({
  title: '跨夜',
  startsAtInput: '2026-10-30T23:00',
  endsAtInput: '2026-10-31T00:30',
  completed: false,
})
expectEqual(rangeNextDay, null, '跨天但结束更晚，不误判')

const rangeNoStart = describeRangeIssue({ title: '跑步', startsAtInput: '', endsAtInput: '2026-10-30T09:00', completed: false })
expectEqual(rangeNoStart, null, '缺开始时间不报区间错误（由字段错误说明）')

const rangeNoEnd = describeRangeIssue({ title: '跑步', startsAtInput: '2026-10-30T09:00', endsAtInput: '', completed: false })
expectEqual(rangeNoEnd, null, '结束留空合法')

const rangeBadEnd = describeRangeIssue({
  title: '跑步',
  startsAtInput: '2026-10-30T09:00',
  endsAtInput: '2026-02-30T10:00',
  completed: false,
})
expectEqual(rangeBadEnd, null, '结束时间非法时不误报区间错误（由字段错误说明）')

const validatedEarly = validateScheduleDraft({
  title: '跑步',
  startsAtInput: '2026-10-30T10:00',
  endsAtInput: '2026-10-30T09:00',
  completed: false,
})
expectEqual(validatedEarly.errors.endsAt, '结束时间必须晚于开始时间。', '提交校验复用同一中文提示')
expectNull(validatedEarly.payload, '非法区间不生成提交数据')

/* ------------------------------------------------ 编辑差异 */

const fromBaseline = draftFromSchedule(baseline)
expectEqual(fromBaseline.startsAtInput, '2026-10-30T14:30', '回填上海本地时间')
expectEqual(fromBaseline.endsAtInput, '2026-10-30T15:30', '回填结束时间')
expectEqual(fromBaseline.completed, false, '回填完成状态')

expectNull(draftToUpdateInput(fromBaseline, baseline), '无变化不提交')

const titleChanged = draftToUpdateInput({ ...fromBaseline, title: '改标题' }, baseline)
expectEqual(titleChanged?.expected_revision, 3, 'PATCH 带当前版本')
expectEqual(titleChanged?.title, '改标题', 'PATCH 带标题')
expectEqual(titleChanged?.starts_at, undefined, '没改时间就不带开始时间')
expectEqual(titleChanged?.ends_at, undefined, '没改时间就不带结束时间')
expectEqual(titleChanged?.completed, undefined, '没改完成状态就不带')

const sameInstant = draftToUpdateInput(fromBaseline, { ...baseline, starts_at: '2026-10-30T06:30:00Z' })
expectNull(sameInstant, '同一时刻的不同写法不算改动')

// 带时区偏移的同一时刻同样不能算改动：字符串不同，时刻相同（D3「等价时刻不误判」）。
const offsetBaseline: Schedule = {
  ...baseline,
  starts_at: '2026-10-30T14:30:00+08:00',
  ends_at: '2026-10-30T16:00:00+08:00',
}
expectNull(
  draftToUpdateInput(draftFromSchedule(offsetBaseline), offsetBaseline),
  '+08:00 与回填的上海本地值指向同一时刻，不算改动',
)

const clearedEnd = draftToUpdateInput({ ...fromBaseline, endsAtInput: '' }, baseline)
expectEqual(clearedEnd?.ends_at, null, '清空结束时间提交 null')
expectEqual(clearedEnd?.title, undefined, '清空结束时间不动标题')

const done = draftToUpdateInput({ ...fromBaseline, completed: true }, baseline)
expectEqual(done?.completed, true, '完成状态可单独提交')

const invalidEdit = draftToUpdateInput({ ...fromBaseline, title: '   ' }, baseline)
expectNull(invalidEdit, '非法草稿不生成 PATCH')

/* ------------------------------------------------ 创建请求 */

const createInput = buildCreateInput(
  { title: '晨跑', starts_at: '2026-10-30T00:00:00.000Z', ends_at: null, completed: false },
  'fixed-key',
)
expectEqual(createInput.client_create_id, 'fixed-key', '创建带幂等键')
expectEqual(createInput.title, '晨跑', '创建带标题')

const keyOne = newClientCreateId()
expectEqual(keyOne.length > 0, true, '幂等键非空')
expectTrue(/^[0-9a-f-]{36}$/i.test(keyOne), '幂等键是 UUID 形状')
expectEqual(keyOne === newClientCreateId(), false, '每次显式新建才换键')

/* ------------------------------------------------ 候选（零写入） */

const noTimeCandidate = candidateToDraft({
  candidate_id: 'c1',
  title: '明天开会',
  starts_at: null,
  ends_at: null,
})
expectEqual(noTimeCandidate.draft.startsAtInput, '', '缺时间的候选不编时间')
expectEqual(noTimeCandidate.draft.title, '明天开会', '候选标题带入')
expectEqual(noTimeCandidate.draft.completed, false, '候选不预先完成')
expectEqual(noTimeCandidate.issues.length, 1, '缺时间只报一条待补充')
expectTrue(noTimeCandidate.issues[0]?.includes('补充') === true, '待补充提示可读')

const fullCandidate = candidateToDraft({
  candidate_id: 'c2',
  title: '与导师讨论',
  starts_at: '2026-10-30T06:30:00.000Z',
  ends_at: '2026-10-30T08:00:00.000Z',
})
expectEqual(fullCandidate.issues.length, 0, '完整候选没有待补充项')
expectEqual(fullCandidate.draft.startsAtInput, '2026-10-30T14:30', '候选时间转上海本地值')

const badRangeCandidate = candidateToDraft({
  candidate_id: 'c3',
  title: '倒序',
  starts_at: '2026-10-30T08:00:00.000Z',
  ends_at: '2026-10-30T06:30:00.000Z',
})
expectTrue(badRangeCandidate.issues.some((issue) => issue.includes('不晚于')), '倒序候选提示修改')

const emptyTitleCandidate = candidateToDraft({ candidate_id: 'c4', title: '   ', starts_at: null, ends_at: null })
expectTrue(emptyTitleCandidate.issues.some((issue) => issue.includes('标题')), '空标题候选提示补充')

/* ------------------------------------------------ 错误映射 */

const notFound = describeScheduleFailure({ status: 404, message: '不存在' }, 'get')
expectEqual(notFound.kind, 'not_found', '404 归类')
expectEqual(notFound.needsReload, true, '404 需要重读')

const conflictUpdate = describeScheduleFailure({ status: 409, message: '版本过期' }, 'update')
expectEqual(conflictUpdate.kind, 'revision_conflict', '409 归类为版本冲突')
expectEqual(conflictUpdate.needsReload, true, '409 需要重读')

const conflictCreate = describeScheduleFailure({ status: 409, message: '同键不同内容' }, 'create')
expectEqual(conflictCreate.kind, 'revision_conflict', '创建 409 也归冲突类')
expectTrue(conflictCreate.message.includes('409'), '创建 409 提示能区分场景')
// D1 之后创建失败不再关闭表单，所以文案必须告诉用户「换键」的出口。
expectTrue(conflictCreate.message.includes('新的创建键'), '创建 409 提示如何换幂等键')

const validation = describeScheduleFailure({ status: 422, message: '结束时间必须晚于开始时间。' }, 'update')
expectEqual(validation.kind, 'validation', '422 归类')
expectEqual(validation.message, '结束时间必须晚于开始时间。', '422 使用后端 detail')
expectEqual(validation.needsReload, false, '422 不需要重读列表')

const missingRevision = describeScheduleFailure({ status: 428, message: '缺少版本' }, 'update')
expectEqual(missingRevision.kind, 'missing_revision', '428 归类')
expectEqual(missingRevision.needsReload, true, '428 需要重读')

const networkOnCreate = describeScheduleFailure(new TypeError('Failed to fetch'), 'create')
expectEqual(networkOnCreate.kind, 'network', '无状态码视为网络失败')
expectEqual(networkOnCreate.needsReload, false, '创建网络失败保留表单（复用同键重试）')
expectTrue(networkOnCreate.message.includes('不会重复创建'), '创建网络失败说明幂等重试')

const networkOnToggle = describeScheduleFailure(new Error('网络断了'), 'toggle')
expectEqual(networkOnToggle.needsReload, true, '其它操作网络失败需要重读')

// 交叉测试 D2 缺陷：列表读取失败曾显示「改动未确认」，让用户误以为操作没成功。
const networkOnList = describeScheduleFailure(new Error('网络断了'), 'list')
expectEqual(networkOnList.kind, 'network', '列表网络失败归类')
expectEqual(networkOnList.needsReload, true, '列表网络失败需要重试读取')
expectTrue(networkOnList.message.includes('读取'), '列表网络失败说明是读取问题')
expectEqual(networkOnList.message.includes('改动未确认'), false, '读取失败不误导为改动未确认')

const unknownStatus = describeScheduleFailure({ status: 500, message: '' }, 'list')
expectEqual(unknownStatus.kind, 'unknown', '其它状态码归类')
expectTrue(unknownStatus.message.includes('500'), '未知状态码回显状态数字')

console.log(`scheduleForm: ${assertions} assertions passed`)
