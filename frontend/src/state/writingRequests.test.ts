/**
 * 写作 AI 请求登记与恢复的纯逻辑测试（Stage 4 / S04-T09）。
 *
 *   node --experimental-strip-types src/state/writingRequests.test.ts
 *
 * 只验证：索引只存身份、同文件同类只留最近一条、状态映射不把未知当成功、
 * 恢复决策绝不重新 POST、可能计费的口径。
 */

import {
  WRITING_RECOVERY_KEY,
  addWritingEntry,
  decideRecovery,
  findWritingEntry,
  mayHaveCharged,
  mergeWritingDetail,
  needsChargeWarning,
  parseWritingIndex,
  phaseForWritingStatus,
  readWritingIndex,
  removeWritingEntry,
  serializeWritingIndex,
  writeWritingIndex,
  type StorageLike,
  type WritingRecoveryEntry,
  type WritingRequestRecord,
} from './writingRequests.ts'

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

const REQ_A = '11111111-1111-4111-8111-111111111111'
const REQ_B = '22222222-2222-4222-8222-222222222222'

function memoryStorage(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null },
    setItem(key, value) { data[key] = value },
    removeItem(key) { delete data[key] },
  }
}

function record(overrides: Partial<WritingRequestRecord> = {}): WritingRequestRecord {
  return {
    requestId: REQ_A,
    kind: 'go_deeper',
    fileId: 12,
    phase: 'running',
    message: '',
    mayHaveCharged: false,
    startedAt: 0,
    updatedAt: 0,
    applied: false,
    ...overrides,
  }
}

/* --------------------------------------------- 1. 索引只存身份，不存正文 */

{
  const storage = memoryStorage()
  const entries: WritingRecoveryEntry[] = [{ requestId: REQ_A, kind: 'go_deeper', fileId: 12 }]
  writeWritingIndex(storage, entries)
  const raw = storage.data[WRITING_RECOVERY_KEY]
  check(raw !== undefined && !raw.includes('正文'), '索引里没有正文')
  expectEqual(Object.keys(JSON.parse(raw) as Record<string, unknown>), ['version', 'entries'], '索引只有 version/entries')
  expectEqual(Object.keys((JSON.parse(raw) as { entries: Record<string, unknown>[] }).entries[0]),
    ['requestId', 'kind', 'fileId'], '每条只有 requestId/kind/fileId')
  expectEqual(readWritingIndex(storage), entries, '读写往返一致')

  // 非法条目（坏 UUID、未知 kind、越界 fileId）一律丢弃。
  const dirty = JSON.stringify({
    version: 1,
    entries: [
      { requestId: 'not-a-uuid', kind: 'go_deeper', fileId: 12 },
      { requestId: REQ_A, kind: 'local', fileId: 12 },
      { requestId: REQ_B, kind: 'minds_comments', fileId: 0 },
      { requestId: REQ_B, kind: 'minds_comments', fileId: 12, text: '偷偷夹带正文' },
    ],
  })
  expectEqual(parseWritingIndex(dirty), [{ requestId: REQ_B, kind: 'minds_comments', fileId: 12 }],
    '非法条目被丢弃，多余字段不保留')
  expectEqual(parseWritingIndex('{坏 JSON'), [], '坏 JSON 返回空')
  expectEqual(parseWritingIndex(null), [], 'null 返回空')
  expectEqual(serializeWritingIndex([]).includes('entries'), true, '序列化始终带 entries')
}

/* ------------------------------------- 2. 同文件同类只保留最近一条 */

{
  let entries: WritingRecoveryEntry[] = []
  entries = addWritingEntry(entries, { requestId: REQ_A, kind: 'go_deeper', fileId: 12 })
  entries = addWritingEntry(entries, { requestId: REQ_B, kind: 'go_deeper', fileId: 12 })
  expectEqual(entries.length, 1, '同文件同 kind 只保留最近一条')
  expectEqual(entries[0].requestId, REQ_B, '保留的是最新那条')
  entries = addWritingEntry(entries, { requestId: REQ_A, kind: 'minds_comments', fileId: 12 })
  expectEqual(entries.length, 2, '不同 kind 各自一条（两种模式互不覆盖）')
  expectEqual(findWritingEntry(entries, 12, 'go_deeper')?.requestId, REQ_B, '按文件+kind 查找')
  expectEqual(findWritingEntry(entries, 99), null, '找不到时返回 null')
  expectEqual(removeWritingEntry(entries, REQ_B).length, 1, '移除指定条目')
}

/* ------------------------------------------- 3. 状态映射：未知不当成功 */

