/**
 * 完整复盘选择 / 预览 / 保存纯逻辑测试（Stage 3 / S3-T09）。
 *
 * 不引入测试框架，直接用 Node 的类型剥离运行：
 *
 *   node --experimental-strip-types src/utils/reviewSelection.test.ts
 *
 * 断言只用 `throw`，因此不依赖 Node 类型声明，也能被 `tsc -b` 检查。
 *
 * 反例覆盖 `docs/stage3-tasks.md` §11 的验收点与 `docs/stage3-api.md` §5～§6：
 * type+id 去重（Journal 1 ≠ Inbox 1）、15 文件 / 7 日期边界、非连续日期合法、
 * 同日多篇不误限、文本量排除 AI 段且不用截断卡片、默认目标规则、payload 形状与
 * 可重放排序、review 对象严格解析、阶段映射与恢复计划。
 */

import {
  REVIEW_MAX_DATES,
  REVIEW_MAX_SOURCES,
  addEntry,
  buildReviewRequest,
  buildTargetPayload,
  canAddEntry,
  defaultTargetMode,
  distinctDates,
  initialTargetDraft,
  limitFor,
  limitMessage,
  parseReviewObject,
  reviewCanGenerate,
  reviewInFlight,
  reviewPhaseForStatus,
  reviewRecoveryAction,
  reviewRecoveryEntries,
  sameSource,
  selectionLabel,
  sortSources,
  sourceKey,
  summarizeSelection,
  toggleEntry,
  userCodePointsOf,
  userTextOf,
  validateTargetDraft,
  type ReviewEntry,
  type ReviewSource,
} from './reviewSelection.ts'
import type { AIReviewObject } from '../types/ai.ts'
import type { AiRecoveryEntry } from './aiRequestState.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`失败：${label}`)
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  if (actualText !== expectedText) {
    throw new Error(`失败：${label}\n  实际 ${actualText}\n  期望 ${expectedText}`)
  }
  passed += 1
}

function journal(id: number): ReviewSource {
  return { type: 'journal', id }
}
function inbox(id: number): ReviewSource {
  return { type: 'inbox', id }
}
function entry(source: ReviewSource, date: string, userCodePoints?: number): ReviewEntry {
  return userCodePoints === undefined ? { source, date } : { source, date, userCodePoints }
}

/* ------------------------------------------------ 身份去重与排序 */

check(sourceKey(journal(3)) === 'journal:3', 'sourceKey 用 type:id')
check(!sameSource(journal(1), inbox(1)), '同 id 的 Journal 与 Inbox 不是同一篇')
check(!sameSource(journal(1), journal(2)), '不同 id 不等')
check(sameSource(inbox(7), inbox(7)), '相同 typed id 相等')

expectEqual(
  sortSources([journal(2), inbox(1), journal(1), inbox(10)]),
  [inbox(1), inbox(10), journal(1), journal(2)],
  '源按 (type,id) 确定性排序',
)

/* ------------------------------------------------ 选择集合去重 */

{
  let selection = addEntry([], entry(journal(1), '2026-03-01'))
  selection = addEntry(selection, entry(inbox(1), '2026-03-01'))
  expectEqual(selection.length, 2, '同 id 不同类型各自保留')
  const again = addEntry(selection, entry(journal(1), '2026-03-01'))
  expectEqual(again.length, 2, '重复 addEntry 不新增')
  const toggled = toggleEntry(selection, entry(journal(1), '2026-03-01'))
  expectEqual(toggled.map((item) => sourceKey(item.source)), ['inbox:1'], '再次勾选取消该源')
  const reToggled = toggleEntry(toggled, entry(journal(1), '2026-03-01'))
  expectEqual(reToggled.length, 2, '取消后可再次勾选')
}

/* ------------------------------------------------ 15 文件限额 */

{
  const sameDay = '2026-03-01'
  const fifteen = Array.from({ length: REVIEW_MAX_SOURCES }, (_, index) => entry(journal(index + 1), sameDay))
  check(fifteen.length === 15, '构造 15 篇')
  const current = fifteen.reduce<ReviewEntry[]>((acc, item) => addEntry(acc, item), [])
  expectEqual(canAddEntry(current, entry(journal(99), sameDay)), { ok: false, reason: 'too_many_sources' },
    '第 16 篇被拒绝')
  check(limitFor(current).ok, '恰好 15 篇仍合法')
  expectEqual(limitFor([...current, entry(journal(99), sameDay)]).reason, 'too_many_sources', '16 篇越界')
  check(limitMessage('too_many_sources').includes('15'), '限额文案提到 15')
}

