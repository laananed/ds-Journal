/**
 * 自动保存纯逻辑（Stage 3 / S3-T02）。
 *
 * 本文件**不依赖 React、不发请求**，因此可以用
 * `node --experimental-strip-types src/utils/autosave.test.ts` 直接测试；
 * React 生命周期与 fetch 接线在 `../hooks/useAutosave.ts`。
 *
 * 设计要点（对应 `docs/stage3-architecture.md` §2 与 `docs/stage3-tasks.md` §4）：
 *
 * 1. **草稿序号**：每次真实输入 `inputSeq + 1`；提交时把「提交时的快照 + 序号」
 *    扣在在途请求上，响应只能确认它自己那一份快照，不能回头覆盖后来的输入。
 * 2. **单请求队列**：同一个文件同时最多一个在途写请求；在途期间只更新草稿，
 *    不再排队第二个请求，因此不存在两个写请求互相覆盖。
 * 3. **乱序 / 迟到响应**：`settle()` 只接受与当前在途序号匹配的响应，
 *    序号不符（早已经被替换或属于已结束的请求）直接忽略。
 * 4. **创建幂等**：新建使用稳定 `client_create_id`；失败重试复用**同一个键**；
 *    首次创建请求连同**完整业务快照 + 键 + 序号**记在 `pendingCreate`，
 *    失败后不随 `inFlight` 清空而丢失，因此「响应丢失 → 用户继续输入 → 显式重试」
 *    仍是同键同 payload 重放，不会因 payload 变化撞 409、也不换新键；
 *    创建成功只把身份从「无 id」换成「有 id」，较新草稿排队走 PATCH，不重复 POST。
 * 5. **失败 / 冲突**：保存失败停止自动重试（保留草稿与 Dirty，等用户显式重试）；
 *    409 冲突保留本地草稿与服务器基线，不自动覆盖、不自动合并。
 *
 * 三类文件共用同一份归一化草稿 `DraftSnapshot`：
 * Journal 用 `journal_date`、Inbox 用 `inbox_date`、Insight 没有日期（`date: ''`）。
 */

import { validateContent, validateTitle } from './contentValidation.ts'
import {
  blocksBodySavable,
  blocksEqual,
  hasNonBlankUserBlock,
  projectBlocks,
  validateBlocksForSave,
} from './writingBlocks.ts'
import type { Block } from '../types/writing.ts'

/** 保存状态：与产品 §2 的「未保存 / 保存中 / 已保存 / 保存失败 / 冲突」一一对应。 */
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed' | 'conflict'

/** 归一化草稿：三类文件共用的待提交内容。 */
export interface DraftSnapshot {
  /** 原始输入标题；空串表示没有标题（提交时再决定是省略还是 null）。 */
  title: string
  /**
   * 纯文本正文。**只在普通（非结构化）文件上用**：
   * `blocks` 非 null 时以 blocks 为权威正文，`content` 不参与比较与提交。
   */
  content: string
  /** 业务日期：Journal 用 journal_date，Inbox 用 inbox_date，Insight 恒为 ''。 */
  date: string
  folder_id: number | null
  /**
   * 结构化正文（Stage 3 / S3-T04）。`null` / 省略表示该文件是普通文本文件。
   *
   * - 非 null 时 blocks 是唯一权威正文，保存只发 `content_blocks`、绝不发 `content`
   *   （两者后端互斥）；
   * - 历史 NULL 文件在**首次结构化保存**时用 `legacyBlocksFromContent` 转成一个
   *   等价 user 段，投影与旧 `content` 逐字相同；
   * - 块 id 稳定：编辑文本不改变 id，也不自动合并相邻段。
   */
  blocks?: Block[] | null
}

/** 三种页面草稿的公共部分（title / content / folder_id 都同名）。 */
export interface DraftLike {
  title: string
  content: string
  folder_id: number | null
}

/** 已创建文件的身份与版本。 */
export interface FileIdentityRevision {
  id: number
  revision: number
}

/** 请求登记后要记住的写请求形状。 */
export type SaveRequest =
  | { kind: 'create'; createKey: string; seq: number; snapshot: DraftSnapshot }
  | { kind: 'update'; fileId: number; expectedRevision: number; seq: number; snapshot: DraftSnapshot }

/** 下一步该不该发请求。 */
export type SaveDecision =
  | { kind: 'none' }
  | { kind: 'wait' }
  | { kind: 'blocked'; reason: 'failed' | 'conflict' | 'invalid' }
  | { kind: 'send'; request: SaveRequest }

