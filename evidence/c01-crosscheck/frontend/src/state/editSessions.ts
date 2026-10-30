/**
 * 应用级编辑会话与按文件串行写队列（Stage 4 / S04-T02）。
 *
 * 权威依据：`docs/stage4-architecture.md` §4、§4.1，`docs/stage4-api.md` §10，
 * `docs/stage4.md` §10，`docs/stage4-tasks.md` §3.3。
 *
 * 本文件不依赖 React、不发真实请求：网络通过注入的 `SaveTransport`，
 * 因此可以用
 *
 *   node --experimental-strip-types src/state/editSessions.test.ts
 *
 * 直接运行纯逻辑测试。React 订阅在 `../hooks/useEditSession.ts`。
 *
 * 与 Stage 3 `utils/autosave.ts` 的关系：那边是**页面级**单文件状态机，
 * 这套是**应用级**会话表——页面卸载不再丢队列、不再各自建写队列。
 * 序号 / 创建重放 / CAS 的语义沿用同一套已验证结论：
 *
 * 1. 每个文件同一时刻只有一个在途写请求（按 typed key 串行），
 *    在途期间的新输入只更新草稿，不排第二个请求；
 * 2. 提交时把「提交那一刻的快照 + 序号」扣在请求上，响应只能确认自己那份快照，
 *    迟到 / 乱序 / 跨文件响应一律不碰别的会话；
 * 3. 新建使用稳定 `createKey`，首次 POST 的完整 payload 冻结在 `firstRequest`，
 *    丢响应后**同键同首次 payload** 重放取回 ID，再对更晚输入发 PATCH；
 * 4. 409 / 404 / 网络失败全部保留本地草稿与服务端基线，不静默覆盖。
 */

/* ------------------------------------------------------------------ 基础类型 */

/** 文件类型：Stage 4 最终只有 Journal 与 Insight（API §1）。 */
export type SessionType = 'journal' | 'insight'

/**
 * 变化来源。`user_input` 才推进 AI 触发序号（T09 的自动调度基线），
 * `system` 用于载入、模板插入、AI 回写、目标同步、恢复复制等系统写入。
 */
export type ChangeOrigin = 'user_input' | 'system'

/**
 * 保存状态。`missing` 专指服务端已不存在（404 / 软删），
 * 此时本地草稿必须保留，但绝不自动重建或覆盖。
 */
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed' | 'conflict' | 'missing'

/** 本地草稿持久化状态；与服务器是否保存完全分开显示（产品 §10）。 */
export type LocalDraftState = 'idle' | 'pending' | 'saved' | 'failed'

/** 会话里保存的正文草稿：与文件类型无关的最小字段集。 */
export interface DocumentDraft {
  title: string
  /** 正文 JSON 权威（schema 1 doc）；具体校验由后端与 T03 负责。 */
  content_doc: unknown
  /** 业务日期；Insight 恒为空串。 */
  date: string
  folder_id: number | null
}

/** PATCH 只提交真正变化的字段（与 `docs/stage4-api.md` §1 一致）。 */
export interface DraftPatch {
  title?: string | null
  content_doc?: unknown
  journal_date?: string
  folder_id?: number | null
}

/** 服务端返回的文件身份 + 版本 + 权威草稿。 */
export interface ServerFile {
  id: number
  revision: number
  draft: DocumentDraft
}

/** 首次创建请求：payload 一旦冻结就不再改变（同键同 payload 才能重放）。 */
export interface CreateRequest {
  client_create_id: string
  draft: DocumentDraft
  /** Ritual 的 journal_kind / draft_started_at 等业务字段，由调用方给定并冻结。 */
  extras: Record<string, unknown> | null
}

export interface UpdateRequest {
  file_id: number
  expected_revision: number
  patch: DraftPatch
  draft: DocumentDraft
}

/** 注入的传输层；页面 / API 模块实现它，本模块不直接 fetch。 */
export interface SaveTransport {
  create(request: CreateRequest): Promise<ServerFile>
  update(request: UpdateRequest): Promise<ServerFile>
}

/* --------------------------------------------------------------- 文件变更 */

/** 受控 ops：只允许由后端结果驱动，客户端不能自由写系统结构。 */
export interface FileOp {
  kind: string
  node_id?: string
}

export interface FileEffect {
  type: SessionType
  id: number
  base_revision: number
  revision: number
  ops: FileOp[]
}

/** 多文件命令 / AI apply 的返回（API §10）。 */
export interface FileMutation {
  files: { type: SessionType; file: ServerFile }[]
  effects: FileEffect[]
  request_id?: string | null
}

/* ------------------------------------------------------------------ 会话 */

export interface EditSession {
  sessionId: string
  type: SessionType
  /** 稳定草稿身份：新建时就确定，取得服务器 id 后仍不变（不重建编辑器）。 */
  draftId: string
  /** 浏览器标签身份：多标签草稿与清理范围都按它隔离。 */
  tabId: string
  fileId: number | null
  revision: number | null
  /** 写队列键：取得 id 前是 `draft:<draftId>`，之后是 `<type>:<id>`。 */
  queueKey: string
  baseline: DocumentDraft
  draft: DocumentDraft
  /** 任何改变草稿的写入都推进；作为保存屏障（有界序号）。 */
  inputSeq: number
  /** 只有真实用户文字才推进；T09 自动 AI 的基线口径。 */
  userInputSeq: number
  ackedSeq: number
  inFlight: { seq: number; draft: DocumentDraft } | null
  createKey: string
  /** 首次创建请求的冻结副本；取得服务器身份前一直保留。 */
  firstRequest: { client_create_id: string; draft: DocumentDraft; extras: Record<string, unknown> | null; seq: number } | null
  status: SaveStatus
  error: string
  localState: LocalDraftState
  localError: string
  /** IME 组合中：不把半个拼音写进服务器（架构 §4.1）。 */
  imeComposing: boolean
  transport: SaveTransport
  /** 业务可提交判定；由调用方注入，会话核心不猜长度/空白规则。 */
  isSavable: ((draft: DocumentDraft) => boolean) | null
  extras: Record<string, unknown> | null
  updatedAt: number
}

