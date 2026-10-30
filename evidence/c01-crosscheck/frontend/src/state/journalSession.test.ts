/**
 * Journal 会话传输适配的纯逻辑测试（Stage 4 / S04-T02）。
 *
 *   node --experimental-strip-types src/state/journalSession.test.ts
 *
 * 只验证请求映射与旧格式写保护，不发真实 HTTP（真实链路需要独占测试库，
 * 由独立测试在获授权窗口执行）。
 */

import { journalToDraft, journalToServerFile, journalTransport } from './journalSession.ts'
import type { Journal, JournalCreate, JournalUpdate } from '../types/journal.ts'
import type { CreateRequest, DocumentDraft, UpdateRequest } from './editSessions.ts'

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

function journal(over: Partial<Journal> = {}): Journal {
  return {
    type: 'journal',
    id: 12,
    title: '标题',
    display_title: '标题',
    content: '阅读投影',
    revision: 4,
    folder_id: 2,
    created_at: '2026-10-30T09:00:00.000000Z',
    updated_at: '2026-10-30T09:00:00.000000Z',
    deleted_at: null,
    journal_date: '2026-10-30',
    content_doc: { type: 'doc', content: [] },
    document_schema_version: 1,
    document_format: 'tiptap',
    ...over,
  }
}

function draft(over: Partial<DocumentDraft> = {}): DocumentDraft {
  return { title: '', content_doc: { type: 'doc', content: [] }, date: '2026-10-30', folder_id: null, ...over }
}

/* ------------------------------------------------- 1. 详情 → 会话草稿 */

{
  expectEqual(journalToDraft(journal()), draft({ title: '标题', folder_id: 2 }), '详情映射为草稿')
  expectEqual(journalToDraft(journal({ title: null })).title, '', '空标题归一化为空串')
  const serverFile = journalToServerFile(journal())
  expectEqual({ id: serverFile.id, revision: serverFile.revision }, { id: 12, revision: 4 }, '保留身份与版本')
}

/* ------------------------------------------------- 2. 创建请求映射 */

async function testCreate(): Promise<void> {
  let captured: JournalCreate | null = null
  const transport = journalTransport({
    journalKind: 'writing',
    draftStartedAt: '2026-10-30T09:00:00+08:00',
    async create(payload) {
      captured = payload
      return journal({ id: 21, revision: 1, content_doc: payload.content_doc ?? null, title: payload.title ?? null })
    },
  })

  const request: CreateRequest = {
    client_create_id: 'create-key-1',
    draft: draft({ title: '新的一天', content_doc: { type: 'doc', content: [] } }),
    extras: null,
  }
  const file = await transport.create(request)
  const sent = captured as JournalCreate | null
  check(sent !== null, '创建请求已发出')
  expectEqual(sent?.client_create_id, 'create-key-1', '带稳定创建键')
  expectEqual(sent?.journal_kind, 'writing', '带 journal_kind')
  expectEqual(sent?.journal_date, '2026-10-30', '带业务日期')
  expectEqual(sent?.document_schema_version, 1, '带文档 schema 版本')
  expectEqual(sent?.draft_started_at, '2026-10-30T09:00:00+08:00', 'Ritual 带捕获时刻')
  expectEqual([file.id, file.revision], [21, 1], '响应折回身份与版本')
}

/* ------------------------------------------------- 3. PATCH 只发变化字段 */

async function testUpdate(): Promise<void> {
  let captured: { id: number; payload: JournalUpdate } | null = null
  const transport = journalTransport({
    journalKind: 'writing',
    async update(id, payload) {
      captured = { id, payload }
      return journal({ id, revision: payload.expected_revision + 1 })
    },
  })

  // 只改标题：补丁里不能出现正文，避免旧超长正文被重新校验。
  const titleOnly: UpdateRequest = {
    file_id: 12,
    expected_revision: 4,
    patch: { title: '改标题' },
    draft: draft({ title: '改标题' }),
  }
  await transport.update(titleOnly)
  const first = captured as { id: number; payload: JournalUpdate } | null
  expectEqual(first?.payload.expected_revision, 4, '带 CAS 版本')
  expectEqual(first?.payload.title, '改标题', '带变化字段')
  check(first !== null && !('content_doc' in first.payload), '未改正文时不发 content_doc')
  check(first !== null && !('journal_date' in first.payload), '未改日期时不发 journal_date')

  // 改正文：必须同时带 document_schema_version。
  const bodyEdit: UpdateRequest = {
    file_id: 12,
    expected_revision: 5,
    patch: { content_doc: { type: 'doc', content: [] } },
    draft: draft(),
  }
  await transport.update(bodyEdit)
  const second = captured as { id: number; payload: JournalUpdate } | null
  expectEqual(second?.payload.document_schema_version, 1, '正文写入带 schema 版本')
  check(second !== null && second.payload.content_doc !== undefined, '带新正文')
}

/* ------------------------------------------------- 4. 旧格式写保护 */

async function testLegacyGuard(): Promise<void> {
  const transport = journalTransport({
    journalKind: 'writing',
    async update() {
      throw Object.assign(new Error('legacy_conversion_required'), {
        status: 409,
        code: 'legacy_conversion_required',
      })
    },
  })
  let status: number | null = null
  let message = ''
  try {
    await transport.update({
      file_id: 3,
      expected_revision: 1,
      patch: { content_doc: { type: 'doc', content: [] } },
      draft: draft(),
    })
  } catch (error: unknown) {
    status = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status) : null
    message = error instanceof Error ? error.message : ''
  }
  expectEqual(status, 422, '旧格式写保护不伪装成版本冲突（改为 422 失败）')
  check(message.includes('旧格式'), '错误说明指出旧格式需要转换')

  // 真正的版本冲突仍按 409 透传，交给会话进入 conflict。
  const conflicting = journalTransport({
    journalKind: 'writing',
    async update() { throw Object.assign(new Error('revision_conflict'), { status: 409, code: 'revision_conflict' }) },
  })
  let conflictStatus: number | null = null
  try {
    await conflicting.update({ file_id: 3, expected_revision: 1, patch: {}, draft: draft() })
  } catch (error: unknown) {
    conflictStatus = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status: unknown }).status) : null
  }
  expectEqual(conflictStatus, 409, '版本冲突保持 409')
}

await testCreate()
await testUpdate()
await testLegacyGuard()

console.log(`journalSession: ${passed} 项通过`)
