/**
 * AI 局部调用状态 / 恢复索引纯逻辑测试（Stage 3 / S3-T07）。
 *
 * 不引入测试框架，直接用 Node 的类型剥离运行：
 *
 *   node --experimental-strip-types src/utils/aiRequestState.test.ts
 *
 * 断言只用 `throw`，因此不依赖 Node 类型声明，也能被 `tsc -b` 检查。
 *
 * 反例覆盖 `docs/stage3-tasks.md` §9 的验收点与 `docs/stage3-api.md` §4 契约：
 * 状态迁移、noop、unknown 不显示 0、搜索次数单列、引用安全、恢复索引只存
 * request_id/kind/typed 身份、404 移除入口、页面隐藏停止轮询、双击单请求、
 * 失败不自动换新 UUID 重发。
 */

import {
  NOOP_MESSAGE,
  POLL_INTERVAL_MS,
  POLL_MAX_ATTEMPTS,
  RECOVERY_STORAGE_KEY,
  addRecoveryEntry,
  aiCallLocksFile,
  applyAiQuery,
  applyAiResponse,
  applyAiTransportError,
  beginAiCall,
  canStartAiCall,
  describeErrorCategory,
  expirePolling,
  findRecoveryEntry,
  formatCallUsage,
  initialAiCallState,
  isSafeHttpUrl,
  normalizeQuestion,
  nextPollDelay,
  parseAiFileDetail,
  parseRecoveryIndex,
  planRecovery,
  readRecoveryIndex,
  removeRecoveryEntry,
  sanitizeCitations,
  serializeRecoveryIndex,
  shouldPoll,
  tickAiPolling,
  webStatusLabel,
  type AiCallState,
  type AiRecoveryEntry,
  type AiUsageView,
  type StorageLike,
} from './aiRequestState.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`失败：${label}`)
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  check(actualText === expectedText, `${label}：期望 ${expectedText}，实际 ${actualText}`)
}

const SOURCE = { type: 'journal' as const, id: 12 }

function usage(overrides: Partial<AiUsageView> = {}): AiUsageView {
  return {
    prompt_tokens: 90, completion_tokens: 18, total_tokens: 108,
    unknown_subcalls: 0, search_requests: 0, ...overrides,
  }
}

function appliedResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: '33333333-3333-4333-8333-333333333333',
    kind: 'local',
    status: 'applied',
    sources: [SOURCE],
    reply: '是哪件事最耗你呀？',
    file: { id: 12, revision: 6 },
    review: null,
    saved_target: null,
    usage: usage(),
    web_status: 'not_needed',
    citations: [],
    error: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. 请求 ID 与问题栏
// ---------------------------------------------------------------------------

check(normalizeQuestion('') === null, '空问题归一化为 null')
check(normalizeQuestion('   \n\t ') === null, '纯空白问题归一化为 null')
check(normalizeQuestion('  我为什么老想着这件事？  ') === '我为什么老想着这件事？', '问题去除首尾空白')
check(normalizeQuestion('a'.repeat(2001)) === null, '超过 2000 码点的问题不接受')
check(normalizeQuestion('a'.repeat(2000)) === 'a'.repeat(2000), '2000 码点问题边界通过')

// ---------------------------------------------------------------------------
// 2. 状态机：初始 / 开始 / 应用 / noop
// ---------------------------------------------------------------------------

const IDLE = initialAiCallState()
expectEqual(IDLE.phase, 'idle', '初始状态 idle')
check(canStartAiCall(IDLE), 'idle 可以开始调用')
check(!aiCallLocksFile(IDLE), 'idle 不锁文件')

const REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const SENDING = beginAiCall(IDLE, { requestId: REQUEST_ID, source: SOURCE })
expectEqual(SENDING.phase, 'sending', '开始调用进入 sending')
check(aiCallLocksFile(SENDING), 'sending 锁定文件')
check(!canStartAiCall(SENDING), 'sending 不能再开始第二个调用（双击只产生一个请求）')

