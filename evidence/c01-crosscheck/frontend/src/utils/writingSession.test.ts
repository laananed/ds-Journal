/**
 * Writing 页面纯逻辑测试（Stage 4 / S04-T06）。
 *
 *   node --experimental-strip-types src/utils/writingSession.test.ts
 *
 * 不引入测试框架，也不连网络/数据库：保存队列用 T02 的
 * `createEditSessionStore` + 本地假传输层，验证的是「页面接线之后」的行为，
 * 不是重新测一遍 T02 的算法。
 *
 * 覆盖 `docs/stage4-tasks.md` §3.7 的可离线部分：
 * 空草稿零创建、创建键与新建语义、切页续写、草稿恢复与冲突保留双方、
 * 列表筛选/预览/分页、旧格式判定、今日总览不生成文件。
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
import type { DraftCandidate } from '../state/localJournalDrafts.ts'
import type { Journal, JournalPage } from '../types/journal.ts'
import {
  buildTodayOverview,
  candidateMeta,
  candidateOriginLabel,
  conflictHeadings,
  duplicateOfServer,
  formatBusinessDateLabel,
  formatLocalStamp,
  hasUnsavedInput,
  idsWithLocalDrafts,
  isBusinessDate,
  isLegacyRecord,
  localDraftText,
  needsLocalDraft,
  newWritingDraft,
  planReplay,
  pickResumableDraftId,
  planCandidate,
  planLabel,
  rebuildFirstRequest,
  userTextOf,
  writingDateFromBusinessDay,
  writingDraftIdForFile,
  writingListItems,
  writingPreview,
  writingSessionId,
  writingSavable,
  writingTooLong,
} from './writingSession.ts'

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

type Call = { kind: 'create' | 'update'; request: CreateRequest | UpdateRequest }

function recordingTransport(options: { failFirstCreate?: boolean } = {}): {
  transport: SaveTransport
  calls: Call[]
  nextId: () => number
} {
  const calls: Call[] = []
  let id = 10
  let failed = false
  const transport: SaveTransport = {
    async create(request: CreateRequest): Promise<ServerFile> {
      calls.push({ kind: 'create', request })
      if (options.failFirstCreate === true && !failed) {
        failed = true
        throw Object.assign(new Error('网络中断'), { status: 0 })
      }
      id += 1
      return { id, revision: 1, draft: request.draft }
    },
    async update(request: UpdateRequest): Promise<ServerFile> {
      calls.push({ kind: 'update', request })
      return { id: request.file_id, revision: request.expected_revision + 1, draft: request.draft }
    },
  }
  return { transport, calls, nextId: () => id }
}

function doc(text: string): DocumentDraft['content_doc'] {
  return text === ''
    ? { type: 'doc', content: [{ type: 'paragraph' }] }
    : { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
}

function draft(over: Partial<DocumentDraft> = {}): DocumentDraft {
  return { title: '', content_doc: doc(''), date: '2026-10-30', folder_id: null, ...over }
}

function journal(over: Partial<Journal> = {}): Journal {
  return {
    type: 'journal',
    id: 7,
    title: null,
    display_title: '10月30日 日记 2',
    content: '今天的正文',
    revision: 3,
    folder_id: null,
    created_at: '2026-10-30T01:00:00.000000Z',
    updated_at: '2026-10-30T02:00:00.000000Z',
    deleted_at: null,
    journal_date: '2026-10-30',
    journal_kind: 'writing',
    content_doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    document_schema_version: 1,
    document_format: 'tiptap',
    ...over,
  }
}

function page(items: Journal[], over: Partial<JournalPage> = {}): JournalPage {
  return { items, page: 1, page_size: 20, total: items.length, has_next: false, ...over }
}

function record(over: Partial<LocalJournalDraft> = {}): LocalJournalDraft {
  return {
    schema: 1,
    draft_id: 'draft-a',
    tab_id: 'tab-a',
    file_id: null,
    base_revision: null,
    journal_kind: 'writing',
    business_date: '2026-10-30',
    draft_started_at: '2026-10-30T01:00:00.000Z',
    title: '',
    content_doc: doc('本地写了一半'),
    folder_id: null,
    input_seq: 3,
    write_seq: 3,
    first_request: null,
    updated_at: '2026-10-30T01:01:00.000Z',
    ...over,
  }
}

function candidate(over: Partial<DraftCandidate> = {}): DraftCandidate {
  return {
    key: 'tab-a:draft-a',
    draft_id: 'draft-a',
    tab_id: 'tab-a',
    file_id: null,
    business_date: '2026-10-30',
    journal_kind: 'writing',
    title: '',
    updated_at: '2026-10-30T01:01:00.000Z',
    input_seq: 3,
    has_first_request: false,
    ...over,
  }
}

/* ------------------------------------------------------------ 1. 业务日期 */