/** 写请求的三种结果。 */
export type SaveOutcome =
  | { kind: 'ok'; fileId: number; revision: number }
  | { kind: 'conflict'; message: string }
  | { kind: 'error'; message: string }

/** 自动保存核心状态：全部字段都是可比较的纯数据。 */
export interface AutosaveCore {
  /** 新建时使用的稳定幂等键；重试复用，成功后不再使用。 */
  createKey: string
  /** 服务器文件 id；null 表示尚未创建。 */
  fileId: number | null
  /** 服务器版本；null 表示尚未创建。 */
  revision: number | null
  /**
   * 待重放的首次创建请求：**完整业务快照**（标题 / 正文 / 日期 / Folder）+ 创建键 + 序号。
   *
   * 首次 POST 登记在途时写入；创建失败（响应丢失、网络错误）或冲突后**保留**，
   * 使「用户继续输入后再显式重试」能**同键同 payload** 重放（`docs/stage3-api.md` §1：
   * 同键同 payload 回原文件，不同 payload 409）。取得服务器身份后清空。
   * 用户后续输入只更新 `draft`，不会改写这里，因此重放不会带上新输入、也不会换新键。
   */
  pendingCreate: { createKey: string; seq: number; snapshot: DraftSnapshot } | null
  /** 服务器已确认的内容基线（与草稿同形，便于直接比较）。 */
  baseline: DraftSnapshot
  /** 本地最新输入。 */
  draft: DraftSnapshot
  /** 输入序号，只在真实输入时递增。 */
  inputSeq: number
  /** 已确认（成功保存）到的最大序号。 */
  ackedSeq: number
  /** 单请求队列：当前在途请求扣住的「序号 + 快照」。 */
  inFlight: { seq: number; snapshot: DraftSnapshot } | null
  status: SaveStatus
  error: string
}

/**
 * 归一化草稿转换：`date` 由调用方按文件类型给出（Insight 传 ''）。
 * 普通文本文件不传 `blocks`（保持无该字段）；结构化文件传入块数组。
 */
export function draftToSnapshot(draft: DraftLike, date = '', blocks: Block[] | null = null): DraftSnapshot {
  const base: DraftSnapshot = { title: draft.title, content: draft.content, date, folder_id: draft.folder_id }
  return blocks === null ? base : { ...base, blocks }
}

/**
 * 快照的阅读投影：`blocks` 非 null 时是块投影，否则是纯文本 `content`。
 *
 * 这是「正文是否变了」的唯一口径——用于校验与「旧超长正文只改标题不重新校验」
 * 的判断，和后端 `validate_blocks` 的 `content == old_content` 短路同一依据。
 */
export function draftProjection(draft: DraftSnapshot): string {
  return draft.blocks ? projectBlocks(draft.blocks) : draft.content
}

/**
 * 快照是否完全一致（逐字段比较，避免 JSON key 顺序影响）。
 *
 * 结构化文件比较块数组（顺序 / id / kind / text / request_id），
 * 且**普通 vs 结构化必须不相等**——否则「旧 NULL 正文 → 单段 user 块」的
 * 首次等价转换会因为投影相同而被误判成「没有变化」而不提交。
 */
export function snapshotEquals(a: DraftSnapshot, b: DraftSnapshot): boolean {
  if (a.title !== b.title || a.date !== b.date || a.folder_id !== b.folder_id) return false
  const aBlocks = a.blocks ?? null
  const bBlocks = b.blocks ?? null
  if ((aBlocks === null) !== (bBlocks === null)) return false
  if (aBlocks !== null) return blocksEqual(aBlocks, bBlocks)
  return a.content === b.content
}

/**
 * **创建口径**的可提交判定：对整份待创建快照校验。
 *
 * 规则与 `contentValidation.ts` / 后端 Pydantic 同一口径：
 * 标题最多 80 个 Unicode 码点；正文最多 50,000 码点且至少一个非空白字符。
 * 空白正文与超长输入**保留在草稿里但不提交**，也不会创建空文件。
 *
 * 只用于**新建**。更新已有文件请用 `isUpdateSavable` / `isSavable`：
 * 旧记录里的超长/空白正文不属于本次提交内容，不应重新验证。
 */
export function isSnapshotSavable(snapshot: DraftSnapshot): boolean {
  const title = snapshot.title === '' ? null : snapshot.title
  if (validateTitle(title) !== undefined) return false
  if (snapshot.blocks) {
    // 结构化新建：投影必须在限制内，且至少有一个非空 user 段
    // （后端 `validate_blocks`：普通保存不能只含 AI 段）。
    return validateContent(projectBlocks(snapshot.blocks)) === undefined
      && hasNonBlankUserBlock(snapshot.blocks)
  }
  return validateContent(snapshot.content) === undefined
}

