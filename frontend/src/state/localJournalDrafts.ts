/**
 * Journal 未提交草稿的浏览器本地持久化（Stage 4 / S04-T02）。
 *
 * 权威依据：`docs/stage4-architecture.md` §4、§4.1，`docs/stage4-api.md` §10
 * （「Journal 本地草稿恢复契约」），产品 §10 与验收 S4-A19。
 *
 * 三条硬约束：
 *
 * 1. **只是本机草稿**：本地写入成功 ≠ 服务器已保存，两个状态在 UI 上分开显示；
 *    它不是版本历史，也不承诺突然断电时最后一次输入必然恢复。
 * 2. **只存恢复必需内容**：草稿身份、业务日期、最新未提交字段、输入序号，
 *    以及新建时的 `client_create_id` 与已发出的首次 payload。
 *    **不存 Key、私密提示词、AI 请求体或任何凭据**；不写日志、不上传。
 * 3. **多标签隔离 + 单调序号**：记录键含 `tab_id`，异步写入只能前进不能回退，
 *    较早的写入不可能覆盖较新的输入。
 *
 * 浏览器原生 IndexedDB，不引入依赖。纯逻辑（记录校验、写入合并、恢复决策）
 * 用 `node --experimental-strip-types src/state/localJournalDrafts.test.ts` 测试；
 * 真正的 IndexedDB 行为只在浏览器里验证。
 */

/* ------------------------------------------------------------------ 常量 */

/** 记录 schema 版本；与 `docs/stage4-api.md` §2 的文档 schema 无关，只描述本地记录。 */
export const DRAFT_SCHEMA_VERSION = 1 as const
export const DRAFT_DB_NAME = 'seekjournal.local.drafts'
export const DRAFT_DB_VERSION = 1
export const DRAFT_STORE_NAME = 'journal_drafts'

/** 本应用命名空间的标签身份键；不同标签拿到不同 id。 */
export const TAB_ID_STORAGE_KEY = 'seekjournal.local.tab.v1'

/** 每个草稿记录的输入序号与写入序号。 */
export type JournalDraftKind = 'writing' | 'set' | 'end'

/** 一条本地草稿记录（持久化形状，字段固定，不做未来预留）。 */
export interface LocalJournalDraft {
  schema: typeof DRAFT_SCHEMA_VERSION
  draft_id: string
  tab_id: string
  file_id: number | null
  base_revision: number | null
  journal_kind: JournalDraftKind
  business_date: string
  /** 打开草稿时捕获的带时区时刻；Ritual 的捕获日期依据（架构 §5）。 */
  draft_started_at: string
  title: string
  content_doc: unknown
  folder_id: number | null
  /** 最新未提交输入的序号；服务器确认到这个序号之前不能清记录。 */
  input_seq: number
  /** 单调写入序号；较早的异步写不能覆盖较新的。 */
  write_seq: number
  /** 新建的稳定创建键与已发出的首次 payload；取得服务器身份后清空。 */
  first_request: {
    client_create_id: string
    payload: Record<string, unknown>
    /**
     * 首次 POST 发出时的输入序号（`EditSession.firstRequest.seq`）。
     *
     * 必须单独存：镜像里的 `input_seq` 是**最新**输入，用它冒充首次请求序号，
     * 会让创建确认后就把「较新但还没 PATCH 的输入」算作已保存。
     * 旧记录没有这个字段，读取时回退到 `input_seq`（保守地当作同一次输入）。
     */
    seq?: number
  } | null
  updated_at: string
}

/* ------------------------------------------------------------- 存储错误 */

export type DraftStoreError =
  | 'unavailable'
  | 'quota'
  | 'corrupt'
  | 'version_incompatible'
  | 'io'

export type DraftWriteResult =
  | { ok: true; skipped: boolean }
  | { ok: false; error: DraftStoreError; message: string }

export interface DraftBackend {
  get(key: string): Promise<LocalJournalDraft | null>
  put(key: string, record: LocalJournalDraft): Promise<void>
  list(): Promise<LocalJournalDraft[]>
  remove(key: string): Promise<void>
  clear(): Promise<void>
}

export function draftRecordKey(tabId: string, draftId: string): string {
  return `${tabId}:${draftId}`
}

/* --------------------------------------------------------------- 校验 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/**
 * 校验持久化记录。
 *
 * 版本不符、字段缺失、类型不对的记录**不静默迁移**：返回 `null`，
 * 由调用方显示「版本不兼容/记录损坏」告警并保留原记录（架构 §4.1）。
 */