{
  check(isBusinessDate('2026-10-30'), '合法业务日期通过')
  check(!isBusinessDate('2026-02-30'), '不存在的日期被拒绝')
  check(!isBusinessDate('2026-1-3'), '非补零格式被拒绝')
  check(!isBusinessDate(20261030), '数字类型被拒绝')
  expectEqual(formatBusinessDateLabel('2026-10-30'), '2026年10月30日 周五', '业务日期带星期显示')
  expectEqual(formatBusinessDateLabel('坏日期'), '坏日期', '非法日期原样返回不崩溃')

  expectEqual(writingDateFromBusinessDay({ business_date: '2026-10-30' }), '2026-10-30', '业务日期只取服务端值')
  expectEqual(writingDateFromBusinessDay(null), '', '服务端未读取时不猜测日期')
  expectEqual(writingDateFromBusinessDay({ business_date: '乱码' }), '', '非法业务日期不猜测')
  expectEqual(newWritingDraft('2026-10-30').date, '2026-10-30', '新草稿日期来自业务日期')
  expectEqual(newWritingDraft('2026-10-30').content_doc, null, '新草稿没有正文')
}

/* --------------------------------------------------------- 2. 空草稿零创建 */

{
  const empty = newWritingDraft('2026-10-30')
  check(!writingSavable(empty), '空草稿不可提交')
  check(!writingSavable({ ...empty, title: '只有标题' }), '只有标题也不创建记录')
  check(!writingSavable({ ...empty, content_doc: doc('   ') }), '全空白正文不可提交')
  check(writingSavable({ ...empty, content_doc: doc('一句话') }), '有用户正文才可提交')
  check(!writingTooLong({ ...empty, content_doc: doc('a'.repeat(50_000)) }), '恰好 50,000 码点不算超长')
  check(writingTooLong({ ...empty, content_doc: doc('a'.repeat(50_001)) }), '超出 50,000 码点判为超长')
  expectEqual(userTextOf(null), '', '没有文档时用户正文为空')
  expectEqual(userTextOf({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '甲' }] }] }), '甲', '用户正文取自投影')
  expectEqual(
    userTextOf({ type: 'doc', content: [{ type: 'aiReply', attrs: { id: 'x', request_id: 'y' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'AI 说的' }] }] }] }),
    '',
    'AI 内容不算用户正文',
  )
}

/* ------------------------------------------- 3. 打开空页零 POST（真实队列） */

const store = createEditSessionStore()

{
  const { transport, calls } = recordingTransport()
  const draftId = 'draft-empty'
  const sessionId = writingSessionId(draftId)
  const session = store.openSession({
    sessionId, type: 'journal', tabId: 'tab-a', draftId,
    draft: newWritingDraft('2026-10-30'), transport, isSavable: writingSavable,
  })
  expectEqual(session.status, 'saved', '空草稿初始状态是已保存（没有待提交内容）')
  const flushed = await store.saveToSequence(sessionId)
  expectEqual(flushed, { kind: 'clean' }, '打开空页再保存是一次空操作')
  expectEqual(calls.length, 0, '打开空页零 HTTP 写入')

  // 只有标题：仍然不创建记录。
  store.changeSession(sessionId, { ...newWritingDraft('2026-10-30'), title: '标题' }, 'user_input')
  expectEqual(await store.saveToSequence(sessionId), { kind: 'blocked', reason: 'invalid' }, '只有标题时保存被拒绝')
  expectEqual(calls.length, 0, '只有标题零 POST')
}

