/**
 * 本地 Journal 草稿的纯逻辑测试（Stage 4 / S04-T02）。
 *
 *   node --experimental-strip-types src/state/localJournalDrafts.test.ts
 *
 * 只测不依赖浏览器 API 的部分：记录校验、写入合并、失败保留、多标签隔离、
 * 恢复决策与清理边界。真实 IndexedDB 的行为（配额/事务/浏览器重开）必须在
 * 浏览器里另外验证，不能由这里替代。
 */

import {
  DRAFT_SCHEMA_VERSION,
  canClearAfterAck,
  createLocalDraftWriter,
  decideDraftRecovery,
  draftRecordKey,
  resolveTabId,
  shouldAcceptWrite,
  sortCandidates,
  validateDraftRecord,
  type DraftBackend,
  type LocalJournalDraft,
  type TabStorageLike,
} from './localJournalDrafts.ts'

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

/* --------------------------------------------------------------- 测试替身 */

function draftOf(overrides: Partial<LocalJournalDraft> = {}): LocalJournalDraft {
  return {
    schema: DRAFT_SCHEMA_VERSION,
    draft_id: 'draft-1',
    tab_id: 'tab-1',
    file_id: null,
    base_revision: null,
    journal_kind: 'writing',
    business_date: '2026-10-30',
    draft_started_at: '2026-10-30T09:00:00+08:00',
    title: '合成标题',
    content_doc: { type: 'doc', content: [] },
    folder_id: null,
    input_seq: 1,
    write_seq: 1,
    first_request: null,
    updated_at: '2026-10-30T09:00:01+08:00',
    ...overrides,
  }
}

/** 内存后端，可注入指定 name 的失败（配额/权限/版本）。 */
function fakeBackend(failWith: string | null = null): DraftBackend & { data: Map<string, LocalJournalDraft> } {
  const data = new Map<string, LocalJournalDraft>()
  function maybeFail(): void {
    if (failWith === null) return
    throw Object.assign(new Error(`模拟失败：${failWith}`), { name: failWith })
  }
  return {
    data,
    async get(key) { maybeFail(); return data.get(key) ?? null },
    async put(key, record) { maybeFail(); data.set(key, record) },
    async list() { maybeFail(); return Array.from(data.values()) },
    async remove(key) { maybeFail(); data.delete(key) },
    async clear() { maybeFail(); data.clear() },
  }
}

/* --------------------------------------------------------- 1. 记录校验 */

{
  const valid = validateDraftRecord(draftOf())
  check(valid !== null, '合法记录通过校验')
  expectEqual(valid?.draft_id, 'draft-1', '保留草稿身份')

  expectEqual(validateDraftRecord(null), null, 'null 不是记录')
  expectEqual(validateDraftRecord('x'), null, '字符串不是记录')
  expectEqual(validateDraftRecord({ ...draftOf(), schema: 2 }), null, 'schema 版本不兼容时拒绝，不静默迁移')
  expectEqual(validateDraftRecord({ ...draftOf(), draft_id: '' }), null, '空草稿 id 拒绝')
  expectEqual(validateDraftRecord({ ...draftOf(), journal_kind: 'daily' }), null, '未知类型拒绝')
  expectEqual(validateDraftRecord({ ...draftOf(), input_seq: -1 }), null, '负序号拒绝')
  expectEqual(validateDraftRecord({ ...draftOf(), file_id: 0 }), null, '非法文件 id 拒绝')
  expectEqual(validateDraftRecord({ ...draftOf(), first_request: { client_create_id: '', payload: {} } }), null, '空创建键拒绝')

  const rawExtra = { ...draftOf(), api_key: 'sk-should-not-be-kept', prompt: '私密提示词' }
  const cleaned = validateDraftRecord(rawExtra)
  check(cleaned !== null && !('api_key' in cleaned) && !('prompt' in cleaned), '多余字段（Key/提示词）不进入记录')
}

/* ------------------------------------------------- 2. 单调写入与失败保留 */

