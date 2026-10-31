/**
 * Insight 未提交输入的浏览器本地恢复（修复 T11 自动保存窗口内的输入丢失）。
 *
 * 边界：
 *
 * 1. **只服务 Insight**。Journal 的本地草稿契约（`docs/stage4-api.md` §10）
 *    仍然只有 `state/localJournalDrafts.ts` 一份实现；这里不写
 *    `seekjournal.local.drafts`，也不改变任何服务器契约。
 * 2. **只是恢复线索**。本地有记录 ≠ 服务器已保存；写入/清理都以会话的
 *    `status` / `inputSeq` / `ackedSeq` 为准，不在自动保存成功前删除。
 * 3. **不静默覆盖较新版本**。记录带 `base_revision`；恢复前与服务器当前
 *    revision 比较，不同则要求用户明确选择（见 `insightRecoveryDecision`）。
 * 4. **只存恢复必需字段**：标题、正文 JSON、Folder、文件身份、基线版本与时间。
 *    不存 Key、AI 提示词或任何凭据。
 *
 * 纯逻辑（校验、键、排序、恢复判定）用 Node 类型剥离测试：
 * `node --experimental-strip-types src/state/insightLocalDrafts.test.ts`
 */

export const INSIGHT_DRAFT_PREFIX = 'seekjournal.insight.draft.v1.'
export const INSIGHT_DRAFT_VERSION = 1 as const

/** 一条 Insight 本地草稿记录（持久化形状，字段固定）。 */
export interface InsightDraftRecord {
  v: typeof INSIGHT_DRAFT_VERSION
  /** 存储键（`readInsightDrafts` 回填，便于删除）。 */
  record_key: string
  /** 面板的草稿身份：新建时是面板随机键，已有记录时等于 `insight:<id>`。 */
  draft_id: string
  file_id: number | null
  base_revision: number | null
  title: string
  content_doc: unknown
  folder_id: number | null
  /** 本地写入时间（毫秒）；只用于展示与排序，不参与冲突判断。 */
  saved_at: number
}

/** 只依赖 Storage 的这几个方法，测试可传内存实现。 */
export interface InsightDraftStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0

/** 新建草稿按面板身份隔离；已有记录按文件隔离（同一文件只有一份恢复线索）。 */
export function insightDraftRecordKey(fileId: number | null, draftId: string): string {
  return `${INSIGHT_DRAFT_PREFIX}${fileId === null ? `create:${draftId}` : `file:${fileId}`}`
}

export function serializeInsightDraft(record: InsightDraftRecord): string {
  return JSON.stringify({
    v: INSIGHT_DRAFT_VERSION,
    draft_id: record.draft_id,
    file_id: record.file_id,
    base_revision: record.base_revision,
    title: record.title,
    content_doc: record.content_doc,
    folder_id: record.folder_id,
    saved_at: record.saved_at,
  })
}

/**
 * 解析一条记录；任何字段不合规都返回 null（坏记录当不存在，不让它阻塞页面）。
 * 只接受 `INSIGHT_DRAFT_PREFIX` 命名空间下的键，避免误读其它模块的数据。
 */
export function parseInsightDraft(key: string, raw: string | null): InsightDraftRecord | null {
  if (raw === null || !key.startsWith(INSIGHT_DRAFT_PREFIX)) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.v !== INSIGHT_DRAFT_VERSION) return null
  if (typeof record.draft_id !== 'string' || record.draft_id === '') return null
  if (record.file_id !== null && !isPositiveInt(record.file_id)) return null
  if (record.base_revision !== null
    && !(typeof record.base_revision === 'number'
      && Number.isInteger(record.base_revision) && record.base_revision > 0)) return null
  if (typeof record.title !== 'string') return null
  if (typeof record.saved_at !== 'number' || !Number.isFinite(record.saved_at)) return null
  if (record.folder_id !== null && !isPositiveInt(record.folder_id)) return null
  const document = record.content_doc
  if (typeof document !== 'object' || document === null) return null
  if ((document as { type?: unknown }).type !== 'doc') return null
  return {
    v: INSIGHT_DRAFT_VERSION,
    record_key: key,
    draft_id: record.draft_id,
    file_id: record.file_id as number | null,
    base_revision: record.base_revision as number | null,
    title: record.title,
    content_doc: document,
    folder_id: record.folder_id as number | null,
    saved_at: record.saved_at,
  }
}

/** 读取全部有效记录，按写入时间从新到旧。读不到就当作没有（不抛错）。 */
export function readInsightDrafts(storage: InsightDraftStorage | null): InsightDraftRecord[] {
  if (storage === null) return []
  const records: InsightDraftRecord[] = []
  try {
    const keys: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key.startsWith(INSIGHT_DRAFT_PREFIX)) keys.push(key)
    }
    for (const key of keys) {
      const parsed = parseInsightDraft(key, storage.getItem(key))
      if (parsed !== null) records.push(parsed)
    }
  } catch {
    return records.sort((a, b) => b.saved_at - a.saved_at)
  }
  return records.sort((a, b) => b.saved_at - a.saved_at)
}

/** 写一条记录；配额/隐私模式写失败返回 false，由调用方决定是否提示。 */
export function writeInsightDraft(
  storage: InsightDraftStorage | null,
  record: InsightDraftRecord,
): boolean {
  if (storage === null) return false
  try {
    storage.setItem(record.record_key, serializeInsightDraft(record))
    return true
  } catch {
    return false
  }
}

export function removeInsightDraft(storage: InsightDraftStorage | null, recordKey: string): void {
  if (storage === null) return
  try {
    storage.removeItem(recordKey)
  } catch {
    /* 删除失败不影响主流程：下次保存成功会再试一次。 */
  }
}

export type InsightRecoveryDecision = 'restore' | 'conflict'

/**
 * 恢复前判断能否直接用本地内容：
 * - 新建草稿没有服务器版本可比，直接恢复；
 * - 已有记录只有「基线版本 == 服务器当前版本」才算可安全恢复；
 * - 版本不同进入冲突，由界面给出明确选择，绝不自动覆盖。
 */
export function insightRecoveryDecision(
  record: InsightDraftRecord,
  serverRevision: number | null,
): InsightRecoveryDecision {
  if (record.file_id === null) return 'restore'
  if (serverRevision === null) return 'conflict'
  return record.base_revision === serverRevision ? 'restore' : 'conflict'
}