/**
 * **更新口径**的可提交判定：只校验本次补丁实际提交的字段。
 *
 * 这是 `docs/stage3-api.md` §2「只改其他业务字段不重新验证旧正文」的前端落点：
 * 旧超长正文只改标题 / 日期 / Folder 时，补丁里没有 `content`，就不校验正文；
 * 旧超长标题未改动时同理。真正被修改的字段仍走原有限制。
 *
 * 结构化文件按**阅读投影**判断是否真的改了正文：
 * - 旧 NULL 正文 → 单段等价 user 块（首次转换）投影不变 → 跳过正文校验，
 *   因此旧超长正文不会被截断或重新拒绝；
 * - 投影真的变了才校验长度、有效用户正文与块结构。
 */
export function isUpdateSavable(draft: DraftSnapshot, baseline: DraftSnapshot): boolean {
  const patch = snapshotPatch(draft, baseline)
  if (patch.title !== undefined && validateTitle(patch.title) !== undefined) return false

  const projection = draftProjection(draft)
  const baselineProjection = draftProjection(baseline)
  const projectionChanged = projection !== baselineProjection

  // 结构化正文：只要 blocks 被提交（**包括旧 NULL 正文的首次等价转换**），
  // 就先做结构校验——身份/重排/删除 AI 段这类违规在阅读投影里看不出来，
  // 但会被后端拒绝，所以必须在这里先拦。
  if (draft.blocks !== undefined && draft.blocks !== null && patch.blocks !== undefined) {
    if (validateBlocksForSave(draft.blocks, baseline.blocks ?? null) !== undefined) return false
    if (projectionChanged) {
      const serverIds = new Set((baseline.blocks ?? []).map((block) => block.id))
      if (!blocksBodySavable(draft.blocks, serverIds)) return false
    }
  }

  // 正文（阅读投影）真的变了才重新校验长度与「至少有效用户正文」；
  // 只改标题/日期/Folder、或旧 NULL 正文的等价转换（投影逐字相同）
  // 一律不重新校验旧数据，因此旧超长正文不会被截断或重新拒绝。
  if (projectionChanged && validateContent(projection) !== undefined) return false
  return true
}

/** 可提交判定的上下文：服务器基线与当前是否创建态。 */
export interface SavableContext {
  /** 服务器已确认的内容基线；创建态等于当前草稿。 */
  baseline: DraftSnapshot
  /** true = 尚无服务器身份（新建）；false = 更新已有文件。 */
  isCreate: boolean
  /** 创建态是否要求业务日期必填（Journal / Inbox 新建）；更新态忽略。 */
  requireDate?: boolean
}

/**
 * 统一的可提交判定：自动保存、立即保存、retry、flush 共用同一口径。
 *
 * - 创建态：校验全部待创建业务字段（`isSnapshotSavable`），可按需要求业务日期；
 * - 更新态：只校验本次补丁实际提交的字段（`isUpdateSavable`）。
 */
export function isSavable(draft: DraftSnapshot, context: SavableContext): boolean {
  if (context.isCreate) {
    if (context.requireDate === true && draft.date === '') return false
    return isSnapshotSavable(draft)
  }
  return isUpdateSavable(draft, context.baseline)
}

/** 核心态可提交判定：按是否已有服务器身份自动选择创建 / 更新口径。 */
export function isCoreSavable(core: AutosaveCore): boolean {
  return isSavable(core.draft, {
    baseline: core.baseline,
    isCreate: core.fileId === null || core.revision === null,
  })
}

/** 初始化自动保存核心：`file` 为 null 表示新建草稿。 */
export function createAutosaveCore(options: {
  draft: DraftSnapshot
  createKey: string
  file?: FileIdentityRevision | null
}): AutosaveCore {
  const { draft, createKey, file } = options
  return {
    createKey,
    fileId: file?.id ?? null,
    revision: file?.revision ?? null,
    pendingCreate: null,
    baseline: draft,
    draft,
    inputSeq: 0,
    ackedSeq: 0,
    inFlight: null,
    status: 'saved',
    error: '',
  }
}

/**
 * 记录一次输入。
 *
 * 相同输入不递增序号（避免「点到同一内容」也制造一次提交机会）；
 * 在途期间继续输入只更新草稿并保持「保存中」，不打断单请求队列。
 * 失败 / 冲突状态在用户继续输入后**保持**，以免把「停止自动重试」变成隐式重试。
 */