async function testWriter(): Promise<void> {
  const backend = fakeBackend()
  const writer = createLocalDraftWriter(backend)
  const first = draftOf({ write_seq: 3, input_seq: 3, title: '第三次' })
  expectEqual(await writer.save(first), { ok: true, skipped: false }, '首次写入成功')

  // 迟到的旧写入（更小写序号）不能覆盖更新的记录。
  const older = draftOf({ write_seq: 1, input_seq: 1, title: '第一次' })
  expectEqual(await writer.save(older), { ok: true, skipped: true }, '更旧序号被跳过')
  expectEqual(writer.memory()[0].title, '第三次', '内存里保留最新内容')
  expectEqual(backend.data.get(draftRecordKey('tab-1', 'draft-1'))?.title, '第三次', '存储里保留最新内容')

  // 非法记录：不写盘，内存内容不动。
  const invalid = { ...draftOf({ write_seq: 9 }), journal_kind: 'unknown' } as unknown as LocalJournalDraft
  const rejected = await writer.save(invalid)
  check(rejected.ok === false && rejected.error === 'corrupt', '非法记录报 corrupt')

  expectEqual(shouldAcceptWrite(null, older), true, '没有旧记录时接受')
  expectEqual(shouldAcceptWrite(first, first), false, '同序号不接受（幂等重写不重复落盘）')
}

async function testStorageFailures(): Promise<void> {
  // 配额满：内存保留，磁盘失败单独告警。
  const quota = fakeBackend('QuotaExceededError')
  const writer = createLocalDraftWriter(quota)
  const result = await writer.save(draftOf())
  check(result.ok === false && result.error === 'quota', '配额满报 quota')
  expectEqual(writer.memory().length, 1, '配额满时内存内容仍在')
  expectEqual(writer.memory()[0].title, '合成标题', '内存内容可读')

  // 权限受限 / 隐私模式。
  const denied = createLocalDraftWriter(fakeBackend('NotAllowedError'))
  const blocked = await denied.save(draftOf())
  check(blocked.ok === false && blocked.error === 'unavailable', '权限受限报 unavailable')

  // 版本不兼容的库。
  const versioned = createLocalDraftWriter(fakeBackend('VersionError'))
  const incompatible = await versioned.save(draftOf())
  check(incompatible.ok === false && incompatible.error === 'version_incompatible', '库版本不兼容报 version_incompatible')

  // 完全没有 IndexedDB：内存仍然可用，但如实报告没落盘。
  const memoryOnly = createLocalDraftWriter(null)
  const degraded = await memoryOnly.save(draftOf())
  check(degraded.ok === false && degraded.error === 'unavailable', '无存储时报 unavailable')
  expectEqual(memoryOnly.memory().length, 1, '无存储时内存仍保留输入')

  // 读取失败不抛给页面。
  const brokenRead = createLocalDraftWriter(fakeBackend('InvalidStateError'))
  const listed = await brokenRead.list()
  check(listed.ok === false && listed.error === 'unavailable', '读取失败返回错误而不是抛出')

  // 损坏记录（字段不合法）在 list 时被丢弃，不产生半条草稿。
  const mixed = fakeBackend()
  mixed.data.set('bad', { ...draftOf(), schema: 99 } as unknown as LocalJournalDraft)
  mixed.data.set('good', draftOf())
  const listedMixed = await createLocalDraftWriter(mixed).list()
  check(listedMixed.ok === true && listedMixed.records.length === 1, '损坏记录被丢弃，合法记录保留')
}

/* -------------------------------------------------------- 3. 多标签隔离 */