const APPLIED = applyAiResponse(SENDING, appliedResponse())
expectEqual(APPLIED.phase, 'applied', 'applied 状态')
expectEqual(APPLIED.reply, '是哪件事最耗你呀？', '保留回复文本')
expectEqual(APPLIED.usage, usage(), '保留本次 usage')
expectEqual(APPLIED.webStatus, 'not_needed', 'web_status 原样保留')
check(APPLIED.mayHaveCharged, 'applied 表示已消耗计量')
check(!aiCallLocksFile(APPLIED), 'applied 解锁文件')
check(canStartAiCall(APPLIED), 'applied 后可以再次显式调用')

const NOOP = applyAiResponse(SENDING, {
  status: 'noop', message: NOOP_MESSAGE, request_id: null, usage: null,
})
expectEqual(NOOP.phase, 'noop', 'noop 状态')
expectEqual(NOOP.message, NOOP_MESSAGE, 'noop 文案必须是「要我分析啥啊？」')
check(NOOP.requestId === null, 'noop 不带 request_id（不登记恢复索引）')
check(NOOP.usage === null, 'noop 没有 usage')
check(!NOOP.mayHaveCharged, 'noop 零模型调用、零消耗')
check(NOOP.citations.length === 0, 'noop 不产生引用')

// ---------------------------------------------------------------------------
// 3. failed / conflict / unknown 不假装成功
// ---------------------------------------------------------------------------

const FAILED = applyAiResponse(SENDING, appliedResponse({
  status: 'failed', reply: null, usage: usage({ total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, unknown_subcalls: 1 }),
  error: { category: 'timeout', message: '上游超时，可能已消耗 Token。' },
}))
expectEqual(FAILED.phase, 'failed', 'failed 状态')
check(FAILED.reply === null, 'failed 不带回复，不假装成功')
check(FAILED.mayHaveCharged, 'failed 且有未知子调用 → 可能已消耗')

const CONFLICT = applyAiResponse(SENDING, appliedResponse({
  status: 'conflict', reply: null, error: { category: 'source_changed', message: '源文件已修改或删除，结果未附着。' },
}))
expectEqual(CONFLICT.phase, 'conflict', 'conflict 状态')
check(CONFLICT.reply === null, 'conflict 不假装成功')

const UNKNOWN = applyAiResponse(SENDING, appliedResponse({
  status: 'unknown', reply: null, error: null,
}))
expectEqual(UNKNOWN.phase, 'unknown', 'unknown 状态')
check(UNKNOWN.mayHaveCharged, 'unknown 一定标记可能已消耗 Token')
check(UNKNOWN.message.includes('可能已消耗'), 'unknown 明确提示可能已消耗 Token')

// ---------------------------------------------------------------------------
// 4. 传输层错误：503 不扣、502/504 需查询、网络断开不自动重发
// ---------------------------------------------------------------------------

const NOT_CONFIGURED = applyAiTransportError(SENDING, { status: 503, message: 'Model is not configured' })
expectEqual(NOT_CONFIGURED.phase, 'blocked', '503 → blocked（无 Key，未调用）')
check(!NOT_CONFIGURED.mayHaveCharged, '503 未调用模型，不显示已消耗')
check(NOT_CONFIGURED.message.includes('未调用'), '503 说明本次未调用模型')

const BUSY = applyAiTransportError(SENDING, { status: 429, message: 'Too many simultaneous AI calls' })
expectEqual(BUSY.phase, 'blocked', '429 → blocked（进程并发上限）')
check(!BUSY.mayHaveCharged, '429 未调用模型')

const REVISION_CONFLICT = applyAiTransportError(SENDING, { status: 409, message: 'file revision has changed' })
expectEqual(REVISION_CONFLICT.phase, 'conflict', '409 → conflict（注册阶段拒绝）')
check(!REVISION_CONFLICT.mayHaveCharged, '409 发生在模型调用前，不显示已消耗')