/* ------------------------------------------------------- 4. 创建键与新建 */

{
  const { transport, calls } = recordingTransport()
  const firstId = 'draft-one'
  const first = store.openSession({
    sessionId: writingSessionId(firstId), type: 'journal', tabId: 'tab-a', draftId: firstId,
    draft: newWritingDraft('2026-10-30'), transport, isSavable: writingSavable,
  })
  store.changeSession(first.sessionId, { ...newWritingDraft('2026-10-30'), content_doc: doc('第一篇') }, 'user_input')
  await store.saveToSequence(first.sessionId)
  expectEqual(calls.length, 1, '有正文后发出一次创建')
  const createRequest = calls[0].request as CreateRequest
  expectEqual(createRequest.client_create_id, first.createKey, '创建请求使用会话的稳定创建键')
  expectEqual(createRequest.draft.date, '2026-10-30', '创建请求带上业务日期')

  const afterCreate = store.getSession(first.sessionId)
  check(afterCreate !== null && afterCreate.fileId !== null, '创建成功后取得服务器 id')

  // 应用内返回：同一会话 id 取回原会话，不换键、不重建草稿。
  const reopened = store.openSession({
    sessionId: writingSessionId(firstId), type: 'journal', tabId: 'tab-a', draftId: firstId,
    draft: newWritingDraft('2026-10-30'), transport, isSavable: writingSavable,
  })
  expectEqual(reopened.createKey, first.createKey, '返回同一草稿时创建键不变')
  expectEqual(userTextOf(reopened.draft.content_doc), '第一篇', '返回同一草稿时输入还在')
  expectEqual(reopened.fileId, afterCreate?.fileId, '返回同一草稿时服务器身份不变')

  // 明确新建：另一份草稿身份 → 另一个创建键。
  const secondId = 'draft-two'
  const second = store.openSession({
    sessionId: writingSessionId(secondId), type: 'journal', tabId: 'tab-a', draftId: secondId,
    draft: newWritingDraft('2026-10-30'), transport, isSavable: writingSavable,
  })
  check(second.createKey !== first.createKey, '明确新建才产生新的创建键')
  expectEqual(userTextOf(second.draft.content_doc), '', '新建的草稿是空的')
  expectEqual(calls.length, 1, '新建空草稿本身不触发写入')
}

/* ------------------------------------------------ 5. 切页续写（返回同会话） */

{
  const resumable = pickResumableDraftId(
    [
      { draftId: 'a', tabId: 'tab-a', type: 'journal', fileId: null, date: '2026-10-29', hasUnsavedInput: false, updatedAt: 5 },
      { draftId: 'b', tabId: 'tab-a', type: 'journal', fileId: 12, date: '2026-10-29', hasUnsavedInput: true, updatedAt: 9 },
      { draftId: 'c', tabId: 'tab-b', type: 'journal', fileId: 13, date: '2026-10-30', hasUnsavedInput: true, updatedAt: 99 },
    ],
    'tab-a',
    '2026-10-30',
  )
  expectEqual(resumable, 'b', '优先恢复本标签最近有未提交输入的会话')

  expectEqual(
    pickResumableDraftId(
      [{ draftId: 'late', tabId: 'tab-a', type: 'journal', fileId: null, date: '2026-10-30', hasUnsavedInput: false, updatedAt: 1 }],
      'tab-a', '2026-10-30',
    ),
    'late',
    '未落库的空白草稿在返回时仍复用同一身份',
  )
  expectEqual(
    pickResumableDraftId(
      [{ draftId: 'old', tabId: 'tab-a', type: 'journal', fileId: 3, date: '2026-10-01', hasUnsavedInput: false, updatedAt: 2 }],
      'tab-a', '2026-10-30',
    ),
    null,
    '已保存且属于别的业务日期时不顶到面前',
  )
  expectEqual(
    pickResumableDraftId(
      [{ draftId: 'today', tabId: 'tab-a', type: 'journal', fileId: 4, date: '2026-10-30', hasUnsavedInput: false, updatedAt: 2 }],
      'tab-a', '2026-10-30',
    ),
    'today',
    '今天已保存的写作继续编辑',
  )
  expectEqual(
    pickResumableDraftId(
      [{ draftId: 'insight', tabId: 'tab-a', type: 'insight', fileId: 5, date: '', hasUnsavedInput: true, updatedAt: 9 }],
      'tab-a', '2026-10-30',
    ),
    null,
    'Insight 会话不会被 Writing 复活',
  )

  check(hasUnsavedInput({ draft: draft({ title: 'a' }), baseline: draft() }), '有差异即未提交')
  check(!hasUnsavedInput({ draft: draft(), baseline: draft() }), '内容相同视为已提交')
  expectEqual(writingSessionId(writingDraftIdForFile(12)), 'writing:draft:journal:12', '文件会话 id 稳定')
}