export function validateDraftRecord(raw: unknown): LocalJournalDraft | null {
  if (!isRecord(raw)) return null
  if (raw.schema !== DRAFT_SCHEMA_VERSION) return null
  if (typeof raw.draft_id !== 'string' || raw.draft_id === '') return null
  if (typeof raw.tab_id !== 'string' || raw.tab_id === '') return null
  if (typeof raw.business_date !== 'string') return null
  if (typeof raw.title !== 'string') return null
  if (!('content_doc' in raw)) return null
  if (!isNonNegativeInt(raw.input_seq) || !isNonNegativeInt(raw.write_seq)) return null
  if (raw.file_id !== null && !isPositiveInt(raw.file_id)) return null
  if (raw.base_revision !== null && !isNonNegativeInt(raw.base_revision)) return null
  if (raw.folder_id !== null && !isPositiveInt(raw.folder_id)) return null
  const kind = raw.journal_kind
  if (kind !== 'writing' && kind !== 'set' && kind !== 'end') return null
  if (raw.first_request !== null) {
    if (!isRecord(raw.first_request)) return null
    if (typeof raw.first_request.client_create_id !== 'string') return null
    if (raw.first_request.client_create_id === '') return null
    if (!isRecord(raw.first_request.payload)) return null
    // 序号可选（旧记录没有）：有则必须是正整数，否则视为记录损坏而不是猜一个值。
    if ('seq' in raw.first_request && !isPositiveInt(raw.first_request.seq)) return null
  }
  return {
    schema: DRAFT_SCHEMA_VERSION,
    draft_id: raw.draft_id,
    tab_id: raw.tab_id,
    file_id: raw.file_id as number | null,
    base_revision: raw.base_revision as number | null,
    journal_kind: kind,
    business_date: raw.business_date,
    draft_started_at: typeof raw.draft_started_at === 'string' ? raw.draft_started_at : '',
    title: raw.title,
    content_doc: raw.content_doc,
    folder_id: raw.folder_id as number | null,
    input_seq: raw.input_seq,
    write_seq: raw.write_seq,
    first_request: raw.first_request === null
      ? null
      : {
          client_create_id: (raw.first_request as { client_create_id: string }).client_create_id,
          payload: (raw.first_request as { payload: Record<string, unknown> }).payload,
          ...(isPositiveInt((raw.first_request as { seq?: unknown }).seq)
            ? { seq: (raw.first_request as { seq: number }).seq }
            : {}),
        },
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '',
  }
}

/**
 * 是否接受这次写入：**只有更晚的写入序号**才能覆盖。
 * 这样 1 号输入的异步写不可能盖掉 3 号输入的记录。
 */
export function shouldAcceptWrite(existing: LocalJournalDraft | null, incoming: LocalJournalDraft): boolean {
  if (existing === null) return true
  return incoming.write_seq > existing.write_seq
}

/* ------------------------------------------------------- 服务器版本比较 */

/** 恢复时对服务器的探测结果；由调用方用真实 GET 结果构造。 */
export type ServerDraftProbe =
  | { state: 'ok'; revision: number; softDeleted: boolean }
  | { state: 'missing' }
  | { state: 'unreadable'; message: string }

/**
 * 恢复决策（API §10）：
 * - 没有服务器 id：有首次请求就**同键重放**，否则当新草稿继续；
 * - 基线版本一致：允许按 CAS 恢复编辑；
 * - 版本不一致 / 服务器已软删 / 404 / 读取失败：保留双方内容，交给用户选择，
 *   绝不自动提交或覆盖。
 */
export type DraftRecoveryDecision =
  | { kind: 'replay_create' }
  | { kind: 'new_draft' }
  | { kind: 'restore_editable'; revision: number }
  | { kind: 'conflict'; local_revision: number | null; server_revision: number }
  | { kind: 'server_missing' }
  | { kind: 'server_unreadable'; message: string }

export function decideDraftRecovery(
  record: LocalJournalDraft,
  probe: ServerDraftProbe,
): DraftRecoveryDecision {
  if (record.file_id === null) {
    return record.first_request === null ? { kind: 'new_draft' } : { kind: 'replay_create' }
  }
  if (probe.state === 'missing') return { kind: 'server_missing' }
  if (probe.state === 'unreadable') return { kind: 'server_unreadable', message: probe.message }
  if (probe.softDeleted) return { kind: 'server_missing' }
  if (record.base_revision !== null && record.base_revision === probe.revision) {
    return { kind: 'restore_editable', revision: probe.revision }
  }
  return { kind: 'conflict', local_revision: record.base_revision, server_revision: probe.revision }
}

/**
 * 服务器确认到 `ackedSeq` 之后能否删除记录：
 * 只有记录里的最新输入序号都不超过已确认序号才可以删，否则会丢掉未提交输入。
 */