const TIMEOUT = applyAiTransportError(SENDING, {
  status: 504, message: 'Model request failed; query request_id for status', requestId: REQUEST_ID,
})
expectEqual(TIMEOUT.phase, 'polling', '504 带 request_id → 转入查询而非直接失败')
check(TIMEOUT.mayHaveCharged, '504 可能已计费')
check(TIMEOUT.requestId === REQUEST_ID, '504 保留原 request_id（不换新 UUID）')

const OFFLINE = applyAiTransportError(SENDING, { status: null, message: 'Failed to fetch', requestId: REQUEST_ID })
expectEqual(OFFLINE.phase, 'unknown', '网络断开 → unknown（不假装成功）')
check(OFFLINE.requestId === REQUEST_ID, '网络断开保留原 request_id')
check(canStartAiCall(OFFLINE), 'unknown 可由用户显式发起新调用（原 request_id 不自动重发）')
check(OFFLINE.message.includes('手动'), 'unknown 说明只能手动重新发起')

// ---------------------------------------------------------------------------
// 5. 轮询策略：页面隐藏 / 卸载 / 上限
// ---------------------------------------------------------------------------

const POLLING: AiCallState = { ...TIMEOUT }
check(shouldPoll(POLLING, { visible: true, mounted: true }), '可见且有在途 → 继续轮询')
check(!shouldPoll(POLLING, { visible: false, mounted: true }), '页面隐藏 → 停止轮询')
check(!shouldPoll(POLLING, { visible: true, mounted: false }), '卸载 → 停止轮询')
check(!shouldPoll(APPLIED, { visible: true, mounted: true }), '非 polling 状态不轮询')

let exhausted = POLLING
for (let index = 0; index < POLL_MAX_ATTEMPTS; index += 1) exhausted = tickAiPolling(exhausted)
check(!shouldPoll(exhausted, { visible: true, mounted: true }), '达到有限轮询上限后停止')
const EXPIRED = expirePolling(exhausted)
expectEqual(EXPIRED.phase, 'unknown', '轮询超时 → unknown')
check(EXPIRED.mayHaveCharged, '轮询超时标记可能已消耗')
expectEqual(POLL_INTERVAL_MS, 2000, '轮询间隔 2 秒')
expectEqual(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS, 90_000, '轮询窗口覆盖 90 秒处理中锁')
check(EXPIRED.message.includes('不代表服务器已取消或未计费'), '超时明确客户端超时不等于服务器未计费')

// 回归：一次查询返回 pending 之后必须继续轮询。
// 只排一次定时器就停，会让「有限轮询」退化成「只查询一次」，页面永久停在等待结果。
expectEqual(nextPollDelay({ status: 'pending' }), POLL_INTERVAL_MS, 'pending → 继续下一次有限轮询')
expectEqual(nextPollDelay({ status: 'applied' }), null, 'applied → 停止轮询')
expectEqual(nextPollDelay({ status: 'ready' }), null, 'ready → 停止轮询')
expectEqual(nextPollDelay({ status: 'failed' }), null, 'failed → 停止轮询')
expectEqual(nextPollDelay({ status: 'conflict' }), null, 'conflict → 停止轮询')
expectEqual(nextPollDelay({ status: 'unknown' }), null, 'unknown → 停止轮询')
expectEqual(nextPollDelay({ status: null }), null, '没有状态 → 停止轮询，不当作 pending')
expectEqual(nextPollDelay({}), null, '缺少 status → 停止轮询')
expectEqual(nextPollDelay('missing'), null, '404 → 停止轮询')

// ---------------------------------------------------------------------------
// 6. 查询结果：applied 采用后端文件 / 404 移除入口
// ---------------------------------------------------------------------------

const QUERIED = applyAiQuery(POLLING, appliedResponse() as never)
expectEqual(QUERIED.phase, 'applied', '查询到 applied')
expectEqual(QUERIED.requestId, REQUEST_ID, '查询保留 request_id')