/**
 * 已存首次创建请求的冻结副本（T02 恢复入口）。
 *
 * 形状与 `LocalJournalDraft.first_request` 重建出来的参数完全一致：
 * `draft` 是**原首次 POST 的 payload**，不是恢复时编辑器里的较新输入。
 * 恢复会话时把它原样交给 `openSession`，`planWrite` 就会同键同 payload 重放。
 */
export interface RestoredFirstRequest {
  client_create_id: string
  draft: DocumentDraft
  extras: Record<string, unknown> | null
  seq: number
}

/** 拒绝恢复的原因；只描述记录与事实不符，不含正文。 */
export type RestoreRejection =
  /** payload 缺字段 / 类型不对 / 已有文件身份还想重放创建。 */
  | 'corrupt_request'
  /** 创建键不一致（记录的键与会话的键、或与显式传入的键不同）。 */
  | 'key_mismatch'
  /** 首次请求序号不成立：非正整数，或超前于恢复现场的最新序号。 */
  | 'stale_seq'
  /** 恢复现场序号不成立：非非负整数。 */
  | 'invalid_resume_seq'

export class EditSessionRestoreError extends Error {
  readonly reason: RestoreRejection
  constructor(reason: RestoreRejection, message: string) {
    super(message)
    this.name = 'EditSessionRestoreError'
    this.reason = reason
  }
}

export interface OpenSessionInput {
  sessionId: string
  type: SessionType
  tabId: string
  draft: DocumentDraft
  transport: SaveTransport
  draftId?: string
  createKey?: string
  file?: { id: number; revision: number; draft: DocumentDraft } | null
  extras?: Record<string, unknown> | null
  isSavable?: ((draft: DocumentDraft) => boolean) | null
  /**
   * 「首次创建响应丢失」的恢复入口：传入记录里冻结的原请求。
   * 缺省为 `null`，即普通打开 / 新建，行为与之前完全一致。
   */
  firstRequest?: RestoredFirstRequest | null
  /**
   * 恢复现场的最新输入序号（本地记录的 `input_seq`）。
   *
   * 必须续上，否则本地镜像的 `write_seq` 会小于磁盘上的记录而被判为旧写入丢弃，
   * 也会让 `settleWrite` 的确认序号退回到 0。缺省 0（新建会话）。
   */
  resumedInputSeq?: number
}

/* ------------------------------------------------------------- 纯工具函数 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * JSON 值的结构相等。正文是 JSON，不能拿 `===` 比引用，
 * 也不能用 `JSON.stringify` 比字符串（对象键顺序会被序列化顺序左右）。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false
    }
    return true
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

export function draftEquals(a: DocumentDraft, b: DocumentDraft): boolean {
  return a.title === b.title
    && a.date === b.date
    && a.folder_id === b.folder_id
    && deepEqual(a.content_doc, b.content_doc)
}

export function draftHasChanges(draft: DocumentDraft, baseline: DocumentDraft): boolean {
  return !draftEquals(draft, baseline)
}

/** 只包含真实变化的补丁；空标题提交为 null（清空）。 */
export function draftPatch(draft: DocumentDraft, baseline: DocumentDraft): DraftPatch {
  const patch: DraftPatch = {}
  if (draft.title !== baseline.title) patch.title = draft.title === '' ? null : draft.title
  if (!deepEqual(draft.content_doc, baseline.content_doc)) patch.content_doc = draft.content_doc
  if (draft.date !== baseline.date) patch.journal_date = draft.date
  if (draft.folder_id !== baseline.folder_id) patch.folder_id = draft.folder_id
  return patch
}

export function isPatchEmpty(patch: DraftPatch): boolean {
  return Object.keys(patch).length === 0
}

/** typed key：写队列的唯一排序与隔离单位。 */
export function fileKey(type: SessionType, id: number): string {
  return `${type}:${id}`
}

export function draftQueueKey(draftId: string): string {
  return `draft:${draftId}`
}

/**
 * 关联队列的确定顺序：先按 typed key 的类型名，再按数字 id。
 * 多文件命令按同一顺序取队列，避免两端互相等待（架构 §4 第 1 步）。
 */
export function sortQueueKeys(keys: readonly string[]): string[] {
  const unique = Array.from(new Set(keys.filter((key) => key !== '')))
  return unique.sort((left, right) => {
    const [leftType, leftId] = splitKey(left)
    const [rightType, rightId] = splitKey(right)
    if (leftType !== rightType) return leftType < rightType ? -1 : 1
    return leftId - rightId
  })
}

function splitKey(key: string): [string, number] {
  const index = key.lastIndexOf(':')
  if (index < 0) return [key, 0]
  const id = Number(key.slice(index + 1))
  return [key.slice(0, index), Number.isFinite(id) ? id : 0]
}