{
  expectEqual(phaseForWritingStatus('prepared'), 'running', 'prepared 仍是进行中（未调用模型）')
  expectEqual(phaseForWritingStatus('pending'), 'running', 'pending 进行中')
  expectEqual(phaseForWritingStatus('ready'), 'ready', 'ready 待写入')
  expectEqual(phaseForWritingStatus('applied'), 'applied', 'applied 已写入')
  expectEqual(phaseForWritingStatus('weird'), 'unknown', '未知状态按 unknown')
  expectEqual(phaseForWritingStatus(undefined), 'unknown', '缺状态按 unknown')

  const merged = mergeWritingDetail(record(), { request_id: REQ_A, status: 'ready', usage: null }, 5)
  expectEqual(merged.phase, 'ready', 'ready 合并')
  expectEqual(merged.applied, false, 'ready 尚未写入正文')
  check(merged.message.includes('等待写入正文'), 'ready 的文案说明需要写入')

  const prepared = mergeWritingDetail(record(), { status: 'prepared' }, 6)
  expectEqual(prepared.phase, 'running', 'prepare 只登记，不算 ready')
  check(prepared.message.includes('正在处理'), 'prepared 给出「处理中」说明而不是成功')
  expectEqual(prepared.applied, false, 'prepared 绝不当作已写入')

  const failed = mergeWritingDetail(record(), {
    status: 'failed',
    error: { category: 'timeout', message: '上游超时' },
  }, 7)
  expectEqual(failed.phase, 'failed', 'failed 合并')
  expectEqual(failed.message, '上游超时', '使用后端的分类文案')
}

/* ------------------------------------------------- 4. 计费口径 */

{
  expectEqual(mayHaveCharged('noop', null), false, 'noop 一定没计费')
  expectEqual(mayHaveCharged('running', null), false, 'prepare 阶段没有 usage，不声称已计费')
  expectEqual(mayHaveCharged('ready', { total_tokens: 0, unknown_subcalls: 0 }), true, 'ready 已调用模型')
  expectEqual(mayHaveCharged('failed', { total_tokens: 120 }), true, 'failed 但有已知 Token')
  expectEqual(mayHaveCharged('failed', { total_tokens: 0, unknown_subcalls: 2 }), true, '未知子调用也算可能计费')
  expectEqual(mayHaveCharged('failed', { total_tokens: 0, unknown_subcalls: 0 }), false, '明确零调用')
  expectEqual(mayHaveCharged('unknown', null), true, 'unknown 一律按可能已计费')
  expectEqual(needsChargeWarning(record({ phase: 'unknown', mayHaveCharged: true })), true, 'unknown 需要提醒')
  expectEqual(needsChargeWarning(record({ phase: 'applied', mayHaveCharged: true })), false, '已写入不必再提醒')
}

/* --------------------------------- 5. 恢复决策：任何分支都不重新 POST */

{
  const entry: WritingRecoveryEntry = { requestId: REQ_A, kind: 'go_deeper', fileId: 12 }
  expectEqual(decideRecovery(entry, 'missing').action, 'drop', '404 移除入口且不重建')
  expectEqual(decideRecovery(entry, { status: 'pending' }).action, 'poll', 'pending 只查询')
  expectEqual(decideRecovery(entry, { status: 'prepared' }).action, 'show',
    'prepared 只显示「可继续同一 ID」，不自动执行')
  check(decideRecovery(entry, { status: 'prepared' }).message.includes('同一个 request_id'),
    'prepared 的说明给出同一 ID')
  expectEqual(decideRecovery(entry, { status: 'ready' }).action, 'apply', 'ready 可以应用')
  expectEqual(decideRecovery(entry, { status: 'applied' }).action, 'show', 'applied 只显示')
  expectEqual(decideRecovery(entry, { status: 'conflict' }).action, 'readonly', 'conflict 只读，不再附着')
  expectEqual(decideRecovery(entry, { status: 'unknown' }).action, 'show', 'unknown 显示并等用户决定')
  expectEqual(decideRecovery(entry, { status: 'failed' }).action, 'show', 'failed 显示，不自动重试')

  // 所有决策都不含「重发」动作。
  const actions = ['missing', { status: 'pending' }, { status: 'prepared' }, { status: 'ready' },
    { status: 'applied' }, { status: 'failed' }, { status: 'conflict' }, { status: 'unknown' }]
    .map((detail) => decideRecovery(entry, detail as never).action)
  check(!actions.includes('resend' as never), '不存在自动重发动作')
}

console.log(`writingRequests: ${passed} 项通过`)
