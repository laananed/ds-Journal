/**
 * 「首次创建响应丢失」恢复流程测试（Stage 4 / S04-T06 + T02 交界）。
 *
 *   node --experimental-strip-types src/utils/pendingCreateReplay.test.ts
 *
 * 这一层测的不是页面，也不是重复测 T02 的序号算法，而是**恢复动作的契约**：
 *
 * 1. 首次 POST 必须用原 `client_create_id` 与**原首次 payload**（不能用较新输入）；
 * 2. 拿到 id/revision 后，较新输入必须作为**真实 PATCH** 发出，并且带 CAS 版本；
 * 3. 全程只有同一个会话、同一个传输层、同一个保存队列（不出现第二套队列/存储）；
 * 4. 记录损坏、身份不符、重复键、创建/更新失败时**拒绝并保留**，不静默改数据。
 *
 * 传输层是本地假实现：不连网络与数据库，因此可以断言请求的**逐字段内容**。
 */

import {
  createEditSessionStore,
  type CreateRequest,
  type DocumentDraft,
  type SaveTransport,
  type ServerFile,
  type UpdateRequest,
} from '../state/editSessions.ts'
import type { LocalJournalDraft } from '../state/localJournalDrafts.ts'
import { replayPendingCreate } from './pendingCreateReplay.ts'
import { writingSessionId, writingSavable } from './writingSession.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  passed += 1
  if (!condition) throw new Error(`失败：${label}`)
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  check(actualText === expectedText, `${label}（期望 ${expectedText}，实际 ${actualText}）`)
}

/* --------------------------------------------------------------- 测试替身 */