/* --------------------------------- 6. 创建丢响应：保留草稿、同键重试、再保存 */

{
  const { transport, calls } = recordingTransport({ failFirstCreate: true })
  const draftId = 'draft-lost'
  const sessionId = writingSessionId(draftId)
  store.openSession({
    sessionId, type: 'journal', tabId: 'tab-a', draftId,
    draft: newWritingDraft('2026-10-30'), transport, isSavable: writingSavable,
  })
  store.changeSession(sessionId, { ...newWritingDraft('2026-10-30'), content_doc: doc('第一段') }, 'user_input')
  expectEqual(await store.saveToSequence(sessionId), { kind: 'blocked', reason: 'failed' }, '创建失败后进入失败状态')

  const failed = store.getSession(sessionId)
  expectEqual(userTextOf(failed?.draft.content_doc ?? null), '第一段', '失败后草稿完整保留')
  expectEqual(failed?.fileId, null, '失败后不会伪造服务器身份')

  // 失败期间继续输入：内容保留，但不自动重试。
  store.changeSession(sessionId, { ...newWritingDraft('2026-10-30'), content_doc: doc('第一段，又写了一句') }, 'user_input')
  expectEqual(calls.length, 1, '失败状态下的继续输入不隐式重发')

  await store.retry(sessionId)
  // 重试 = 原键 + 原首次 payload 重放（取回 id），再对更晚输入发 PATCH。
  expectEqual(calls.length, 3, '重试先重放创建，再提交更晚输入')
  expectEqual(
    (calls[0].request as CreateRequest).client_create_id,
    (calls[1].request as CreateRequest).client_create_id,
    '重试沿用同一创建键（不换键，避免重复创建）',
  )
  expectEqual(
    (calls[1].request as CreateRequest).draft.content_doc,
    (calls[0].request as CreateRequest).draft.content_doc,
    '重放使用冻结的首次 payload，而不是把新输入塞进创建请求',
  )
  expectEqual(calls[2].kind, 'update', '取得 id 之后改为 PATCH')
  expectEqual(
    (calls[2].request as UpdateRequest).patch.content_doc,
    doc('第一段，又写了一句'),
    'PATCH 提交冻结快照之后的新输入',
  )
  const recovered = store.getSession(sessionId)
  check(recovered !== null && recovered.fileId !== null, '重试成功后取得服务器 id')
  expectEqual(recovered?.status, 'saved', '重放 + 补交之后状态回到已保存')
  expectEqual(userTextOf(recovered?.draft.content_doc ?? null), '第一段，又写了一句', '重试后保留最新输入')

  // 拿到 id 之后的修改继续走 PATCH + CAS。
  const revisionBefore = recovered?.revision ?? 0
  store.changeSession(sessionId, { ...newWritingDraft('2026-10-30'), content_doc: doc('第一段，又写了一句，第三句') }, 'user_input')
  await store.saveToSequence(sessionId)
  expectEqual(calls.at(-1)?.kind, 'update', '取得 id 之后始终是 PATCH')
  const update = calls.at(-1)?.request as UpdateRequest
  expectEqual(update.expected_revision, revisionBefore, 'PATCH 携带服务器最新的版本')
  expectEqual(update.patch.content_doc, doc('第一段，又写了一句，第三句'), 'PATCH 只提交变化的正文')
}