export function canClearAfterAck(record: LocalJournalDraft, ackedSeq: number): boolean {
  return record.input_seq <= ackedSeq
}

/** 恢复候选的展示信息；不含正文，避免把私人内容写进日志或通知。 */
export interface DraftCandidate {
  key: string
  draft_id: string
  tab_id: string
  file_id: number | null
  business_date: string
  journal_kind: JournalDraftKind
  title: string
  updated_at: string
  input_seq: number
  has_first_request: boolean
}

export function toCandidate(record: LocalJournalDraft): DraftCandidate {
  return {
    key: draftRecordKey(record.tab_id, record.draft_id),
    draft_id: record.draft_id,
    tab_id: record.tab_id,
    file_id: record.file_id,
    business_date: record.business_date,
    journal_kind: record.journal_kind,
    title: record.title,
    updated_at: record.updated_at,
    input_seq: record.input_seq,
    has_first_request: record.first_request !== null,
  }
}

/** 候选排序：最近改动的在前；同一时间按草稿 id 稳定排序。 */
export function sortCandidates(records: readonly LocalJournalDraft[]): DraftCandidate[] {
  return [...records]
    .sort((left, right) => {
      if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1
      return left.draft_id < right.draft_id ? -1 : 1
    })
    .map(toCandidate)
}

/* --------------------------------------------------------------- 写入器 */

export interface LocalDraftWriter {
  /** 内存副本：存储不可用时仍然可读（用户不会看到「草稿消失」）。 */
  memory(): LocalJournalDraft[]
  save(record: LocalJournalDraft): Promise<DraftWriteResult>
  list(): Promise<{ ok: true; records: LocalJournalDraft[] } | { ok: false; error: DraftStoreError; message: string }>
  remove(tabId: string, draftId: string): Promise<DraftWriteResult>
  /** 用户明确清理本应用草稿；只清本命名空间，不动其他站点数据。 */
  clearAll(): Promise<DraftWriteResult>
}

function errorOf(error: unknown): DraftStoreError {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name) : ''
  if (name === 'QuotaExceededError') return 'quota'
  if (name === 'VersionError' || name === 'DataError') return 'version_incompatible'
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'InvalidStateError') return 'unavailable'
  return 'io'
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return '本地草稿存储不可用'
}

/**
 * 内存 + 持久化双写。
 *
 * 顺序刻意是「先内存、后磁盘」：磁盘写失败时内存草稿仍在，
 * 用户可以继续编辑或明确处理，UI 显示「本地草稿保存失败」而不是假的「已保存」。
 */
export function createLocalDraftWriter(backend: DraftBackend | null): LocalDraftWriter {
  const mirror = new Map<string, LocalJournalDraft>()

  function remember(record: LocalJournalDraft): void {
    mirror.set(draftRecordKey(record.tab_id, record.draft_id), record)
  }

  return {
    memory() {
      return Array.from(mirror.values())
    },

    async save(record) {
      const valid = validateDraftRecord(record)
      if (valid === null) {
        return { ok: false, error: 'corrupt', message: '草稿记录字段不合法，已保留内存内容', }
      }
      const key = draftRecordKey(valid.tab_id, valid.draft_id)
      const existing = mirror.get(key) ?? null
      if (!shouldAcceptWrite(existing, valid)) {
        return { ok: true, skipped: true }
      }
      remember(valid)
      if (backend === null) {
        return { ok: false, error: 'unavailable', message: '本地草稿存储不可用，内容仅保存在内存' }
      }
      try {
        await backend.put(key, valid)
        return { ok: true, skipped: false }
      } catch (error: unknown) {
        return { ok: false, error: errorOf(error), message: `本地草稿写入失败：${messageOf(error)}` }
      }
    },

    async list() {
      if (backend === null) return { ok: true, records: Array.from(mirror.values()) }
      try {
        const records: LocalJournalDraft[] = []
        for (const raw of await backend.list()) {
          const valid = validateDraftRecord(raw)
          if (valid !== null) records.push(valid)
        }
        for (const record of records) remember(record)
        return { ok: true, records }
      } catch (error: unknown) {
        return { ok: false, error: errorOf(error), message: `读取本地草稿失败：${messageOf(error)}` }
      }
    },

    async remove(tabId, draftId) {
      const key = draftRecordKey(tabId, draftId)
      mirror.delete(key)
      if (backend === null) return { ok: false, error: 'unavailable', message: '本地草稿存储不可用' }
      try {
        await backend.remove(key)
        return { ok: true, skipped: false }
      } catch (error: unknown) {
        return { ok: false, error: errorOf(error), message: `删除本地草稿失败：${messageOf(error)}` }
      }
    },

    async clearAll() {
      mirror.clear()
      if (backend === null) return { ok: false, error: 'unavailable', message: '本地草稿存储不可用' }
      try {
        await backend.clear()
        return { ok: true, skipped: false }
      } catch (error: unknown) {
        return { ok: false, error: errorOf(error), message: `清空本地草稿失败：${messageOf(error)}` }
      }
    },
  }
}