/* ------------------------------------------------ 7 日期限额 / 同日多篇不误限 */

{
  const sevenDates = Array.from({ length: REVIEW_MAX_DATES }, (_, index) => `2026-03-0${index + 1}`)
  const seven = sevenDates.reduce<ReviewEntry[]>((acc, date) => addEntry(acc, entry(journal(1 + acc.length), date)), [])
  check(limitFor(seven).ok, '7 个不同日期合法')
  expectEqual(distinctDates(seven).length, 7, '不同日期数为 7')
  expectEqual(canAddEntry(seven, entry(journal(50), '2026-03-08')),
    { ok: false, reason: 'too_many_dates' }, '第 8 个新日期被拒绝')

  // 同日多篇：7 个日期各 2 篇 = 14 篇，再加同日期第 3 篇仍可（不新增日期）。
  const doubled = [...seven, entry(journal(101), sevenDates[0]), entry(journal(102), sevenDates[1]),
    entry(journal(103), sevenDates[2]), entry(journal(104), sevenDates[3]),
    entry(journal(105), sevenDates[4]), entry(journal(106), sevenDates[5]),
    entry(journal(107), sevenDates[6])]
  expectEqual(doubled.length, 14, '双向 14 篇')
  expectEqual(canAddEntry(doubled, entry(journal(200), sevenDates[0])), { ok: true, reason: null },
    '同一日期第 3 篇不触发日期限额')
  expectEqual(canAddEntry(doubled, entry(journal(201), '2026-04-01')),
    { ok: false, reason: 'too_many_dates' }, '14 篇时新增第 8 个日期仍被拒绝')

  // 非连续日期合法。
  const sparse = [entry(journal(1), '2026-01-01'), entry(journal(2), '2026-06-15'), entry(journal(3), '2026-12-31')]
  check(limitFor(sparse).ok, '非连续 3 个日期合法')

  // 业务日期尚未读到的预选源不占日期名额（避免误报超过 7 个日期）。
  const unknownDate = sevenDates.reduce<ReviewEntry[]>((acc, date) => addEntry(acc, entry(journal(1 + acc.length), date)), [])
  expectEqual(canAddEntry(unknownDate, entry(inbox(300), '')), { ok: true, reason: null },
    '日期未知的候选不触发日期限额')
  expectEqual(distinctDates([entry(journal(1), ''), entry(journal(2), '2026-03-01')]), ['2026-03-01'],
    '空日期不计入不同日期数')
}

/* ------------------------------------------------ 文本量（排除 AI 段） */

{
  check(userTextOf({ content: '只有旧正文' }) === '只有旧正文', '旧 NULL 正文整体当用户正文')
  const structured = {
    content: '（阅读投影，不参与计算）',
    content_blocks: [
      { kind: 'user', text: '今天很累。' },
      { kind: 'ai_reply', text: '是谁让你累呀？' },
      { kind: 'user', text: '接了太多活。' },
      { kind: 'ai_summary', text: '这段总结不算用户正文' },
    ],
  }
  expectEqual(userTextOf(structured), '今天很累。接了太多活。', '只拼 user 段，排除 AI 段')
  check(userCodePointsOf(structured) === 11, '用户正文码点数按 user 段计')
  // 未截断的卡片摘要不能冒充全文字数：这里用真实全文长度断言。
  check(userCodePointsOf({ content: '一二三四五六七八九十' }) === 10, '全文长度按码点计')
  check(userCodePointsOf({ content: '🧭' }) === 1, 'emoji 按 1 个码点计')
}

/* ------------------------------------------------ 选择摘要 */