/* ------------------------------------------------------ 7. 草稿恢复与冲突 */

{
  expectEqual(planCandidate(record(), null).kind, 'fresh', '没有文件 id 也没发出创建 → 新草稿')
  expectEqual(
    planCandidate(record({ first_request: { client_create_id: 'key-1', payload: {} } }), null).kind,
    'replay_pending',
    '创建未确认时不换键重发',
  )
  expectEqual(
    planCandidate(record({ file_id: 9, base_revision: 4 }), { state: 'ok', revision: 4, softDeleted: false }).kind,
    'editable',
    '同版本可恢复编辑',
  )
  const conflict = planCandidate(record({ file_id: 9, base_revision: 4 }), { state: 'ok', revision: 6, softDeleted: false })
  expectEqual(conflict, { kind: 'conflict', localRevision: 4, serverRevision: 6 }, '版本不同进入冲突并给出双方版本')
  expectEqual(
    planCandidate(record({ file_id: 9, base_revision: 4 }), { state: 'ok', revision: 6, softDeleted: true }).kind,
    'server_missing',
    '服务器已软删时不自动新建',
  )
  expectEqual(
    planCandidate(record({ file_id: 9, base_revision: 4 }), { state: 'missing' }).kind,
    'server_missing',
    '404 时保留本地草稿',
  )
  expectEqual(
    planCandidate(record({ file_id: 9, base_revision: 4 }), { state: 'unreadable', message: '网络中断' }).kind,
    'server_unreadable',
    '读取失败时不猜版本',
  )
  expectEqual(planCandidate(record({ file_id: 9, base_revision: 4 }), null).kind, 'server_unreadable', '尚未探测时不视为可编辑')

  expectEqual(localDraftText(record()), '本地写了一半', '冲突对照取本地用户正文')
  expectEqual(
    conflictHeadings(4, 6),
    { local: '我的本地草稿（基于版本 4）', server: '服务器当前版本（版本 6）' },
    '冲突两侧标题带版本',
  )
  check(planLabel({ kind: 'conflict', localRevision: 1, serverRevision: 2 }).includes('选择'), '冲突文案要求用户选择')
  expectEqual(candidateOriginLabel(candidate(), 'tab-a'), '本标签 · 写作', '本标签候选标注来源')
  expectEqual(candidateOriginLabel(candidate({ tab_id: 'tab-b' }), 'tab-a'), '其他标签 · 写作', '其他标签候选单独标注')
  check(candidateMeta(candidate()).includes('未落库草稿'), '候选副标题说明是否已落库')
  check(candidateMeta(candidate({ file_id: 12 })).includes('#12'), '候选副标题给出服务器文件身份')
  expectEqual(formatLocalStamp('坏值'), '坏值', '时间戳非法时原样返回')
}

/* ------------------------------------------------ 8. 今日列表与预览裁剪 */

{
  const list = writingListItems(
    page([
      journal({ id: 1, display_title: '今天第一篇' }),
      journal({ id: 2, journal_kind: 'set', display_title: '开始今天 2026-10-30' }),
      journal({ id: 3, journal_date: '2026-10-29', display_title: '昨天的' }),
      journal({ id: 4, display_title: '一个非常非常长的标题'.repeat(8) }),
    ], { total: 41, has_next: true }),
    '2026-10-30',
  )
  expectEqual(list.items.map((item) => item.id), [1, 4], '侧栏只保留当日 writing')
  expectEqual(list.hasNext, true, '分页状态透传（20+1 场景）')
  expectEqual(list.total, 41, '总数透传')
  check(list.items[1].displayTitle.length > 60, '长标题不截断')
  expectEqual(writingPreview('第一行\n\n第二行'), '第一行 第二行', '预览折叠空白')
  expectEqual(writingPreview('一二三四五', 3), '一二三…', '预览按码点截断')
  expectEqual(writingPreview('🙂🙂🙂🙂', 2), '🙂🙂…', '预览按码点而不是 UTF-16 截断')
  expectEqual(writingListItems(null, '2026-10-30'), { items: [], page: 1, total: 0, hasNext: false }, '列表读取失败时为空且不报错')

  expectEqual(
    Array.from(idsWithLocalDrafts([candidate({ file_id: 12 }), candidate({ file_id: null })])),
    [12],
    '只有服务器文件候选会给出列表标记',
  )
}