/* ---------------------------------------------------------- 文档节点小工具 */

function findNodeById(node: unknown, nodeId: string): unknown {
  if (!isPlainObject(node)) return null
  const attrs = node.attrs
  if (isPlainObject(attrs) && attrs.id === nodeId) return node
  const content = node.content
  if (!Array.isArray(content)) return null
  for (const child of content) {
    const found = findNodeById(child, nodeId)
    if (found !== null) return found
  }
  return null
}

/** 用 `replacement` 替换同 id 节点；本地找不到时返回 `null`（不猜测位置）。 */
function replaceNodeById(node: unknown, nodeId: string, replacement: unknown): unknown | null {
  if (!isPlainObject(node)) return null
  const attrs = node.attrs
  if (isPlainObject(attrs) && attrs.id === nodeId) return replacement
  const content = node.content
  if (!Array.isArray(content)) return null
  let changed = false
  const nextContent: unknown[] = []
  for (const child of content) {
    const replaced = replaceNodeById(child, nodeId, replacement)
    if (replaced === null) {
      nextContent.push(child)
      continue
    }
    changed = true
    nextContent.push(replaced)
  }
  if (!changed) return null
  return { ...node, content: nextContent }
}

export interface NarrowApplyResult {
  draft: DocumentDraft
  applied: string[]
  ignored: string[]
}

/**
 * 只把**已知窄变化**应用到较新草稿，绝不整篇回填（API §10）。
 * 目前只处理 `replace_placeholder`：按稳定节点 ID 用服务端节点替换本地同 ID 节点。
 * 未识别 / 本地已不存在该节点 → 计入 `ignored`，草稿保持不动。
 */
export function applyNarrowOps(
  draft: DocumentDraft,
  serverDraft: DocumentDraft | null,
  ops: readonly FileOp[],
  baseline?: DocumentDraft,
): NarrowApplyResult {
  const applied: string[] = []
  const ignored: string[] = []
  let doc = draft.content_doc
  let changed = false
  for (const op of ops) {
    if (typeof op.node_id !== 'string' || serverDraft === null) {
      ignored.push(op.kind)
      continue
    }
    let replacement = findNodeById(serverDraft.content_doc, op.node_id)
    if (op.kind === 'goal_fields' || op.kind === 'goal_visibility') {
      const local = findNodeById(doc, op.node_id)
      const original = baseline && findNodeById(baseline.content_doc, op.node_id)
      if (!isPlainObject(local) || !isPlainObject(original) || !isPlainObject(replacement) ||
          local.type !== 'goalReview' || replacement.type !== 'goalReview' ||
          !deepEqual(local.attrs, original.attrs)) {
        ignored.push(op.kind)
        continue
      }
      replacement = { ...local, attrs: replacement.attrs }
    } else if (op.kind !== 'replace_placeholder') {
      ignored.push(op.kind)
      continue
    }
    if (replacement === null) {
      ignored.push(op.kind)
      continue
    }
    const next = replaceNodeById(doc, op.node_id, replacement)
    if (next === null) {
      ignored.push(op.kind)
      continue
    }
    doc = next
    changed = true
    applied.push(op.kind)
  }
  return { draft: changed ? { ...draft, content_doc: doc } : draft, applied, ignored }
}

/* -------------------------------------------------------------- 状态推进 */

/** 结构上是不是一份可提交的草稿；恢复入口不接受「差不多能看」的载荷。 */
function isDocumentDraft(value: unknown): value is DocumentDraft {
  if (!isPlainObject(value)) return false
  if (typeof value.title !== 'string') return false
  if (typeof value.date !== 'string') return false
  if (!('content_doc' in value)) return false
  if (value.folder_id !== null && typeof value.folder_id !== 'number') return false
  return true
}

/**
 * 校验并冻结恢复用的首次请求。
 *
 * 三道检查缺一不可：
 * 1. **身份**：创建键必须与会话的 `createKey` 同一个，否则就是两次不同的创建；
 * 2. **完整性**：payload 必须是完整的 `DocumentDraft`，不猜默认值；
 * 3. **序号**：`seq` 必须是 1..resumeSeq 之间的整数——旧的 seq 说明记录被截断，
 *    超前的 seq 说明记录来自另一个时间线，两者都会让屏障与确认序号错位。
 */
function validateRestoredFirstRequest(
  request: RestoredFirstRequest,
  createKey: string,
  resumeSeq: number,
): RestoredFirstRequest {
  if (typeof request.client_create_id !== 'string' || request.client_create_id.trim() === '') {
    throw new EditSessionRestoreError('corrupt_request', '已存首次请求没有创建键，不能重放。')
  }
  if (request.client_create_id !== createKey) {
    throw new EditSessionRestoreError('key_mismatch', '已存首次请求的创建键与会话创建键不一致，不能重放。')
  }
  if (!isDocumentDraft(request.draft)) {
    throw new EditSessionRestoreError('corrupt_request', '已存首次请求的载荷不完整，不能重放。')
  }
  if (request.extras !== null && !isPlainObject(request.extras)) {
    throw new EditSessionRestoreError('corrupt_request', '已存首次请求的附加字段不合法，不能重放。')
  }
  if (!Number.isInteger(request.seq) || request.seq < 1 || request.seq > resumeSeq) {
    throw new EditSessionRestoreError('stale_seq', '已存首次请求的输入序号不成立（过旧或超前），不能重放。')
  }
  return {
    client_create_id: request.client_create_id,
    draft: {
      title: request.draft.title,
      content_doc: request.draft.content_doc,
      date: request.draft.date,
      folder_id: request.draft.folder_id,
    },
    extras: request.extras === null ? null : { ...request.extras },
    seq: request.seq,
  }
}