async function testTabIsolation(): Promise<void> {
  const backend = fakeBackend()
  const writer = createLocalDraftWriter(backend)
  const tabA = draftOf({ tab_id: 'tab-a', title: 'A 标签' })
  const tabB = draftOf({ tab_id: 'tab-b', title: 'B 标签' })
  await writer.save(tabA)
  await writer.save(tabB)
  expectEqual(backend.data.size, 2, '同一草稿在两个标签各存一条')
  expectEqual(sortCandidates(writer.memory()).length, 2, '两个标签都是候选')

  await writer.remove('tab-a', 'draft-1')
  expectEqual(backend.data.size, 1, '删除只影响本标签记录')
  expectEqual(writer.memory()[0].tab_id, 'tab-b', '另一个标签的草稿保留')

  // 用户明确清空：只清本应用命名空间。
  await writer.clearAll()
  expectEqual(backend.data.size, 0, '清空后没有本应用记录')
  expectEqual(writer.memory().length, 0, '内存副本同步清空')
}

/* -------------------------------------------------------- 4. 恢复决策 */

{
  const unsent = draftOf({ file_id: null, first_request: null })
  expectEqual(decideDraftRecovery(unsent, { state: 'missing' }).kind, 'new_draft', '未发送过的新草稿按新草稿继续')

  const lostResponse = draftOf({
    file_id: null,
    first_request: { client_create_id: 'key-1', payload: { title: 'x' } },
  })
  expectEqual(decideDraftRecovery(lostResponse, { state: 'missing' }).kind, 'replay_create', '创建响应丢失时先同键重放')

  const sameRevision = draftOf({ file_id: 7, base_revision: 4 })
  expectEqual(
    decideDraftRecovery(sameRevision, { state: 'ok', revision: 4, softDeleted: false }),
    { kind: 'restore_editable', revision: 4 },
    '版本一致允许恢复编辑',
  )

  const changed = decideDraftRecovery(sameRevision, { state: 'ok', revision: 6, softDeleted: false })
  expectEqual(changed, { kind: 'conflict', local_revision: 4, server_revision: 6 }, '版本变化进入冲突')

  expectEqual(decideDraftRecovery(sameRevision, { state: 'ok', revision: 4, softDeleted: true }).kind, 'server_missing', '服务器软删时不自动写入')
  expectEqual(decideDraftRecovery(sameRevision, { state: 'missing' }).kind, 'server_missing', '404 时保留草稿不新建')
  const offline = decideDraftRecovery(sameRevision, { state: 'unreadable', message: '网络中断' })
  expectEqual(offline, { kind: 'server_unreadable', message: '网络中断' }, '网络失败保留双方内容')

  expectEqual(canClearAfterAck(draftOf({ input_seq: 3 }), 3), true, '确认序号覆盖最新输入时可清理')
  expectEqual(canClearAfterAck(draftOf({ input_seq: 4 }), 3), false, '还有更新输入时不得清理记录')
}

/* -------------------------------------------------------- 5. 候选与标签 id */

{
  const older = draftOf({ draft_id: 'd1', updated_at: '2026-10-30T09:00:00+08:00' })
  const newer = draftOf({ draft_id: 'd2', updated_at: '2026-10-30T10:00:00+08:00', first_request: { client_create_id: 'key', payload: {} } })
  const candidates = sortCandidates([older, newer])
  expectEqual(candidates[0].draft_id, 'd2', '最近改动的候选排在前')
  expectEqual(candidates[0].has_first_request, true, '候选标出是否有首次请求待重放')
  check(!('content_doc' in candidates[0]), '候选信息不含正文')

  const data: Record<string, string> = {}
  const storage: TabStorageLike = {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
  }
  expectEqual(resolveTabId(storage, 'fallback-1'), 'fallback-1', '首次解析写入本标签 id')
  expectEqual(resolveTabId(storage, 'fallback-2'), 'fallback-1', '同一标签复用已写入的 id')
  const throwing: TabStorageLike = {
    getItem() { throw new Error('禁用') },
    setItem() { throw new Error('禁用') },
  }
  expectEqual(resolveTabId(throwing, 'fallback-3'), 'fallback-3', '存储不可用时退化为内存 id')
  expectEqual(resolveTabId(null, 'fallback-4'), 'fallback-4', '无存储时退化为内存 id')
}

await testWriter()
await testStorageFailures()
await testTabIsolation()

console.log(`localJournalDrafts: ${passed} 项通过`)