/* ------------------------------------------------------------ IndexedDB */

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DRAFT_DB_NAME, DRAFT_DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        database.createObjectStore(DRAFT_STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      const database = request.result
      // 已有更高版本的库：不降级、不覆盖，交给调用方提示「版本不兼容」。
      if (database.version !== DRAFT_DB_VERSION) {
        database.close()
        reject(Object.assign(new Error('本地草稿库版本不兼容'), { name: 'VersionError' }))
        return
      }
      resolve(database)
    }
    request.onerror = () => reject(request.error ?? new Error('打开本地草稿库失败'))
    request.onblocked = () => reject(Object.assign(new Error('本地草稿库被其他标签阻塞'), { name: 'NotAllowedError' }))
  })
}

/** 浏览器原生 IndexedDB 后端；`factory` 可注入以便测试与降级。 */
export function createIndexedDbBackend(factory: IDBFactory | null): DraftBackend | null {
  if (factory === null) return null
  return {
    async get(key) {
      const database = await openDatabase(factory)
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readonly')
        const raw = await requestToPromise<unknown>(transaction.objectStore(DRAFT_STORE_NAME).get(key))
        return raw === undefined ? null : validateDraftRecord((raw as { record?: unknown }).record)
      } finally {
        database.close()
      }
    },
    async put(key, record) {
      const database = await openDatabase(factory)
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite')
        await requestToPromise(transaction.objectStore(DRAFT_STORE_NAME).put({ key, record }))
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('本地草稿事务失败'))
          transaction.onabort = () => reject(transaction.error ?? new Error('本地草稿事务中止'))
        })
      } finally {
        database.close()
      }
    },
    async list() {
      const database = await openDatabase(factory)
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readonly')
        const raws = await requestToPromise<unknown[]>(transaction.objectStore(DRAFT_STORE_NAME).getAll())
        const records: LocalJournalDraft[] = []
        for (const raw of raws) {
          const candidate = isRecord(raw) ? (raw as { record?: unknown }).record : null
          const valid = validateDraftRecord(candidate)
          if (valid !== null) records.push(valid)
        }
        return records
      } finally {
        database.close()
      }
    },
    async remove(key) {
      const database = await openDatabase(factory)
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite')
        await requestToPromise(transaction.objectStore(DRAFT_STORE_NAME).delete(key))
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('本地草稿事务失败'))
          transaction.onabort = () => reject(transaction.error ?? new Error('本地草稿事务中止'))
        })
      } finally {
        database.close()
      }
    },
    async clear() {
      const database = await openDatabase(factory)
      try {
        const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite')
        await requestToPromise(transaction.objectStore(DRAFT_STORE_NAME).clear())
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error ?? new Error('本地草稿事务失败'))
          transaction.onabort = () => reject(transaction.error ?? new Error('本地草稿事务中止'))
        })
      } finally {
        database.close()
      }
    },
  }
}

/** 浏览器里的单例：没有 IndexedDB 时退化为纯内存（并如实告警）。 */
export function defaultDraftBackend(): DraftBackend | null {
  const factory: IDBFactory | undefined = typeof globalThis.indexedDB === 'undefined'
    ? undefined : globalThis.indexedDB
  return createIndexedDbBackend(factory ?? null)
}

export const localDraftWriter: LocalDraftWriter = createLocalDraftWriter(defaultDraftBackend())

/* ------------------------------------------------------------ 标签身份 */

export interface TabStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * 解析本标签的 id：`sessionStorage` 每个标签独立，所以两个标签各有一份草稿。
 * 取不到存储时退化为调用方传入的随机 id（仍能工作，只是重开不再关联）。
 */
export function resolveTabId(storage: TabStorageLike | null, fallback: string): string {
  if (storage === null) return fallback
  try {
    const existing = storage.getItem(TAB_ID_STORAGE_KEY)
    if (existing !== null && existing !== '') return existing
    storage.setItem(TAB_ID_STORAGE_KEY, fallback)
    return fallback
  } catch {
    return fallback
  }
}

/** 生成一次新的 id（草稿 / 标签）。 */
export function newLocalId(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID()
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