const MISSING = applyAiQuery(POLLING, 'missing')
expectEqual(MISSING.phase, 'failed', '404 → failed（入口失效）')
check(MISSING.requestId === null, '404 移除失效入口，不保留可重发的 ID')
check(MISSING.message.includes('不会自动重建'), '404 说明不自动 POST 重建')
check(!MISSING.mayHaveCharged, '404 表示未登记，不计费')

// ---------------------------------------------------------------------------
// 7. usage 文案：unknown 不显示 0、搜索次数单列
// ---------------------------------------------------------------------------

check(formatCallUsage(null).includes('未知'), 'null usage 显示未知而非 0')
const knownOnly = formatCallUsage(usage())
check(knownOnly.includes('已确认 Token 108'), '已确认 Token 显示合计')
check(!knownOnly.includes('搜索'), '没有搜索时不显示搜索')
const withUnknown = formatCallUsage(usage({ unknown_subcalls: 2 }))
check(withUnknown.includes('未知子调用 2 次'), '未知子调用单独显示')
check(withUnknown.includes('已确认 Token 108'), '未知不影响已确认合计')
const onlyUnknown = formatCallUsage(usage({ total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, unknown_subcalls: 1 }))
check(onlyUnknown.includes('未知子调用 1 次'), '仅未知计量时显示未知次数')
check(onlyUnknown.includes('不能当作未消耗'), '仅未知计量时不显示成 0 Token')
const withSearch = formatCallUsage(usage({ search_requests: 2 }))
check(withSearch.includes('搜索请求 2 次'), '搜索次数单列显示')
check(!withSearch.includes('已确认 Token 108 次'), '搜索不计入模型 Token')

// ---------------------------------------------------------------------------
// 8. 引用安全：只接受纯 HTTP(S)
// ---------------------------------------------------------------------------

check(isSafeHttpUrl('https://example.com/a?b=1'), 'https 允许')
check(isSafeHttpUrl('http://example.com'), 'http 允许')
check(!isSafeHttpUrl('javascript:alert(1)'), 'javascript: 拒绝')
check(!isSafeHttpUrl('data:text/html,<b>x</b>'), 'data: 拒绝')
check(!isSafeHttpUrl('file:///C:/windows'), 'file: 拒绝')
check(!isSafeHttpUrl('//example.com'), '协议相对 URL 拒绝')
check(!isSafeHttpUrl(''), '空 URL 拒绝')

const citations = sanitizeCitations([
  { title: '正常来源', url: 'https://example.com/ok' },
  { title: '危险来源', url: 'javascript:alert(1)' },
  { title: '脚本标题<script>', url: 'http://example.com/safe' },
  { title: 123, url: 'https://example.com/bad-title' },
  'not-an-object',
  { url: 'https://example.com/no-title' },
])
expectEqual(citations.length, 2, '只保留 title/url 合法的两条引用')
expectEqual(citations[0].url, 'https://example.com/ok', '保留合法 URL')
expectEqual(citations[1].title, '脚本标题<script>', '标题作为纯文本保留，不做 HTML 解析')
check(typeof citations[1].title === 'string', '标题始终是字符串')

// ---------------------------------------------------------------------------
// 9. web_status 文案
// ---------------------------------------------------------------------------

const statuses = ['disabled', 'not_configured', 'not_needed', 'searched', 'failed', 'blocked'] as const
for (const status of statuses) {
  const shaped = webStatusLabel(status)
  check(shaped.label.length > 0, `web_status ${status} 有中文标签`)
  check(shaped.hint.length > 0, `web_status ${status} 有说明`)
}
check(webStatusLabel('searched').label.includes('已联网'), 'searched 显示为已联网')
check(webStatusLabel('disabled').label.includes('关闭'), 'disabled 显示为关闭')
check(webStatusLabel('not_configured').label.includes('配置'), 'not_configured 显示为缺配置')
check(webStatusLabel('failed').label.includes('失败'), 'failed 显示为失败')
check(webStatusLabel('blocked').label.includes('拦截'), 'blocked 显示为拦截')