{
  const summary = summarizeSelection([
    entry(journal(1), '2026-03-01', 100),
    entry(inbox(2), '2026-03-01', 50),
    entry(journal(3), '2026-03-05'),
  ])
  expectEqual(summary.count, 3, '摘要统计篇数')
  expectEqual(summary.dateCount, 2, '摘要统计不同日期')
  expectEqual(summary.totalCodePoints, 150, '只累加已载入的字数')
  expectEqual(summary.pendingTextCount, 1, '未载入详情计入 pending')
  check(summary.limits.ok, '合法选择')
  check(selectionLabel(summary).includes('复盘所选 3 篇（150 字'), '标签包含「复盘所选 N 篇（X 字）」')
}

/* ------------------------------------------------ 默认保存目标 */

{
  check(defaultTargetMode([journal(1)]) === 'append_source', '单篇 Journal 默认追加')
  check(defaultTargetMode([inbox(1)]) === 'new_journal', '单篇 Inbox 默认新建')
  check(defaultTargetMode([journal(1), inbox(2)]) === 'new_journal', '多篇默认新建')
  check(defaultTargetMode([journal(1), journal(2)]) === 'new_journal', '多篇 Journal 也默认新建')

  const draft = initialTargetDraft([journal(1)], '2026-04-09')
  expectEqual(draft, { mode: 'append_source', title: '', journal_date: '2026-04-09', folder_id: null },
    '初始目标：日期取发起时业务日期、Folder null、标题空')

  expectEqual(buildTargetPayload(draft), { mode: 'append_source' }, '追加目标只发 mode')

  const newTarget = { mode: 'new_journal' as const, title: '', journal_date: '2026-04-09', folder_id: null }
  expectEqual(buildTargetPayload(newTarget),
    { mode: 'new_journal', title: null, journal_date: '2026-04-09', folder_id: null },
    '空标题提交 null（后端补默认标题）')
  expectEqual(buildTargetPayload({ ...newTarget, title: '我的复盘', folder_id: 7 }),
    { mode: 'new_journal', title: '我的复盘', journal_date: '2026-04-09', folder_id: 7 },
    '保留用户改的标题与 Folder')

  check(validateTargetDraft(newTarget) === null, '合法 new_journal 目标')
  check(validateTargetDraft({ ...newTarget, journal_date: '  ' }) !== null, '缺日期被拒绝')
  check(validateTargetDraft({ ...newTarget, title: 'a'.repeat(81) }) !== null, '标题超 80 码点被拒绝')
  check(validateTargetDraft({ mode: 'append_source', title: 'a'.repeat(200), journal_date: '', folder_id: null }) === null,
    'append_source 不校验日期/标题')
}

/* ------------------------------------------------ 请求 payload 可重放 */

{
  const payload = buildReviewRequest('11111111-1111-4111-8111-111111111111', [
    { source: journal(12), revision: 6 },
    { source: inbox(9), revision: 3 },
  ])
  expectEqual(payload, {
    request_id: '11111111-1111-4111-8111-111111111111',
    sources: [
      { type: 'inbox', id: 9, expected_revision: 3 },
      { type: 'journal', id: 12, expected_revision: 6 },
    ],
  }, 'payload 只含 request_id + 排序后的 typed sources')
  // 输入顺序不同也必须产出逐字相同的 payload（同键重放不能变成 409）。
  const replay = buildReviewRequest('11111111-1111-4111-8111-111111111111', [
    { source: inbox(9), revision: 3 },
    { source: journal(12), revision: 6 },
  ])
  expectEqual(replay, payload, '不同输入顺序产出同一 payload')
}

/* ------------------------------------------------ review 对象解析 */

function validReview(): AIReviewObject {
  return {
    facts: [{ text: '接了太多活', evidence: [{ source: { type: 'journal', id: 12 }, quote: '接了太多活' }] }],
    emotion_hypotheses: [{
      text: '有点累', uncertainty: '只凭一句话',
      evidence: [{ source: { type: 'journal', id: 12 }, quote: '今天很累' }],
    }],
    possible_explanations: [{
      text: '怕让人失望', uncertainty: '证据不足',
      evidence: [{ source: { type: 'inbox', id: 9 }, quote: '不想拒绝' }],
    }],
    angles: [
      { title: '事件与情绪', content: '事件：加班' },
      { title: '选择与行为', content: '选择：又接了活' },
      { title: '认知与关系', content: '认知：怕被否定' },
    ],
    logic_chain: ['感到累', '仍接下任务'],
    follow_up_questions: ['当时最想拒绝的是哪件？'],
    insight_drafts: [{
      draft_id: '55555555-5555-4555-8555-5555555555aa',
      title: '怕让人失望',
      viewpoint: '怕让人失望所以不敢拒绝',
      evidence: [{ source: { type: 'journal', id: 12 }, quote: '接了太多活' }],
      content: '观点：怕让人失望。依据：接了太多活。',
    }],
    markdown: '## 事实\n\n- 接了太多活',
  }
}