export function createSession(input: OpenSessionInput): EditSession {
  const draftId = input.draftId ?? input.sessionId
  const file = input.file ?? null
  /** 打开已有文件时，调用方传入的 `draft` 就是服务器内容；新建时是空草稿。 */
  const draft: DocumentDraft = input.draft
  const resumeSeq = input.resumedInputSeq ?? 0
  if (!Number.isInteger(resumeSeq) || resumeSeq < 0) {
    throw new EditSessionRestoreError('invalid_resume_seq', '恢复现场的输入序号不成立，不能恢复会话。')
  }
  const supplied = input.firstRequest ?? null
  if (supplied !== null && file !== null) {
    throw new EditSessionRestoreError('corrupt_request', '会话已有服务器文件身份，不能再重放首次创建请求。')
  }
  const createKey = input.createKey ?? supplied?.client_create_id ?? newKey()
  // 重放时必须沿用记录里的创建键：缺省就取它，显式传入则必须相等（否则上面会拒绝）。
  const firstRequest = supplied === null
    ? null
    : validateRestoredFirstRequest(supplied, createKey, resumeSeq)
  return {
    sessionId: input.sessionId,
    type: input.type,
    draftId,
    tabId: input.tabId,
    fileId: file?.id ?? null,
    revision: file?.revision ?? null,
    queueKey: file === null ? draftQueueKey(draftId) : fileKey(input.type, file.id),
    baseline: file === null ? draft : file.draft,
    draft,
    inputSeq: resumeSeq,
    userInputSeq: resumeSeq,
    ackedSeq: 0,
    inFlight: null,
    createKey,
    firstRequest,
    status: 'saved',
    error: '',
    localState: 'idle',
    localError: '',
    imeComposing: false,
    transport: input.transport,
    isSavable: input.isSavable ?? null,
    extras: input.extras ?? null,
    updatedAt: 0,
  }
}

let keyCounter = 0

/** 稳定键生成：优先 crypto.randomUUID，缺失时退化为时间戳 + 计数。 */
export function newKey(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') return globalCrypto.randomUUID()
  keyCounter += 1
  return `key-${Date.now()}-${keyCounter}`
}

/**
 * 记录一次变化。
 *
 * - 内容没变则原样返回（不推进序号，也不制造一次提交机会）；
 * - `user_input` 同时推进保存序号与 AI 触发序号，并把本地草稿标记为待写；
 * - `system` 只推进保存序号：AI / 模板 / 载入等系统写入不能触发自动 AI（产品 §9）；
 * - 失败 / 冲突 / 服务端缺失状态在继续输入后**保持**，不把停止重试变成隐式重试。
 */
export function applyChange(
  session: EditSession,
  draft: DocumentDraft,
  origin: ChangeOrigin,
): EditSession {
  if (draftEquals(session.draft, draft)) return session
  const next: EditSession = {
    ...session,
    draft,
    inputSeq: session.inputSeq + 1,
    userInputSeq: origin === 'user_input' ? session.userInputSeq + 1 : session.userInputSeq,
  }
  if (origin === 'user_input') next.localState = 'pending'
  if (session.inFlight !== null) next.status = 'saving'
  else if (session.status === 'failed' || session.status === 'conflict' || session.status === 'missing') {
    next.status = session.status
  } else {
    next.status = draftEquals(draft, session.baseline) ? 'saved' : 'unsaved'
  }
  return next
}

export type WriteDecision =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'blocked'; reason: 'conflict' | 'failed' | 'missing' | 'invalid' | 'ime' }
  | { kind: 'create'; request: CreateRequest; seq: number }
  | { kind: 'update'; request: UpdateRequest; seq: number; draft: DocumentDraft }

/**
 * 现在要不要发写请求。创建重放优先于「没有变化」判断：
 * 首次 POST 响应丢失时草稿可能已经回到基线，但身份还没拿到，必须重放取回 ID。
 */
export function planWrite(session: EditSession): WriteDecision {
  if (session.inFlight !== null) return { kind: 'busy' }
  if (session.status === 'conflict' || session.status === 'failed' || session.status === 'missing') {
    return { kind: 'blocked', reason: session.status }
  }
  if (session.imeComposing) return { kind: 'blocked', reason: 'ime' }

  if (session.fileId === null || session.revision === null) {
    const pending = session.firstRequest
    if (pending !== null) {
      return {
        kind: 'create',
        seq: pending.seq,
        request: { client_create_id: pending.client_create_id, draft: pending.draft, extras: pending.extras },
      }
    }
    if (draftEquals(session.draft, session.baseline)) return { kind: 'idle' }
    if (session.isSavable !== null && !session.isSavable(session.draft)) {
      return { kind: 'blocked', reason: 'invalid' }
    }
    return {
      kind: 'create',
      seq: session.inputSeq,
      request: { client_create_id: session.createKey, draft: session.draft, extras: session.extras },
    }
  }

  if (!draftHasChanges(session.draft, session.baseline)) return { kind: 'idle' }
  if (session.isSavable !== null && !session.isSavable(session.draft)) {
    return { kind: 'blocked', reason: 'invalid' }
  }
  return {
    kind: 'update',
    seq: session.inputSeq,
    draft: session.draft,
    request: {
      file_id: session.fileId,
      expected_revision: session.revision,
      patch: draftPatch(session.draft, session.baseline),
      draft: session.draft,
    },
  }
}