export function applyInput(core: AutosaveCore, draft: DraftSnapshot): AutosaveCore {
  if (snapshotEquals(core.draft, draft)) return core
  const next: AutosaveCore = { ...core, draft, inputSeq: core.inputSeq + 1 }
  if (core.inFlight !== null) {
    next.status = 'saving'
  } else if (core.status === 'failed' || core.status === 'conflict') {
    next.status = core.status
  } else {
    next.status = snapshotEquals(draft, core.baseline) ? 'saved' : 'unsaved'
  }
  return next
}

function buildRequest(core: AutosaveCore): SaveRequest {
  if (core.fileId === null || core.revision === null) {
    const pending = core.pendingCreate
    if (pending !== null) {
      // 重放首次创建：同键 + 首次完整业务快照；最新草稿不参与，创建键也不更换。
      return { kind: 'create', createKey: pending.createKey, seq: pending.seq, snapshot: pending.snapshot }
    }
    return { kind: 'create', createKey: core.createKey, seq: core.inputSeq, snapshot: core.draft }
  }
  return { kind: 'update', fileId: core.fileId, expectedRevision: core.revision, seq: core.inputSeq, snapshot: core.draft }
}

/**
 * 现在要不要发写请求。自动保存与 flush 共用同一个决策函数，
 * 保证「导航前先落库」与「停输 800ms 后落库」不会给出两种口径。
 */
export function planSave(core: AutosaveCore, savable: boolean): SaveDecision {
  if (core.inFlight !== null) return { kind: 'wait' }
  if (snapshotEquals(core.draft, core.baseline)) return { kind: 'none' }
  if (core.status === 'conflict') return { kind: 'blocked', reason: 'conflict' }
  if (core.status === 'failed') return { kind: 'blocked', reason: 'failed' }
  if (!savable) return { kind: 'blocked', reason: 'invalid' }
  return { kind: 'send', request: buildRequest(core) }
}

/**
 * 登记在途请求：此后 `planSave` 会返回 `wait`，直到 `settle()` 到达。
 *
 * 创建请求同时被记入 `pendingCreate`（自身字段，不随 `inFlight` 清空而丢失），
 * 使失败后的显式重试仍能用**首次 payload + 原键**。
 */
export function beginSend(core: AutosaveCore, request: SaveRequest): AutosaveCore {
  return {
    ...core,
    inFlight: { seq: request.seq, snapshot: request.snapshot },
    pendingCreate: request.kind === 'create'
      ? { createKey: request.createKey, seq: request.seq, snapshot: request.snapshot }
      : core.pendingCreate,
    status: 'saving',
    error: '',
  }
}

/**
 * 结算一次写请求。
 *
 * - 序号与当前在途请求不符（迟到、重复、已被取代）→ 原样返回，忽略该响应；
 * - 成功：基线只更新为**这次提交的快照**，草稿一律不动，
 *   因此保存期间打的新字不会被旧响应覆盖；若期间有新输入，状态回到「未保存」；
 *   创建成功说明身份已确立，清空 `pendingCreate`；
 * - 冲突：保留草稿与基线，进入 `conflict`，不再自动提交；`pendingCreate` 保留
 *   （真正 Daily 唯一冲突 / 同键异体 409 会照常暴露，不被吞掉、也不自动换键）；
 * - 失败：保留草稿与 Dirty，进入 `failed`，不再自动重试；`pendingCreate` 保留，
 *   供用户显式重试时同键同 payload 重放。
 */
export function settle(core: AutosaveCore, seq: number, outcome: SaveOutcome): AutosaveCore {
  if (core.inFlight === null || core.inFlight.seq !== seq) return core
  const snapshot = core.inFlight.snapshot
  if (outcome.kind === 'ok') {
    const next: AutosaveCore = {
      ...core,
      fileId: outcome.fileId,
      revision: outcome.revision,
      pendingCreate: null,
      baseline: snapshot,
      ackedSeq: Math.max(core.ackedSeq, seq),
      inFlight: null,
      error: '',
    }
    next.status = snapshotEquals(next.draft, snapshot) ? 'saved' : 'unsaved'
    return next
  }
  if (outcome.kind === 'conflict') {
    return { ...core, inFlight: null, status: 'conflict', error: outcome.message }
  }
  return { ...core, inFlight: null, status: 'failed', error: outcome.message }
}