{
  const parsed = parseReviewObject(validReview())
  check(parsed !== null, '合法 review 对象可解析')
  expectEqual(parsed?.angles.length, 3, '三个角度保留')
  expectEqual(parsed?.insight_drafts[0]?.draft_id, '55555555-5555-4555-8555-5555555555aa', 'draft_id 保留')

  check(parseReviewObject(null) === null, 'null 不可解析')
  check(parseReviewObject({}) === null, '缺少必需字段返回 null')
  check(parseReviewObject({ ...validReview(), markdown: '' }) === null, '空 markdown 返回 null')
  check(parseReviewObject({ ...validReview(), facts: [{ text: 'x', evidence: [] }] }) === null,
    '证据为空返回 null')
  check(parseReviewObject({
    ...validReview(),
    facts: [{ text: 'x', evidence: [{ source: { type: 'insight', id: 1 }, quote: 'x' }] }],
  }) === null, '非法证据源类型返回 null')
  check(parseReviewObject({ ...validReview(), emotion_hypotheses: [{ text: 'x', evidence: [{ source: { type: 'journal', id: 1 }, quote: 'x' }] }] }) === null,
    '推测缺少 uncertainty 返回 null')
  check(parseReviewObject({ ...validReview(), insight_drafts: [{ title: 'x' }] }) === null,
    '草稿缺 draft_id 返回 null')
  const emptyDrafts = parseReviewObject({ ...validReview(), insight_drafts: [] })
  check(emptyDrafts !== null && emptyDrafts.insight_drafts.length === 0, '零草稿是合法结果')
  const emptyFacts = parseReviewObject({ ...validReview(), facts: [] })
  check(emptyFacts !== null && emptyFacts.facts.length === 0, '空事实列表是合法结果')
}

/* ------------------------------------------------ 阶段与恢复 */

{
  expectEqual(reviewPhaseForStatus('ready'), 'ready', 'ready → ready')
  expectEqual(reviewPhaseForStatus('pending'), 'polling', 'pending → polling')
  expectEqual(reviewPhaseForStatus('applied'), 'applied', 'applied → applied')
  expectEqual(reviewPhaseForStatus('conflict'), 'conflict', 'conflict → conflict')
  expectEqual(reviewPhaseForStatus('bogus'), 'unknown', '未知取值按 unknown')
  expectEqual(reviewPhaseForStatus(null), 'unknown', 'null 按 unknown')

  check(reviewInFlight('generating') && !reviewCanGenerate('generating'), '生成中锁住第二次点击')
  check(reviewInFlight('saving'), '保存中算在途')
  check(reviewCanGenerate('ready') && reviewCanGenerate('failed') && reviewCanGenerate('idle'),
    '终态可以再次发起')

  expectEqual(reviewRecoveryAction('missing'), 'drop', '404 移除恢复入口')
  expectEqual(reviewRecoveryAction('pending'), 'poll', 'pending 继续有限轮询')
  expectEqual(reviewRecoveryAction('ready'), 'show', 'ready 直接展示')
  expectEqual(reviewRecoveryAction('applied'), 'show', 'applied 展示已保存目标')

  const entries: AiRecoveryEntry[] = [
    { requestId: '11111111-1111-4111-8111-111111111111', kind: 'local', source: { type: 'journal', id: 1 } },
    { requestId: '22222222-2222-4222-8222-222222222222', kind: 'review', source: { type: 'journal', id: 1 } },
    { requestId: '33333333-3333-4333-8333-333333333333', kind: 'review', source: { type: 'inbox', id: 5 } },
  ]
  expectEqual(reviewRecoveryEntries(entries).map((item) => item.requestId),
    ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
    '只挑出 review 入口')
}

console.log(`reviewSelection.test.ts 通过 ${passed} 项断言`)