/** 登记在途请求：同时冻结「这次提交的快照」与首次创建 payload。 */
export function beginWrite(session: EditSession, decision: WriteDecision): EditSession {
  if (decision.kind !== 'create' && decision.kind !== 'update') return session
  const snapshot = decision.request.draft
  const next: EditSession = {
    ...session,
    inFlight: { seq: decision.seq, draft: snapshot },
    status: 'saving',
    error: '',
  }
  if (decision.kind === 'create' && session.firstRequest === null) {
    next.firstRequest = {
      client_create_id: decision.request.client_create_id,
      draft: snapshot,
      extras: decision.request.extras,
      seq: decision.seq,
    }
  }
  return next
}

export type WriteOutcome =
  | { kind: 'ok'; file: ServerFile }
  | { kind: 'conflict'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'failed'; message: string }

/**
 * 结算一次写请求。
 *
 * 序号与 `inFlight` 不符（迟到、重复、已被取代）→ 原样返回，
 * 绝不改动草稿，也绝不把别的请求结果记到自己头上。
 */
export function settleWrite(session: EditSession, seq: number, outcome: WriteOutcome): EditSession {
  if (session.inFlight === null || session.inFlight.seq !== seq) return session
  const snapshot = session.inFlight.draft
  if (outcome.kind === 'ok') {
    /**
     * 只有「当前草稿与这次提交的快照完全一致」时，才能把确认序号推到最新的
     * `inputSeq`：此时服务器内容就是当前内容，中间的输入都已落地。
     * 否则只确认到本次请求的 `seq`——重放创建只带原首次 payload，
     * 把较新的输入一起算作已确认会让本地草稿被提前清掉。
     */
    const settled = draftEquals(session.draft, snapshot)
    const next: EditSession = {
      ...session,
      fileId: outcome.file.id,
      revision: outcome.file.revision,
      baseline: snapshot,
      ackedSeq: Math.max(session.ackedSeq, settled ? session.inputSeq : seq),
      inFlight: null,
      firstRequest: null,
      queueKey: fileKey(session.type, outcome.file.id),
      status: settled ? 'saved' : 'unsaved',
      error: '',
    }
    return next
  }
  const status: SaveStatus = outcome.kind === 'conflict'
    ? 'conflict'
    : outcome.kind === 'missing' ? 'missing' : 'failed'
  return { ...session, inFlight: null, status, error: outcome.message }
}

/** 用户显式重试：只解除失败，不动草稿、创建键与首次 payload。 */
export function clearFailure(session: EditSession): EditSession {
  if (session.status !== 'failed') return session
  return { ...session, status: 'unsaved', error: '' }
}

/** 用户选择「保留我的草稿，基于服务器最新版本重发」：只换身份与版本。 */
export function rebaseToServer(
  session: EditSession,
  file: { id: number; revision: number; draft: DocumentDraft },
): EditSession {
  return {
    ...session,
    fileId: file.id,
    revision: file.revision,
    baseline: file.draft,
    inFlight: null,
    firstRequest: null,
    queueKey: fileKey(session.type, file.id),
    status: draftEquals(session.draft, file.draft) ? 'saved' : 'unsaved',
    error: '',
  }
}

/** 用户选择「采用服务器版本」：草稿与基线一起换成服务器内容。 */
export function adoptServer(
  session: EditSession,
  file: { id: number; revision: number; draft: DocumentDraft },
): EditSession {
  return {
    ...session,
    fileId: file.id,
    revision: file.revision,
    baseline: file.draft,
    draft: file.draft,
    inFlight: null,
    firstRequest: null,
    queueKey: fileKey(session.type, file.id),
    status: 'saved',
    error: '',
  }
}

export function displayStatus(session: EditSession): SaveStatus {
  if (session.status === 'conflict' || session.status === 'failed' || session.status === 'missing') {
    return session.status
  }
  if (session.inFlight !== null) return 'saving'
  return draftEquals(session.draft, session.baseline) ? 'saved' : 'unsaved'
}

export function statusLabel(status: SaveStatus): string {
  switch (status) {
    case 'saved': return '服务器已保存'
    case 'saving': return '正在保存到服务器……'
    case 'unsaved': return '未提交到服务器'
    case 'failed': return '保存失败'
    case 'conflict': return '版本冲突'
    case 'missing': return '服务器上已不存在'
    default: return ''
  }
}

/** 本地草稿状态文案：与「服务器已保存」严格分开（产品 §10）。 */
export function localStateLabel(state: LocalDraftState): string {
  switch (state) {
    case 'pending': return '本地草稿待写入……'
    case 'saved': return '本地草稿已保存（仅本机浏览器）'
    case 'failed': return '本地草稿保存失败（内存内容仍在）'
    default: return ''
  }
}

/* ------------------------------------------------------------------ 队列 */

interface StoreOptions {
  /** 每次错误分类的外部覆盖；默认按 HTTP 状态码。 */
  classify?: (error: unknown) => WriteOutcome | null
  now?: () => number
}

export type SaveResult =
  | { kind: 'clean' }
  | { kind: 'queued'; seq: number }
  | { kind: 'blocked'; reason: 'conflict' | 'failed' | 'missing' | 'invalid' | 'ime' }
  | { kind: 'no_session' }