/* ---------------------------------------------------------- 9. 今日总览 */

{
  const overview = buildTodayOverview({
    businessDay: { timezone: 'Asia/Shanghai', day_start_hour: 4, business_date: '2026-10-30' },
    writings: page([journal({ id: 1, display_title: '今天第一篇' })], { total: 21, has_next: true }),
    rituals: {
      set: journal({ id: 2, journal_kind: 'set', display_title: '开始今天 2026-10-30' }),
      end: null,
    },
  })
  check(overview !== null, '业务日期可用时组装出总览')
  expectEqual(overview?.businessDate, '2026-10-30', '总览使用服务端业务日期')
  expectEqual(overview?.dayStartHour, 4, '总览显示换日时刻')
  expectEqual(overview?.writings.map((item) => item.id), [1], '总览写作列表只含 writing')
  expectEqual(overview?.rituals.set.state, 'exists', '开始今天有记录时给出继续入口数据')
  expectEqual(overview?.rituals.end.state, 'absent', '结束今天缺失时不伪造记录')
  expectEqual(overview?.writingsHasNext, true, '超过一页时如实标注')

  expectEqual(
    buildTodayOverview({ businessDay: null, writings: null, rituals: null }),
    null,
    '业务日期读取失败时不猜日期、不给空总览',
  )
  expectEqual(
    buildTodayOverview({
      businessDay: { business_date: '2026-10-30' },
      writings: page([]),
      rituals: null,
    })?.timezone,
    'Asia/Shanghai',
    '缺字段时回落到固定时区口径',
  )
}

/* ------------------------------------------------------- 10. 旧格式判定 */

{
  check(isLegacyRecord(journal({ content_doc: null })), '没有 content_doc 的记录走旧格式路径')
  check(isLegacyRecord(journal({ document_format: 'legacy' })), '标记 legacy 的记录走旧格式路径')
  check(
    isLegacyRecord(journal({ content_blocks: [{ id: 'b1', kind: 'user', text: '旧正文' }] })),
    '带旧 blocks 的记录不强制转换',
  )
  check(!isLegacyRecord(journal()), '已转换的新格式记录可以直接编辑')
}

/* ------------------------------------ 11. 已确认的草稿不再产生本机记录 */

{
  check(needsLocalDraft({ inputSeq: 2, ackedSeq: 1 }), '服务器未确认的输入需要本机草稿')
  check(needsLocalDraft({ inputSeq: 1, ackedSeq: 0 }), '还没落库的输入需要本机草稿')
  check(!needsLocalDraft({ inputSeq: 3, ackedSeq: 3 }), '已确认保存的草稿不再写本机记录')
  check(!needsLocalDraft({ inputSeq: 0, ackedSeq: 0 }), '空草稿永远不写本机记录')

  const server = journal({ revision: 4, title: null, content: '本地写了一半' })
  check(duplicateOfServer(record({ base_revision: 4 }), server), '内容与服务器一致的本机记录不构成冲突')
  check(
    duplicateOfServer(record({ content_doc: doc('本地写了一半 ') }), journal({ content: '本地写了一半' })),
    '空白差异不算内容不同',
  )
  check(
    !duplicateOfServer(record({ content_doc: doc('本地又补了一句') }), server),
    '正文不同时必须让用户选择，不能当成重复记录',
  )
  check(
    !duplicateOfServer(record({ title: '只在本机的标题' }), server),
    '标题不同也算未提交内容',
  )
  check(
    duplicateOfServer(record({ title: '标题' }), journal({ title: '标题', content: '本地写了一半' })),
    '标题与正文都一致时判为重复记录',
  )
  check(
    !duplicateOfServer(record({ title: '标题' }), journal({ title: null, content: '本地写了一半' })),
    '服务器没有标题、本机有标题时不判为重复',
  )
}

