/**
 * Journal 的会话传输适配（Stage 4 / S04-T02）。
 *
 * `state/editSessions.ts` 与具体 API 解耦；这一层负责把会话里的
 * `DocumentDraft` 映射成 `docs/stage4-api.md` §3 的创建 / PATCH 请求，
 * 并把响应折回 `ServerFile`。T06（Writing/日记）与 T11（Insight/Folder 等）
 * 直接用 `journalTransport` 绑定会话，不必各自重写「首次 payload / CAS」口径。
 *
 * 边界：
 * - **不做正文校验**（后端与 T01 的 `validate_document` 是唯一权威）；
 * - **不做 legacy 转换**：已有 `content_blocks` 的文件若要转换，必须先走
 *   明确的转换流程（API §2「T01 过渡选择」）。这里把
 *   `legacy_conversion_required` 明确报成不可重试的失败，而不是伪装成版本冲突，
 *   避免用户以为「换个版本再试就好」。
 */

import { createJournal, updateJournal } from '../api/journals.ts'
import type { Journal, JournalCreate, JournalUpdate } from '../types/journal.ts'
import type { JournalKind } from '../types/document.ts'
import type { DocumentDraft, SaveTransport, ServerFile } from './editSessions.ts'

/** 后端详情 → 会话草稿。 */
export function journalToDraft(journal: Journal): DocumentDraft {
  return {
    title: journal.title ?? '',
    content_doc: journal.content_doc ?? null,
    date: journal.journal_date,
    folder_id: journal.folder_id,
  }
}

/** 后端详情 → `ServerFile`（会话只关心身份、版本与权威草稿）。 */
export function journalToServerFile(journal: Journal): ServerFile {
  return { id: journal.id, revision: journal.revision, draft: journalToDraft(journal) }
}

function isLegacyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'legacy_conversion_required'
}

/**
 * 旧格式写保护：`content_doc` 写入带 blocks 的旧文件会返回 409
 * `legacy_conversion_required`（API §2）。这不是版本冲突，重试也不会成功，
 * 因此转成 422 让会话进入 `failed` 并保留草稿，用户处理转换后再继续。
 */
function translateLegacy(error: unknown): never {
  const message = error instanceof Error ? error.message : '该文件仍是旧格式，需要先转换正文'
  throw Object.assign(new Error(`该文件仍是旧格式，未写入新正文（需先转换）：${message}`), { status: 422 })
}

export interface JournalTransportOptions {
  /** 该会话对应的 Journal 类型；Ritual 的 set/end 也走同一入口。 */
  journalKind: JournalKind
  /** Ritual 草稿的捕获时刻（API §3：首次 payload 冻结，跨日不重算）。 */
  draftStartedAt?: string
  create?: (payload: JournalCreate) => Promise<Journal>
  update?: (id: number, payload: JournalUpdate) => Promise<Journal>
}

/** 会话传输层：创建请求冻结首次 payload，更新请求只提交变化字段 + CAS 版本。 */
export function journalTransport(options: JournalTransportOptions): SaveTransport {
  const createRequest = options.create ?? createJournal
  const updateRequest = options.update ?? updateJournal
  return {
    async create(request) {
      const payload: JournalCreate = {
        client_create_id: request.client_create_id,
        title: request.draft.title === '' ? null : request.draft.title,
        content_doc: (request.draft.content_doc ?? undefined) as JournalCreate['content_doc'],
        document_schema_version: 1,
        journal_date: request.draft.date,
        folder_id: request.draft.folder_id,
        journal_kind: options.journalKind,
        ...(options.draftStartedAt === undefined ? {} : { draft_started_at: options.draftStartedAt }),
        ...(request.extras ?? {}),
      }
      try {
        return journalToServerFile(await createRequest(payload))
      } catch (error: unknown) {
        if (isLegacyConflict(error)) translateLegacy(error)
        throw error
      }
    },
    async update(request) {
      const payload: JournalUpdate = { expected_revision: request.expected_revision }
      if (request.patch.title !== undefined) payload.title = request.patch.title
      if (request.patch.content_doc !== undefined) {
        payload.content_doc = request.patch.content_doc as JournalUpdate['content_doc']
        payload.document_schema_version = 1
      }
      if (request.patch.journal_date !== undefined) payload.journal_date = request.patch.journal_date
      if (request.patch.folder_id !== undefined) payload.folder_id = request.patch.folder_id
      try {
        return journalToServerFile(await updateRequest(request.file_id, payload))
      } catch (error: unknown) {
        if (isLegacyConflict(error)) translateLegacy(error)
        throw error
      }
    },
  }
}