export interface ApplySummary {
  applied: { sessionId: string; fileId: number; revision: number; applied: string[]; ignored: string[] }[]
  conflicts: { sessionId: string; fileId: number; message: string }[]
  ignoredSessions: string[]
}

export interface EditSessionStore {
  subscribe(listener: () => void): () => void
  getVersion(): number
  getSession(sessionId: string): EditSession | null
  listSessions(): EditSession[]
  openSession(input: OpenSessionInput): EditSession
  closeSession(sessionId: string): void
  changeSession(sessionId: string, draft: DocumentDraft, origin: ChangeOrigin): EditSession | null
  captureSession(sessionId: string): EditSession | null
  setComposing(sessionId: string, composing: boolean): void
  setLocalState(sessionId: string, state: LocalDraftState, error?: string): void
  saveToSequence(sessionId: string): Promise<SaveResult>
  flush(sessionIds?: readonly string[]): Promise<Record<string, SaveResult>>
  retry(sessionId: string): Promise<SaveResult>
  runFileCommand(sessionId: string, run: () => Promise<FileMutation>, relatedKeys?: readonly string[]): Promise<FileMutation | null>
  applyFileMutation(mutation: FileMutation): ApplySummary
  resolveKeepLocal(sessionId: string, file: { id: number; revision: number; draft: DocumentDraft }): void
  resolveTakeServer(sessionId: string, file: { id: number; revision: number; draft: DocumentDraft }): void
}

/** 默认错误分类：409 → 冲突，404/410 → 服务端缺失，其余 → 失败。 */
export function classifyError(error: unknown): WriteOutcome {
  const status = errorStatus(error)
  const message = errorMessage(error)
  if (status === 409) return { kind: 'conflict', message }
  if (status === 404 || status === 410) return { kind: 'missing', message }
  return { kind: 'failed', message }
}

export function errorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message
  return '保存失败，请稍后重试'
}