// ---------------------------------------------------------------------------
// 10. 错误分类文案
// ---------------------------------------------------------------------------

check(describeErrorCategory('source_changed').includes('源'), 'source_changed 有中文说明')
check(describeErrorCategory('expired').includes('可能已消耗'), 'expired 提示可能已消耗')
check(describeErrorCategory(null).length > 0, '空分类有兜底说明')

// ---------------------------------------------------------------------------
// 11. 恢复索引：只存 request_id / kind / typed 身份
// ---------------------------------------------------------------------------

const ENTRY: AiRecoveryEntry = { requestId: REQUEST_ID, kind: 'local', source: SOURCE }
const serialized = serializeRecoveryIndex([ENTRY])
const parsedBack = parseRecoveryIndex(serialized)
expectEqual(parsedBack, [ENTRY], '恢复索引可往返')
const keys = Object.keys(JSON.parse(serialized).entries[0])
expectEqual(keys.sort(), ['kind', 'requestId', 'source'], '恢复索引条目只有三个字段')
check(!serialized.includes('"question"'), '恢复索引不包含问题字段')
check(!serialized.includes('"content"'), '恢复索引不包含正文字段')
check(!serialized.includes('"prompt"'), '恢复索引不包含提示词字段')
check(!serialized.includes('sk-'), '恢复索引不包含任何密钥形态')

// 发送前登记身份：写进 storage 的只有身份三元组。
const writeStorage = memoryStorage()
writeStorage.setItem(RECOVERY_STORAGE_KEY, serializeRecoveryIndex([ENTRY]))
const persisted = parseRecoveryIndex(writeStorage.getItem(RECOVERY_STORAGE_KEY))
expectEqual(persisted, [ENTRY], '登记后可从 storage 读回身份')

const polluted = JSON.stringify({
  version: 1,
  entries: [
    { requestId: REQUEST_ID, kind: 'local', source: SOURCE, question: '私密问题', content: '日记正文', prompt: 'p', apiKey: 'sk-x' },
    { requestId: 'not-a-uuid', kind: 'local', source: SOURCE },
    { requestId: '44444444-4444-4444-8444-444444444444', kind: 'review', source: { type: 'inbox', id: 9 } },
    { requestId: '55555555-5555-4555-8555-555555555555', kind: 'local', source: { type: 'insight', id: 3 } },
  ],
})
const sanitized = parseRecoveryIndex(polluted)
expectEqual(sanitized.length, 2, '丢弃非法 UUID 与非法来源类型')
expectEqual(sanitized[0], ENTRY, '丢弃多余字段，只保留三个身份字段')
expectEqual(Object.keys(sanitized[0]).sort(), ['kind', 'requestId', 'source'], '解析后仍只有三个字段')
expectEqual(parseRecoveryIndex('not json'), [], '损坏的索引解析为空数组而不抛错')
expectEqual(parseRecoveryIndex(null), [], '缺失的索引解析为空数组')

let entries = addRecoveryEntry([], ENTRY)
expectEqual(entries.length, 1, '新增恢复条目')
entries = addRecoveryEntry(entries, { ...ENTRY, kind: 'local' })
expectEqual(entries.length, 1, '同 request_id 重复登记不产生第二条')
entries = addRecoveryEntry(entries, { requestId: '44444444-4444-4444-8444-444444444444', kind: 'local', source: SOURCE })
expectEqual(entries.length, 1, '同一源只保留最近一次入口（新请求替换旧入口）')
expectEqual(findRecoveryEntry(entries, SOURCE)?.requestId, '44444444-4444-4444-8444-444444444444', '取该源最近一条入口')
expectEqual(findRecoveryEntry(entries, { type: 'inbox', id: 1 }), null, '其它源没有入口')
entries = removeRecoveryEntry(entries, '44444444-4444-4444-8444-444444444444')
expectEqual(entries.length, 0, '移除入口')