/** 用户显式重试：只把「保存失败」恢复成可提交，草稿、创建键与基线都不变。 */
export function clearFailure(core: AutosaveCore): AutosaveCore {
  if (core.status !== 'failed') return core
  return { ...core, status: 'unsaved', error: '' }
}

/**
 * 用户显式选择「先刷新到服务器最新版本，再用我的草稿重新提交」。
 * 只换身份与版本，不改草稿；不自动调用，必须由用户点击触发。
 */
export function rebaseRevision(core: AutosaveCore, fileId: number, revision: number): AutosaveCore {
  return {
    ...core,
    fileId,
    revision,
    inFlight: null,
    status: snapshotEquals(core.draft, core.baseline) ? 'saved' : 'unsaved',
    error: '',
  }
}

/** 用户显式选择「采用服务器版本」：草稿与基线一起换成服务器内容。 */
export function adoptServer(
  core: AutosaveCore,
  file: FileIdentityRevision,
  draft: DraftSnapshot,
): AutosaveCore {
  return {
    ...core,
    fileId: file.id,
    revision: file.revision,
    pendingCreate: null,
    baseline: draft,
    draft,
    inFlight: null,
    status: 'saved',
    error: '',
  }
}

/** 是否还有未落库的真实改动。 */
export function isDirty(core: AutosaveCore): boolean {
  return !snapshotEquals(core.draft, core.baseline)
}

/** 归一化补丁：只包含真正变化的字段。 */
export interface SnapshotPatch {
  title?: string | null
  content?: string
  /** 结构化正文；与 `content` 互斥（`docs/stage3-api.md` §2）。 */
  blocks?: Block[]
  date?: string
  folder_id?: number | null
}

/**
 * 计算 PATCH 补丁。
 *
 * 关键点：**只提交真正变化的字段**，因此「旧超长正文只改标题 / 日期 / Folder」
 * 仍然可用（后端只校验本次提交的字段，见 `docs/stage3-api.md` §1～2），
 * 也不会把未改动的超长旧正文重新送进校验。
 * 空标题提交为 `null`（清空），与 Stage 2 的 `draftTitleToValue` 同一口径。
 */
export function snapshotPatch(draft: DraftSnapshot, baseline: DraftSnapshot): SnapshotPatch {
  const patch: SnapshotPatch = {}
  if (draft.title !== baseline.title) patch.title = draft.title === '' ? null : draft.title
  const draftBlocks = draft.blocks ?? null
  const baselineBlocks = baseline.blocks ?? null
  if (draftBlocks !== null || baselineBlocks !== null) {
    // 结构化文件只发 content_blocks；绝不发 content（后端两者互斥，且
    // 结构化文件收到 content 会返回 409）。
    if (draftBlocks !== null && !blocksEqual(draftBlocks, baselineBlocks)) {
      patch.blocks = [...draftBlocks]
    }
  } else if (draft.content !== baseline.content) {
    patch.content = draft.content
  }
  if (draft.date !== baseline.date) patch.date = draft.date
  if (draft.folder_id !== baseline.folder_id) patch.folder_id = draft.folder_id
  return patch
}

/** 补丁是否为空（没有任何字段需要提交）。 */
export function isSnapshotPatchEmpty(patch: SnapshotPatch): boolean {
  return Object.keys(patch).length === 0
}

/** 对外显示的状态：冲突/失败优先，其次保存中，再次未保存，最后已保存。 */
export function displayStatus(core: AutosaveCore): SaveStatus {
  if (core.status === 'conflict' || core.status === 'failed') return core.status
  if (core.inFlight !== null) return 'saving'
  return isDirty(core) ? 'unsaved' : 'saved'
}

/** 状态文案：产品 §2 要求的五种显示。 */
export function statusLabel(status: SaveStatus): string {
  switch (status) {
    case 'saved': return '已保存'
    case 'saving': return '保存中……'
    case 'unsaved': return '未保存'
    case 'failed': return '保存失败'
    case 'conflict': return '冲突'
    default: return ''
  }
}

/** 状态补充说明：给用户一句「为什么」和「怎么办」。 */
export function autosaveHint(status: SaveStatus): string {
  switch (status) {
    case 'saved': return '已提交到后端。'
    case 'saving': return '正在写入后端……'
    case 'unsaved': return '停止输入约 0.8 秒后自动保存。'
    case 'failed': return '已停止自动重试，输入已保留，可点击重试。'
    case 'conflict': return '服务器版本已变化；草稿与服务器版本都已保留，不会自动覆盖。'
    default: return ''
  }
}