export function createEditSessionStore(options: StoreOptions = {}): EditSessionStore {
  const sessions = new Map<string, EditSession>()
  const listeners = new Set<() => void>()
  const chains = new Map<string, Promise<void>>()
  const inFlightTasks = new Map<string, Promise<void>>()
  let version = 0
  const now = options.now ?? (() => Date.now())

  function emit(): void {
    version += 1
    for (const listener of listeners) listener()
  }

  function put(session: EditSession): EditSession {
    if (session !== sessions.get(session.sessionId)) {
      sessions.set(session.sessionId, session)
      emit()
    }
    return session
  }

  /** 按 typed key 串行：同一 key 的任务排队，不同 key 完全并行（跨文件隔离）。 */
  function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    chains.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  async function enqueueMany<T>(keys: readonly string[], task: () => Promise<T>): Promise<T> {
    const sorted = sortQueueKeys(keys)
    const pending = sorted.map((key) => chains.get(key) ?? Promise.resolve())
    const gate = Promise.all(pending).then(() => undefined)
    for (const key of sorted) chains.set(key, gate)
    const run = gate.then(task, task)
    for (const key of sorted) chains.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  async function send(sessionId: string, decision: WriteDecision): Promise<void> {
    const session = sessions.get(sessionId)
    if (session === null || session === undefined) return
    if (decision.kind !== 'create' && decision.kind !== 'update') return
    put(beginWrite(session, decision))
    const task = (async () => {
      try {
        const file = decision.kind === 'create'
          ? await session.transport.create(decision.request as CreateRequest)
          : await session.transport.update(decision.request as UpdateRequest)
        const current = sessions.get(sessionId)
        if (current === undefined) return
        put({ ...settleWrite(current, decision.seq, { kind: 'ok', file }), updatedAt: now() })
      } catch (error: unknown) {
        const current = sessions.get(sessionId)
        if (current === undefined) return
        const override = options.classify?.(error) ?? null
        const outcome = override ?? classifyError(error)
        put({ ...settleWrite(current, decision.seq, outcome), updatedAt: now() })
      } finally {
        inFlightTasks.delete(sessionId)
      }
    })()
    inFlightTasks.set(sessionId, task)
    await task
  }

  /**
   * 把会话推进到 `target` 序号为止的输入（有界屏障）：
   * 只提交捕获时已存在的草稿，之后的新输入继续留在草稿里，等下一轮调度。
   */
  async function drain(sessionId: string, target: number): Promise<SaveResult> {
    for (let guard = 0; guard < 8; guard += 1) {
      const session = sessions.get(sessionId)
      if (session === undefined) return { kind: 'no_session' }
      const decision = planWrite(session)
      if (decision.kind === 'idle') return { kind: 'clean' }
      if (decision.kind === 'blocked') return { kind: 'blocked', reason: decision.reason }
      if (decision.kind === 'busy') {
        const task = inFlightTasks.get(sessionId)
        if (task === undefined) return { kind: 'clean' }
        await task
        continue
      }
      await send(sessionId, decision)
      const after = sessions.get(sessionId)
      if (after === undefined) return { kind: 'no_session' }
      if (after.inputSeq > target) return { kind: 'queued', seq: after.inputSeq }
      if (after.status === 'conflict' || after.status === 'failed' || after.status === 'missing') {
        return { kind: 'blocked', reason: after.status }
      }
      if (after.inFlight === null && !draftHasChanges(after.draft, after.baseline)) return { kind: 'clean' }
    }
    return { kind: 'clean' }
  }

  /**
   * 应用受控文件变更：
   * - 只碰 effects 指明且 `base_revision` 对得上的会话（未知差异 → 冲突，保留双方）；
   * - 没有较新输入的会话直接采用服务器内容；
   * - 有较新输入时只应用已知窄 ops，草稿整篇不被回填。
   */
  function applyFileMutation(mutation: FileMutation): ApplySummary {
    const summary: ApplySummary = { applied: [], conflicts: [], ignoredSessions: [] }
    for (const effect of mutation.effects) {
      const entry = mutation.files.find((item) => item.type === effect.type && item.file.id === effect.id) ?? null
      const targets = Array.from(sessions.values()).filter(
        (item) => item.type === effect.type && item.fileId === effect.id,
      )
      for (const session of targets) {
        if (session.inFlight !== null) {
          put({ ...session, inFlight: null, status: 'conflict',
            error: '保存进行时服务器又发生变化，请对照最新内容；本地草稿已保留。' })
          summary.conflicts.push({ sessionId: session.sessionId, fileId: effect.id, message: '保存与服务器变化并发' })
          continue
        }
        if (session.revision !== effect.base_revision) {
          put({
            ...session,
            status: 'conflict',
            error: '服务器版本已变化，本次受控变化未应用；本地与服务器内容都已保留。',
          })
          summary.conflicts.push({
            sessionId: session.sessionId,
            fileId: effect.id,
            message: 'base_revision 与本地基线不一致',
          })
          continue
        }
        const serverDraft = entry?.file.draft ?? null
        const hasNewerInput = session.inFlight === null && draftHasChanges(session.draft, session.baseline)
        if (serverDraft === null) {
          put({ ...session, status: 'conflict', error: '服务器未返回完整文件，已保留本地草稿。' })
          summary.conflicts.push({ sessionId: session.sessionId, fileId: effect.id, message: '缺少服务器文件' })
          continue
        }
        if (!hasNewerInput) {
          const next = adoptServer(session, { id: effect.id, revision: effect.revision, draft: serverDraft })
          put({ ...next, updatedAt: now() })
          summary.applied.push({
            sessionId: session.sessionId,
            fileId: effect.id,
            revision: effect.revision,
            applied: effect.ops.map((op) => op.kind),
            ignored: [],
          })
          continue
        }
        const narrow = applyNarrowOps(session.draft, serverDraft, effect.ops, session.baseline)
        const baselineEffect = applyNarrowOps(session.baseline, serverDraft, effect.ops, session.baseline)
        if (narrow.ignored.length > 0 || baselineEffect.ignored.length > 0 || effect.ops.length === 0 ||
            !draftEquals(baselineEffect.draft, serverDraft)) {
          put({ ...session, status: 'conflict', error: '服务器变化无法安全合并，已保留本地草稿。' })
          summary.conflicts.push({ sessionId: session.sessionId, fileId: effect.id, message: '未知或无法应用的服务器变化' })
          continue
        }
        put({
          ...session,
          revision: effect.revision,
          baseline: serverDraft,
          draft: narrow.draft,
          inFlight: null,
          status: draftEquals(narrow.draft, serverDraft) ? 'saved' : 'unsaved',
          error: '',
          updatedAt: now(),
        })
        summary.applied.push({
          sessionId: session.sessionId,
          fileId: effect.id,
          revision: effect.revision,
          applied: narrow.applied,
          ignored: narrow.ignored,
        })
      }
      if (targets.length === 0) summary.ignoredSessions.push(fileKey(effect.type, effect.id))
    }
    return summary
  }

  /**
   * 对**已存在**的会话补挂首次请求（同一草稿再次要求「恢复原请求」时）。
   *
   * 返回 `null` 表示无需改动。身份冲突直接抛错：绝不改创建键、绝不改写 payload。
   * 草稿只在一个前提下被替换——会话还没有任何输入、也没有服务器身份
   * （页面先开了空草稿再点恢复），此时它只是占位符，换成记录的较新内容才正确；
   * 一旦用户已经输入过，就保留现场内容，不让恢复动作覆盖它。
   */
  function attachRestoredFirstRequest(
    existing: EditSession,
    input: OpenSessionInput,
  ): EditSession | null {
    const supplied = input.firstRequest ?? null
    if (supplied === null) return null
    // 已经拿到服务器身份：重放没有意义，也不能把旧请求挂回去。
    if (existing.fileId !== null) return null
    if (existing.firstRequest !== null) {
      if (existing.firstRequest.client_create_id !== supplied.client_create_id) {
        throw new EditSessionRestoreError('key_mismatch', '这份会话已经绑定另一次创建请求，不能换成记录的创建键。')
      }
      return null
    }
    const untouched = existing.inFlight === null
      && existing.inputSeq === 0
      && draftEquals(existing.draft, existing.baseline)
    // 占位会话（页面先开了空草稿、还没有任何输入与服务器身份）可以接手记录的
    // 创建键；一旦用户输入过，键就不再允许被替换——那会变成两次不同的创建。
    if (!untouched && existing.createKey !== supplied.client_create_id) {
      throw new EditSessionRestoreError('key_mismatch', '记录的创建键与会话当前创建键不一致，不能重放。')
    }
    const createKey = untouched ? supplied.client_create_id : existing.createKey
    const resumeSeq = Math.max(existing.inputSeq, input.resumedInputSeq ?? 0)
    if (!Number.isInteger(resumeSeq) || resumeSeq < 0) {
      throw new EditSessionRestoreError('invalid_resume_seq', '恢复现场的输入序号不成立，不能恢复会话。')
    }
    const firstRequest = validateRestoredFirstRequest(supplied, createKey, resumeSeq)
    return {
      ...existing,
      createKey,
      draft: untouched ? input.draft : existing.draft,
      baseline: untouched ? input.draft : existing.baseline,
      extras: untouched ? (input.extras ?? existing.extras) : existing.extras,
      inputSeq: resumeSeq,
      userInputSeq: Math.max(existing.userInputSeq, resumeSeq),
      firstRequest,
      // 显式重放就是一次重试：解除上一次的失败，冲突 / 缺失保持原状由用户决定。
      status: existing.status === 'failed' ? 'unsaved' : existing.status,
      error: existing.status === 'failed' ? '' : existing.error,
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getVersion() {
      return version
    },
    getSession(sessionId) {
      return sessions.get(sessionId) ?? null
    },
    listSessions() {
      return Array.from(sessions.values())
    },

    /**
     * 打开会话：**同一草稿 / 同一文件复用同一个会话**。
     * 这是「切换页面后原会话继续处理」与「创建身份切换不重建草稿」的落点：
     * 返回已有会话时，较新输入、在途请求与首次 payload 全部原样保留。
     */
    openSession(input) {
      const existing = sessions.get(input.sessionId)
        ?? Array.from(sessions.values()).find((item) => item.draftId === (input.draftId ?? input.sessionId) && item.type === input.type)
        ?? (input.file === null || input.file === undefined
          ? undefined
          : Array.from(sessions.values()).find((item) => item.type === input.type && item.fileId === input.file!.id))
      if (existing !== undefined) {
        // 重新打开只允许补上缺失的传输层 / 判定函数 / 首次请求，绝不覆盖已输入的草稿。
        let next = attachRestoredFirstRequest(existing, input) ?? existing
        if (next.transport !== input.transport) next = { ...next, transport: input.transport }
        if (input.isSavable !== undefined && input.isSavable !== null) {
          next = { ...next, isSavable: input.isSavable }
        }
        if (next !== existing) put(next)
        return sessions.get(existing.sessionId) ?? next
      }
      const created = createSession(input)
      sessions.set(created.sessionId, created)
      emit()
      return created
    },

    /** 关闭会话（用户明确丢弃 / 应用到已换文件）。在途请求照常完成，只是结果被忽略。 */
    closeSession(sessionId) {
      if (sessions.delete(sessionId)) {
        inFlightTasks.delete(sessionId)
        emit()
      }
    },

    changeSession(sessionId, draft, origin) {
      const session = sessions.get(sessionId)
      if (session === undefined) return null
      const next = applyChange(session, draft, origin)
      if (next === session) return session
      return put({ ...next, updatedAt: now() })
    },

    captureSession(sessionId) {
      return sessions.get(sessionId) ?? null
    },

    setComposing(sessionId, composing) {
      const session = sessions.get(sessionId)
      if (session === undefined || session.imeComposing === composing) return
      put({ ...session, imeComposing: composing })
    },

    setLocalState(sessionId, state, error = '') {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      if (session.localState === state && session.localError === error) return
      put({ ...session, localState: state, localError: error })
    },

    saveToSequence(sessionId) {
      const session = sessions.get(sessionId)
      if (session === undefined) return Promise.resolve({ kind: 'no_session' })
      const target = session.inputSeq
      return enqueue(session.queueKey, () => drain(sessionId, target))
    },

    async flush(sessionIds) {
      const ids = sessionIds ?? Array.from(sessions.keys())
      const result: Record<string, SaveResult> = {}
      for (const id of ids) {
        const session = sessions.get(id)
        if (session === undefined) {
          result[id] = { kind: 'no_session' }
          continue
        }
        result[id] = await enqueue(session.queueKey, () => drain(id, session.inputSeq))
      }
      return result
    },

    retry(sessionId) {
      const session = sessions.get(sessionId)
      if (session === undefined) return Promise.resolve({ kind: 'no_session' as const })
      put(clearFailure(session))
      return enqueue(session.queueKey, () => drain(sessionId, session.inputSeq))
    },

    /**
     * 多文件命令（AI prepare/apply、恢复、目标联动）。
     * 按 typed key 顺序取队列，先落库到当前序号再执行命令，最后应用 FileMutation。
     */
    async runFileCommand(sessionId, run, relatedKeys = []) {
      const session = sessions.get(sessionId)
      if (session === undefined) return null
      const keys = [session.queueKey, ...relatedKeys]
      return enqueueMany(keys, async () => {
        const flushed = await drain(sessionId, sessions.get(sessionId)?.inputSeq ?? 0)
        if (flushed.kind === 'blocked') throw new Error(`命令前保存失败（${flushed.reason}），未执行命令`)
        const mutation = await run()
        applyFileMutation(mutation)
        return mutation
      })
    },

    /** 见上方内部实现：只应用与 base_revision 对得上的受控变化。 */
    applyFileMutation,

    resolveKeepLocal(sessionId, file) {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      put({ ...rebaseToServer(session, file), updatedAt: now() })
    },

    resolveTakeServer(sessionId, file) {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      put({ ...adoptServer(session, file), updatedAt: now() })
    },
  }
}

/** 应用级单例：所有页面共享同一个会话表与写队列。 */
export const editSessionStore: EditSessionStore = createEditSessionStore()