/* ------------------------- 12. replay_pending 的重放参数重建 */

{
  check(rebuildFirstRequest(record({ first_request: null })) === null, '没有首次请求就没有重放参数')

  const stored = {
    client_create_id: 'ck-1',
    payload: {
      title: '周一晨记',
      content_doc: doc('凌晨四点前写的'),
      journal_date: '2026-10-29',
      folder_id: 7,
    },
  }
  const replay = rebuildFirstRequest(record({ first_request: stored, input_seq: 5 }))
  check(replay !== null, '有首次请求时重建出重放参数')
  expectEqual(replay?.client_create_id, 'ck-1', '重放使用原创建键，绝不换新键')
  expectEqual(
    replay?.draft,
    { title: '周一晨记', content_doc: doc('凌晨四点前写的'), date: '2026-10-29', folder_id: 7 },
    '重放 payload 严格还原为冻结的首次草稿',
  )
  expectEqual(replay?.extras, null, 'payload 只有草稿字段时 extras 为 null')
  expectEqual(replay?.seq, 5, '记录没有单独保存序号时回退到最新输入序号')

  const withSeq = rebuildFirstRequest(record({ first_request: { ...stored, seq: 2 }, input_seq: 5 }))
  expectEqual(withSeq?.seq, 2, '记录单独保存的首次请求序号优先于最新输入序号')
  check(
    rebuildFirstRequest(record({ first_request: { ...stored, seq: 0 }, input_seq: 5 })) === null,
    '首次请求序号为 0 时拒绝重建（不猜测）',
  )

  const withExtras = rebuildFirstRequest(record({
    first_request: {
      client_create_id: 'ck-2',
      payload: { title: '', content_doc: null, journal_date: '2026-10-30', folder_id: null, source: 'quick_capture' },
    },
  }))
  expectEqual(withExtras?.extras, { source: 'quick_capture' }, 'payload 的额外字段归入 extras')
  expectEqual(withExtras?.draft.folder_id, null, 'folder_id 为 null 时原样保留')
  expectEqual(withExtras?.draft.content_doc, null, 'content_doc 为 null 时原样保留（空正文是合法首次 payload）')

  check(
    rebuildFirstRequest(record({
      first_request: { client_create_id: 'ck-3', payload: { title: 1, content_doc: null, journal_date: '2026-10-30', folder_id: null } },
    })) === null,
    'payload 字段类型损坏时拒绝重建，不编造默认值',
  )
  check(
    rebuildFirstRequest(record({
      first_request: { client_create_id: 'ck-4', payload: { title: '只有标题' } },
    })) === null,
    'payload 缺少草稿字段时拒绝重建',
  )
  check(
    rebuildFirstRequest(record({
      first_request: { client_create_id: '', payload: { title: '', content_doc: null, journal_date: '2026-10-30', folder_id: null } },
    })) === null,
    '空创建键拒绝重建',
  )
}

/* ------------------- 13. planReplay：能不能按原请求重放 */