// StorageLike 最小实现（不依赖浏览器）
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] },
  }
}
const storage = memoryStorage()
expectEqual(readRecoveryIndex(storage), [], '空 storage 读到空索引')
const storage2 = memoryStorage({ [RECOVERY_STORAGE_KEY]: serialized })
expectEqual(readRecoveryIndex(storage2), [ENTRY], '按固定键读取')
const broken = memoryStorage({ [RECOVERY_STORAGE_KEY]: '{{{' })
expectEqual(readRecoveryIndex(broken), [], '损坏内容不抛错')

// ---------------------------------------------------------------------------
// 12. 重开恢复计划
// ---------------------------------------------------------------------------

expectEqual(planRecovery(ENTRY, 'missing'), { action: 'drop' }, '404 → 移除失效入口')
expectEqual(planRecovery(ENTRY, appliedResponse() as never), { action: 'show' }, 'applied → 显示已有结果')
expectEqual(planRecovery(ENTRY, { status: 'pending' } as never), { action: 'poll' }, 'pending → 继续查询')
expectEqual(planRecovery(ENTRY, { status: 'failed' } as never), { action: 'show' }, 'failed → 显示失败结果')
expectEqual(planRecovery(ENTRY, { status: 'unknown' } as never), { action: 'show' }, 'unknown → 显示且不重发')

// ---------------------------------------------------------------------------
// 13. 后端完整文件解析：AI 块由后端附着，前端只读取
// ---------------------------------------------------------------------------

const rawFile = {
  id: 12, revision: 6, title: null, display_title: '2026-10-11',
  content: '今天挺累的。\n\n> AI 回复\n> 是哪件事最耗你呀？\n\n',
  content_blocks: [
    { id: '11111111-1111-4111-8111-111111111111', kind: 'user', text: '今天挺累的。' },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'ai_reply', text: '是哪件事最耗你呀？', request_id: REQUEST_ID },
    { id: '44444444-4444-4444-8444-444444444444', kind: 'user', text: '' },
  ],
  folder_id: null, journal_date: '2026-10-11', created_at: '2026-10-11T00:00:00Z',
  updated_at: '2026-10-11T00:00:01Z', deleted_at: null,
}
const detailFile = parseAiFileDetail(rawFile)
check(detailFile !== null, '合法详情可解析')
expectEqual(detailFile?.id, 12, '解析 id')
expectEqual(detailFile?.revision, 6, '解析 revision')
expectEqual(detailFile?.date, '2026-10-11', '解析业务日期')
expectEqual(detailFile?.dateField, 'journal_date', '记录日期字段名')
expectEqual(detailFile?.content_blocks?.length, 3, '保留后端附着的完整块数组（前端不自行插入）')
expectEqual(detailFile?.content_blocks?.[2].text, '', '续写段由后端给出，前端不伪造')
check(parseAiFileDetail(null) === null, 'null 详情解析失败')
check(parseAiFileDetail({ id: 1 }) === null, '缺 revision 的详情解析失败')
check(parseAiFileDetail({ ...rawFile, id: 'x' }) === null, 'id 类型不对解析失败')
check(parseAiFileDetail({ ...rawFile, content_blocks: 'nope' }) === null, 'content_blocks 类型不对解析失败')

const inboxRaw: Record<string, unknown> = { ...rawFile, id: 9, inbox_date: '2026-10-11', is_daily: true }
delete inboxRaw.journal_date
const inboxFile = parseAiFileDetail(inboxRaw)
expectEqual(inboxFile?.dateField, 'inbox_date', 'Inbox 使用 inbox_date')
expectEqual(inboxFile?.isDaily, true, '保留 is_daily')

// ---------------------------------------------------------------------------

// eslint-disable-next-line no-console
console.log(`aiRequestState.test.ts: ${passed} 项断言全部通过`)