function doc(text: string): DocumentDraft['content_doc'] {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

const ORIGINAL: DocumentDraft = { title: '原请求标题', content_doc: doc('原请求正文'), date: '2026-10-30', folder_id: null }
const LATEST: DocumentDraft = { title: '原请求标题', content_doc: doc('原请求正文，后来又写了一句'), date: '2026-10-30', folder_id: null }

const CLIENT_KEY = '11111111-1111-4111-8111-111111111111'

function record(over: Partial<LocalJournalDraft> = {}): LocalJournalDraft {
  return {
    schema: 1,
    draft_id: 'draft-replay',
    tab_id: 'tab-a',
    file_id: null,
    base_revision: null,
    journal_kind: 'writing',
    business_date: '2026-10-30',
    draft_started_at: '2026-10-30T01:00:00.000Z',
    title: LATEST.title,
    content_doc: LATEST.content_doc,
    folder_id: null,
    input_seq: 4,
    write_seq: 4,
    first_request: {
      client_create_id: CLIENT_KEY,
      payload: {
        title: ORIGINAL.title,
        content_doc: ORIGINAL.content_doc,
        journal_date: ORIGINAL.date,
        folder_id: ORIGINAL.folder_id,
      },
      // 首次 POST 发出时的序号：镜像单独保存，不能拿最新 input_seq 冒充。
      seq: 1,
    },
    updated_at: '2026-10-30T01:05:00.000Z',
    ...over,
  }
}

type Call = { kind: 'create'; request: CreateRequest } | { kind: 'update'; request: UpdateRequest }

function fakeTransport(options: {
  createError?: unknown
  updateError?: unknown
  fileId?: number
} = {}): { transport: SaveTransport; calls: Call[] } {
  const calls: Call[] = []
  let revision = 0
  const transport: SaveTransport = {
    async create(request: CreateRequest): Promise<ServerFile> {
      calls.push({ kind: 'create', request })
      if (options.createError !== undefined) throw options.createError
      revision = 1
      return { id: options.fileId ?? 21, revision, draft: request.draft }
    },
    async update(request: UpdateRequest): Promise<ServerFile> {
      calls.push({ kind: 'update', request })
      if (options.updateError !== undefined) throw options.updateError
      revision = request.expected_revision + 1
      return { id: request.file_id, revision, draft: request.draft }
    },
  }
  return { transport, calls }
}

function run(
  rec: LocalJournalDraft,
  transport: SaveTransport,
  store = createEditSessionStore(),
) {
  return replayPendingCreate({
    record: rec,
    store,
    transport,
    tabId: rec.tab_id,
    isSavable: writingSavable,
  })
}

/* ------------------------------------------- 1. 响应丢失后的原键重放 */

async function testReplayUsesOriginalPayload(): Promise<void> {
  const { transport, calls } = fakeTransport({ fileId: 21 })
  const store = createEditSessionStore()
  const result = await run(record(), transport, store)

  check(result.kind === 'created', '重放成功后返回 created')
  expectEqual(result.fileId, 21, '结果带回服务器文件 id')
  check(result.patchApplied, '较新输入也已提交')
  expectEqual(calls.length, 2, '一次创建 + 一次更新，没有多余请求')

  const create = calls[0]
  check(create.kind === 'create', '第一个请求是创建')
  if (create.kind === 'create') {
    expectEqual(create.request.client_create_id, CLIENT_KEY, '创建沿用原 client_create_id')
    expectEqual(create.request.draft, ORIGINAL, '创建 body 是原首次 payload，不是较新输入')
    check(JSON.stringify(create.request.draft.content_doc) !== JSON.stringify(LATEST.content_doc),
      '较新输入没有被塞进首次 payload')
  }

  const update = calls[1]
  check(update.kind === 'update', '第二个请求是保存最新输入的 PATCH')
  if (update.kind === 'update') {
    expectEqual(update.request.expected_revision, 1, 'PATCH 使用创建返回的真实 revision（CAS）')
    expectEqual(update.request.draft, LATEST, 'PATCH 提交的是最新内容')
    expectEqual(update.request.patch.content_doc, LATEST.content_doc, 'PATCH 只包含真正变化的正文')
    expectEqual(update.request.patch.title, undefined, '未变化的标题不出现在 PATCH 里')
  }

  const session = store.getSession(result.sessionId)
  check(session !== null, '会话留在应用级会话表里')
  expectEqual(session?.sessionId, writingSessionId('draft-replay'), '会话身份就是那份草稿')
  expectEqual(session?.fileId, 21, '会话已拿到服务器身份')
  expectEqual(session?.createKey, CLIENT_KEY, '会话创建键始终是原键，没有换成新键')
  expectEqual(session?.status, 'saved', '最终状态是已保存')
  expectEqual(session?.draft, LATEST, '会话草稿保留最新输入')
}

/* --------------------------------- 2. 服务器幂等：同键重放不产生新记录 */

async function testServerIdempotentReplay(): Promise<void> {
  const { transport, calls } = fakeTransport({ fileId: 7 })
  const result = await run(record(), transport)
  expectEqual(result.fileId, 7, '幂等返回既有文件 id（同键同 payload）')
  const create = calls[0]
  check(create.kind === 'create' && create.request.client_create_id === CLIENT_KEY,
    '重放请求的键与 payload 与首次完全一致')
}

/* ------------------------------------------- 3. 没有较新输入时只创建 */

async function testNoNewerInput(): Promise<void> {
  const { transport, calls } = fakeTransport()
  const result = await run(record({ title: ORIGINAL.title, content_doc: ORIGINAL.content_doc, input_seq: 1 }), transport)
  expectEqual(calls.length, 1, '内容与首次 payload 相同时不发 PATCH')
  check(result.patchApplied, '没有差异视为已应用')
  expectEqual(result.revision, 1, '版本来自创建响应')
}

/* ------------------------------------------------ 4. 失败：创建不成功 */

async function testCreateFailure(): Promise<void> {
  const network = fakeTransport({ createError: Object.assign(new Error('网络中断'), { status: 0 }) })
  const first = await run(record(), network.transport)
  expectEqual(first.kind, 'refused', '创建失败时返回 refused')
  expectEqual(first.reason, 'create_failed', '失败原因分类为 create_failed')
  check(first.message.includes('保留'), '失败说明里明确本地草稿仍然保留')
  expectEqual(network.calls.length, 1, '失败后不再继续发 PATCH')

  const conflict = fakeTransport({ createError: Object.assign(new Error('创建键已被使用'), { status: 409 }) })
  const second = await run(record(), conflict.transport)
  expectEqual(second.reason, 'create_failed', '409 创建冲突同样归为 create_failed')
  const create = conflict.calls[0]
  check(create.kind === 'create' && create.request.client_create_id === CLIENT_KEY,
    '冲突场景下用的仍是原键（没有换键重试）')
}

/* ------------------------------------- 5. 创建成功但最新输入 PATCH 失败 */

async function testPatchFailure(): Promise<void> {
  const { transport } = fakeTransport({ updateError: Object.assign(new Error('版本已变化'), { status: 409 }) })
  const store = createEditSessionStore()
  const result = await run(record(), transport, store)
  expectEqual(result.kind, 'created', '创建已成功，因此仍是 created')
  expectEqual(result.patchApplied, false, '较新输入没有保存成功')
  expectEqual(result.reason, 'patch_failed', '失败原因标为 patch_failed')
  const session = store.getSession(result.sessionId)
  expectEqual(session?.status, 'conflict', '会话进入冲突状态，等用户对照，不静默覆盖')
  expectEqual(session?.draft, LATEST, '本地最新输入仍在会话里')
  expectEqual(session?.fileId, 21, '服务器身份保留')
}

/* --------------------------- 6. 空白占位会话被接管 / 有输入的会话被拒绝 */

async function testPlaceholderSessionAdopted(): Promise<void> {
  const store = createEditSessionStore()
  const { transport, calls } = fakeTransport()
  // 页面先开了空草稿（随机创建键），用户随后点「恢复原请求」。
  store.openSession({
    sessionId: writingSessionId('draft-replay'),
    type: 'journal',
    tabId: 'tab-a',
    draftId: 'draft-replay',
    draft: { title: '', content_doc: null, date: '2026-10-30', folder_id: null },
    transport,
  })
  const result = await run(record(), transport, store)
  expectEqual(result.kind, 'created', '空白占位会话可以直接接手记录')
  expectEqual(store.listSessions().length, 1, '没有产生第二个会话')
  expectEqual(calls.length, 2, '照常一次创建 + 一次 PATCH')
  const create = calls[0]
  check(create.kind === 'create' && create.request.client_create_id === CLIENT_KEY,
    '创建键换成记录里的原键，而不是占位会话的随机键')
  if (create.kind === 'create') {
    expectEqual(create.request.draft, ORIGINAL, '创建 body 仍是原首次 payload')
  }
  expectEqual(store.getSession(result.sessionId)?.draft, LATEST, '占位草稿被换成记录里的最新内容')
}

async function testSessionBusy(): Promise<void> {
  const store = createEditSessionStore()
  const { transport, calls } = fakeTransport()
  store.openSession({
    sessionId: writingSessionId('draft-replay'),
    type: 'journal',
    tabId: 'tab-a',
    draftId: 'draft-replay',
    draft: { title: '', content_doc: null, date: '2026-10-30', folder_id: null },
    transport,
  })
  // 用户已经在这份会话里写过东西：接管会覆盖现场内容。
  store.changeSession(
    writingSessionId('draft-replay'),
    { title: '现场标题', content_doc: doc('现场正文'), date: '2026-10-30', folder_id: null },
    'user_input',
  )
  const result = await run(record(), transport, store)
  expectEqual(result.kind, 'refused', '已有输入的会话不被接管')
  expectEqual(result.reason, 'session_busy', '拒绝原因标为 session_busy')
  expectEqual(calls.length, 0, '拒绝时不发任何请求')
  expectEqual(store.getSession(writingSessionId('draft-replay'))?.draft.content_doc, doc('现场正文'),
    '拒绝时不覆盖现场内容')
}

/* ------------------- 6b. 旧记录没有首次请求序号：回退但仍不提前清草稿 */

async function testLegacyRecordWithoutSeq(): Promise<void> {
  const legacy = record({
    input_seq: 4,
    first_request: {
      client_create_id: CLIENT_KEY,
      payload: {
        title: ORIGINAL.title,
        content_doc: ORIGINAL.content_doc,
        journal_date: ORIGINAL.date,
        folder_id: ORIGINAL.folder_id,
      },
    },
  })
  const { transport, calls } = fakeTransport()
  const store = createEditSessionStore()
  const result = await run(legacy, transport, store)
  expectEqual(result.kind, 'created', '旧记录仍然可以重放')
  expectEqual(calls.length, 2, '旧记录同样补写较新输入')
  const create = calls[0]
  check(create.kind === 'create', '第一个请求仍是创建')
  if (create.kind === 'create') {
    expectEqual(create.request.draft, ORIGINAL, '创建的仍是原首次 payload')
  }
  expectEqual(store.getSession(result.sessionId)?.status, 'saved', '补写完成后为已保存')
}

/* ------------------------- 6c. 首次请求序号超前：记录来自另一条时间线 */

async function testStaleFirstRequestSeq(): Promise<void> {
  const stale = record({
    input_seq: 2,
    first_request: {
      client_create_id: CLIENT_KEY,
      payload: {
        title: ORIGINAL.title,
        content_doc: ORIGINAL.content_doc,
        journal_date: ORIGINAL.date,
        folder_id: ORIGINAL.folder_id,
      },
      seq: 7,
    },
  })
  const { transport, calls } = fakeTransport()
  const result = await run(stale, transport)
  expectEqual(result.kind, 'refused', '首次请求序号超前时拒绝重放')
  expectEqual(result.reason, 'stale_seq', '拒绝原因标为 stale_seq')
  expectEqual(calls.length, 0, '拒绝时不发请求')
}

async function testDuplicateKey(): Promise<void> {
  const store = createEditSessionStore()
  const { transport, calls } = fakeTransport()
  store.openSession({
    sessionId: 'writing:draft:other',
    type: 'journal',
    tabId: 'tab-b',
    draftId: 'other',
    draft: { title: '', content_doc: null, date: '2026-10-30', folder_id: null },
    createKey: CLIENT_KEY,
    transport,
  })
  const result = await run(record(), transport, store)
  expectEqual(result.reason, 'duplicate_key', '同一创建键已被别的会话占用时拒绝重放')
  expectEqual(calls.length, 0, '拒绝时不重复发创建')
}

/* ------------------------------------------------ 8. 记录本身不可重放 */

async function testUnusableRecord(): Promise<void> {
  const broken = record({
    first_request: { client_create_id: CLIENT_KEY, payload: { title: '缺字段' } as unknown as Record<string, unknown> },
  })
  const { transport, calls } = fakeTransport()
  const result = await run(broken, transport)
  expectEqual(result.reason, 'corrupt_payload', '损坏的首次请求被拒绝（不猜默认值）')
  expectEqual(calls.length, 0, '拒绝时零请求')
  expectEqual(calls.length, 0, '损坏记录不会在服务器上创建任何东西')
}

/* ------------------------------------------------------------ 入口 */

await testReplayUsesOriginalPayload()
await testServerIdempotentReplay()
await testNoNewerInput()
await testCreateFailure()
await testPatchFailure()
await testPlaceholderSessionAdopted()
await testSessionBusy()
await testLegacyRecordWithoutSeq()
await testStaleFirstRequestSeq()
await testDuplicateKey()
await testUnusableRecord()

console.log(`pendingCreateReplay: ${passed} 项通过`)