{
  const firstPayload = {
    client_create_id: 'ck-replay',
    payload: {
      title: '原请求标题',
      content_doc: doc('原请求正文'),
      journal_date: '2026-10-30',
      folder_id: null,
    },
  }

  const ready = planReplay(record({ first_request: firstPayload, input_seq: 4 }))
  check(ready.kind === 'ready', '完整的首次请求记录允许重放')
  if (ready.kind === 'ready') {
    expectEqual(ready.request.client_create_id, 'ck-replay', '重放沿用原创建键')
    expectEqual(ready.request.draft, {
      title: '原请求标题',
      content_doc: doc('原请求正文'),
      date: '2026-10-30',
      folder_id: null,
    }, '重放的首次 payload 逐字段等于记录里的快照')
    expectEqual(ready.latest, {
      title: '',
      content_doc: doc('本地写了一半'),
      date: '2026-10-30',
      folder_id: null,
    }, '重放计划里的 latest 是本机最新内容，不是首次 payload')
    check(ready.latest !== ready.request.draft, '较新输入不会被当成首次 payload')
    expectEqual(ready.latestSeq, 4, 'latestSeq 取记录输入序号（≥ 首次请求序号）')
  }

  const alreadyCreated = planReplay(record({ file_id: 12, base_revision: 2, first_request: firstPayload }))
  expectEqual(alreadyCreated.kind === 'unusable' ? alreadyCreated.reason : 'ready', 'already_created',
    '已有服务器文件身份时不能重放创建')

  const seqAhead = planReplay(record({ first_request: { ...firstPayload, seq: 9 }, input_seq: 4 }))
  expectEqual(seqAhead.kind === 'unusable' ? seqAhead.reason : 'ready', 'stale_seq',
    '首次请求序号超前于最新输入时拒绝重放（记录来自另一条时间线）')

  const noRequest = planReplay(record({ first_request: null }))
  expectEqual(noRequest.kind === 'unusable' ? noRequest.reason : 'ready', 'no_first_request',
    '没有首次请求时不重放')

  const corrupt = planReplay(record({
    first_request: { client_create_id: 'ck-x', payload: { title: '缺字段' } as unknown as Record<string, unknown> },
  }))
  expectEqual(corrupt.kind === 'unusable' ? corrupt.reason : 'ready', 'corrupt_payload',
    '首次 payload 损坏时拒绝重放，不猜默认值')

  const corruptKey = planReplay(record({
    first_request: { client_create_id: '  ', payload: firstPayload.payload },
  }))
  expectEqual(corruptKey.kind === 'unusable' ? corruptKey.reason : 'ready', 'corrupt_payload',
    '空白的创建键同样按损坏处理')

  const dateMismatch = planReplay(record({
    business_date: '2026-10-31',
    first_request: firstPayload,
  }))
  expectEqual(dateMismatch.kind === 'unusable' ? dateMismatch.reason : 'ready', 'date_mismatch',
    '记录业务日期与首次 payload 不一致时拒绝重放')

  const kindMismatch = planReplay(record({
    journal_kind: 'writing',
    first_request: {
      client_create_id: 'ck-kind',
      payload: { ...firstPayload.payload, journal_kind: 'end' },
    },
  }))
  expectEqual(kindMismatch.kind === 'unusable' ? kindMismatch.reason : 'ready', 'kind_mismatch',
    '记录类型与首次 payload 的 journal_kind 不一致时拒绝重放')

  const sameKind = planReplay(record({
    journal_kind: 'writing',
    first_request: {
      client_create_id: 'ck-kind-ok',
      payload: { ...firstPayload.payload, journal_kind: 'writing' },
    },
  }))
  check(sameKind.kind === 'ready', '类型一致时允许重放（extras 里的 journal_kind 不阻止重放）')

  const staleSeq = planReplay(record({ first_request: firstPayload, input_seq: 0 }))
  expectEqual(staleSeq.kind === 'unusable' ? staleSeq.reason : 'ready', 'stale_seq',
    '输入序号为 0 的记录不能重放（记录被截断）')

  const emptyPayload = planReplay(record({
    input_seq: 2,
    first_request: {
      client_create_id: 'ck-empty',
      payload: { title: '', content_doc: doc(''), journal_date: '2026-10-30', folder_id: null },
    },
  }))
  expectEqual(emptyPayload.kind === 'unusable' ? emptyPayload.reason : 'ready', 'not_savable',
    '首次 payload 是空白正文时拒绝重放（否则会创建空记录）')
}

console.log(`writingSession: ${passed} 项通过`)