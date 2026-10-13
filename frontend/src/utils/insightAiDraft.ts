/**
 * Insight 草稿自主添加的纯逻辑（Stage 3 / S3-T10）。
 *
 * 契约来自 `docs/stage3-api.md` §7 与 `docs/stage3-architecture.md` §7：
 *
 * - **不新增 AI 写 Insight 的 API**：用户选中 `review.insight_drafts` 的一项后，
 *   走现有 `POST /api/insights`；`client_create_id` 初次从 `draft_id` **稳定派生**，
 *   重试同键回同一份文件；用户明确「另加一份」才用新键。
 * - **一个是观点一份草稿**：一个草稿只带一个 `viewpoint`，但可以带多个依据；
 *   本文件只负责把草稿映射成**可编辑**的标题与正文，不做语义去重、不合并草稿、
 *   不建事实关系图或强外键引用。
 * - **来源只是普通 Markdown 文本**：依据以 `> 来源：journal:12` + 原文引用保留，
 *   用户可在编辑器里自由删改。
 * - **只查看不写库**：本文件全部是纯函数，不依赖 React、不发请求；
 *   只有用户主动点「添加为 Insight」后才由页面发起创建。
 *
 * 本文件不依赖 React，可用 `node --experimental-strip-types` 直接测试。
 *
 * 关于输入形状：T09 尚未冻结公共 `review` / `ReviewPreview` 类型，
 * 因此这里只声明 T10 需要的**最小输入形状**（结构兼容，不从 T09 复制实现）。
 */

/** 依据的来源身份；A=Insight 没有业务日期与来源，这里沿用后端 evidence 的 `(type,id)`。 */
export interface InsightDraftSource {
  type: 'journal' | 'inbox'
  id: number
}

/** 一条依据：来源身份 + 用户原文引用（后端已校验 quote 是对应用户正文子串）。 */
export interface InsightDraftEvidence {
  source: InsightDraftSource
  quote: string
}

/**
 * 一份 Insight 草稿的**最小输入形状**（结构兼容 T08 `review.insight_drafts` 单项）。
 *
 * 字段全部可选：真实响应里 `draft_id` 由服务端附加（`uuid5(request_id, 'insight:{i}')`），
 * 但后端 Pydantic 模型本身不声明它，因此前端必须容忍缺失并用稳定回退键。
 */
export interface InsightDraftLike {
  /** 服务端派生的稳定草稿身份；缺失/非法时按内容回退。 */
  draft_id?: string
  title?: string
  viewpoint?: string
  evidence?: InsightDraftEvidence[]
  /** 草稿的补充说明（T08 的 `content`），作为**用户笔记**保留，不与观点重复。 */
  content?: string
}

/** 归一化后的草稿：字段齐备，供组件安全渲染。 */
export interface InsightDraftDraft {
  draft_id: string
  title: string
  viewpoint: string
  evidence: InsightDraftEvidence[]
  content: string
}

/** 依据的展示行：来源身份 + 原文引用，只用于界面阅读，不写回正文以外的地方。 */
export interface InsightDraftEvidenceLine {
  source: string
  quote: string
}

/**
 * 「添加为 Insight」时需要带进编辑器的内容。
 *
 * 这是 T09/T10 约定的**草稿选择回调载荷**：父级（ReviewPreview/App）把它交给
 * InsightPage 作为 `initialDraft`，由既有自动保存完成首次有效保存。
 */
export interface InsightDraftSeed {
  /** 可编辑标题。 */
  title: string
  /** 可编辑正文（含观点与来源 Markdown）。 */
  content: string
  /** 新建时默认无 Folder，用户可在编辑器里改。 */
  folder_id: number | null
  /** 稳定创建键：同草稿重试复用，用户「另加一份」时改用新键。 */
  createKey: string
  /** 草稿补充说明（只读展示用；已包含在正文的用户笔记区）。 */
  userNotes: string
  /** 来源草稿身份，供页面显示与调试。 */
  draftId: string
  /** 观点原文：卡片正文直接显示，也是编辑前用户看到的那一句。 */
  viewpoint: string
  /** 观点关键词：填进普通搜索框的默认值，只取观点，不含依据原文。 */
  keyword: string
  /** 依据条数，用于卡片标题。 */
  evidenceCount: number
  /** 依据展示行，供「查看依据」逐条阅读。 */
  evidenceLines: InsightDraftEvidenceLine[]
}

/** 关键词搜索的最大码点数（对齐后端 function `public_query` 的 1～120 码点上限）。 */
export const SEARCH_KEYWORD_MAX = 120

/** T10 创建键的命名空间：与 `crypto.randomUUID` 的人工新建键天然区分。 */
const DRAFT_KEY_NAMESPACE = 'seekjournal:s3-t10:insight-draft'

/** 没有 draft_id 时的内容回退命名空间。 */
const DRAFT_FALLBACK_NAMESPACE = 'seekjournal:s3-t10:insight-draft-fallback'

/** 一个 UUID 文本（任意版本）的形状判定。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** UUID v5（SHA-1）的字节布局：重算 version/variant 位，产出合法 UUID 文本。 */
function formatUuidV5(digest: Uint8Array): string {
  const bytes = Uint8Array.from(digest.slice(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 稳定 UUID 派生（**纯函数、确定性**）。
 *
 * 刻意不使用 `crypto.subtle`：它是异步的，同一输入在「未命中/已命中」两种路径上
 * 会给出不同键，直接破坏「重试同键回同一文件」的幂等语义。这里只要
 * 「同输入同输出、不同输入极低碰撞、形状是合法 UUID」即可，不需要密码学强度。
 */
function stableUuid(namespace: string, name: string): string {
  return formatUuidV5(fallbackDigest(`${namespace}\u0000${name}`))
}

/**
 * 纯函数确定性摘要。
 *
 * 只用于生成创建键，不做任何安全用途：目标只是「同输入同输出、不同输入极低碰撞」。
 */
function fallbackDigest(input: string): Uint8Array {
  const out = new Uint8Array(20)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0
    h2 = Math.imul(h2 + code + index, 0x85ebca6b) >>> 0
  }
  for (let index = 0; index < out.length; index += 1) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x27d4eb2f) >>> 0
    out[index] = (h1 ^ h2 ^ (index * 31)) & 0xff
  }
  return out
}

/** 从 `draft_id` 稳定派生创建键；同一 draft_id 永远同一个键。 */
export function deriveDraftKey(draftId: string): string {
  return stableUuid(DRAFT_KEY_NAMESPACE, draftId)
}

/** 没有（或没有合法）`draft_id` 时，按草稿内容派生的稳定回退键。 */
export function draftFallbackKey(seed: string): string {
  return stableUuid(DRAFT_FALLBACK_NAMESPACE, seed)
}

/** 判定一个 draft_id 是否可直接参与派生（非空、非纯空白、UUID 形状）。 */
function usableDraftId(draftId: unknown): string | null {
  if (typeof draftId !== 'string') return null
  const trimmed = draftId.trim()
  if (trimmed === '' || !UUID_PATTERN.test(trimmed)) return null
  return trimmed.toLowerCase()
}

/** 草稿的**内容指纹**：用于没有可用 `draft_id` 时的稳定回退键。 */
function draftFingerprint(draft: InsightDraftDraft): string {
  const evidence = draft.evidence
    .map((item) => `${item.source.type}:${item.source.id}:${item.quote}`)
    .join('\u001f')
  return [draft.title, draft.viewpoint, evidence, draft.content].join('\u001e')
}

/**
 * 没有可用 `draft_id` 时的创建键推导（**确定性**）。
 *
 * 优先用内容指纹，使同一份草稿在数组里被换到任何位置都得到同一个键；
 * 但**字段完全相同的两份草稿**（内容一致、纯空白 draft_id）内容指纹会撞在一起，
 * 此时退回位置序号，保证「一个草稿一个键」这条硬约束优先于跨位置稳定性。
 *
 * 真实响应里每份草稿都有服务端唯一的 `draft_id`，因此正常路径不会走到这里。
 */
function fingerprintKey(draft: InsightDraftDraft, index: number, attempt = 0): string {
  const fingerprint = draftFingerprint(draft)
  return attempt === 0
    ? draftFallbackKey(fingerprint)
    : draftFallbackKey(`${fingerprint}\u001d${index}\u001d${attempt}`)
}

/** 依据是否为可保留的合法来源（Insight 不是复盘来源，不能当依据）。 */
function validEvidence(value: unknown): value is InsightDraftEvidence {
  if (typeof value !== 'object' || value === null) return false
  const item = value as { source?: unknown; quote?: unknown }
  if (typeof item.quote !== 'string') return false
  const source = item.source as { type?: unknown; id?: unknown } | undefined
  if (typeof source !== 'object' || source === null) return false
  if (source.type !== 'journal' && source.type !== 'inbox') return false
  return typeof source.id === 'number' && Number.isInteger(source.id) && source.id >= 1
}

/**
 * 归一化 `review.insight_drafts`：剔除不可编辑的坏项，补齐缺失字段。
 *
 * **不做语义去重、不自动合并**：近义或重复草稿原样保留各自一份，
 * 由用户自己决定添加哪几份。
 */
export function normalizeInsightDrafts(raw: unknown): InsightDraftDraft[] {
  if (!Array.isArray(raw)) return []
  const drafts: InsightDraftDraft[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as InsightDraftLike
    const evidence = Array.isArray(record.evidence) ? record.evidence.filter(validEvidence) : []
    const draft: InsightDraftDraft = {
      draft_id: typeof record.draft_id === 'string' ? record.draft_id.trim() : '',
      title: typeof record.title === 'string' ? record.title : '',
      viewpoint: typeof record.viewpoint === 'string' ? record.viewpoint : '',
      evidence,
      content: typeof record.content === 'string' ? record.content : '',
    }
    // 一个观点都没有的项不是可用草稿；空字符串等占位项同样剔除。
    if (draft.viewpoint.trim() === '' && draft.title.trim() === '' && draft.content.trim() === ''
      && draft.evidence.length === 0) continue
    drafts.push(draft)
  }
  return drafts
}

/**
 * 为每份草稿派生**互不相同**的创建键。
 *
 * 真实响应的 `draft_id` 唯一，因此直接派生；一旦后端异常导致重复 `draft_id`
 * 或缺失 `draft_id`，改用「内容指纹 + 序号」回退，保证同一份草稿稳定、
 * 不同草稿不共享键（即使用户从同一份草稿明确「另加一份」，也由调用方换新键）。
 */
export function draftCreateKeys(drafts: InsightDraftDraft[]): string[] {
  const used = new Set<string>()
  const keys: string[] = []
  drafts.forEach((draft, index) => {
    const id = usableDraftId(draft.draft_id)
    // 后端 draft_id 唯一时直接稳定派生：同草稿重试必然回同一文件。
    // 一旦后端异常导致 draft_id 重复，必须退化到位置区分，否则两份草稿会
    // 共享同一个 client_create_id，被后端当成同一次创建而合并成一份。
    if (id !== null && !used.has(deriveDraftKey(id))) {
      const key = deriveDraftKey(id)
      used.add(key)
      keys.push(key)
      return
    }
    // 无可用/重复 draft_id：按内容指纹推导；内容完全相同时退回位置序号，
    // 保证「一个草稿一个键」不被破坏。
    let attempt = 0
    let key = fingerprintKey(draft, index, attempt)
    while (used.has(key)) {
      attempt += 1
      key = fingerprintKey(draft, index, attempt)
    }
    used.add(key)
    keys.push(key)
  })
  return keys
}

/** 把依据折成可编辑正文里的一行：`> 来源：journal:12` + 原文引用。 */
function evidenceLines(evidence: InsightDraftEvidence[]): string[] {
  if (evidence.length === 0) return []
  const lines = ['## 依据']
  for (const item of evidence) {
    lines.push(`> 来源：${item.source.type}:${item.source.id}`)
    for (const line of item.quote.split('\n')) lines.push(`> ${line}`)
  }
  return lines
}

/**
 * 组装可编辑正文。
 *
 * 结构固定为「观点 → 依据（来源 Markdown 文本）→ 用户笔记」：
 * - 观点来自 `viewpoint`；
 * - 依据逐条保留真实来源身份与原文引用，**不新增强关系**；
 * - 补充说明单独成节，与观点分开，避免查看卡片与正文重复显示同一段话。
 */
export function composeDraftContent(draft: InsightDraftDraft): string {
  const sections: string[] = []
  const viewpoint = draft.viewpoint.trim() === '' ? draft.title : draft.viewpoint
  if (viewpoint.trim() !== '') sections.push(viewpoint)
  const evidence = evidenceLines(draft.evidence)
  if (evidence.length > 0) sections.push(evidence.join('\n'))
  if (draft.content.trim() !== '') sections.push(`## 补充说明\n${draft.content}`)
  return sections.join('\n\n')
}

/**
 * 搜索框的默认关键词。
 *
 * 现有 `GET /api/search` 是**按空格切词 + 子串匹配**（`ILIKE %词%`，每个词都要命中），
 * 所以整句观点（中文里没有空格）几乎不可能命中任何记录，等于让用户一开就搜空。
 * 因此默认填**较短的标题**（通常是「我怕让人失望」这种可检索短语），
 * 没有标题时才退回观点；用户仍可在输入框里自己改成任何关键词。
 *
 * 只做长度截断，不拆分、不改写用户文字，也不做任何语义相似度计算。
 */
export function draftSourceLabel(draft: InsightDraftLike | InsightDraftDraft): string {
  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  const viewpoint = typeof draft.viewpoint === 'string' ? draft.viewpoint.trim() : ''
  const raw = title !== '' ? title : viewpoint
  const normalized = raw.replace(/\s+/g, ' ')
  const points = [...normalized]
  return points.length > SEARCH_KEYWORD_MAX ? points.slice(0, SEARCH_KEYWORD_MAX).join('') : normalized
}

/** 归一化 + 派生键 + 组装正文：纯逻辑入口，组件只消费它的结果。 */
export function insightDraftToSeed(draft: InsightDraftLike, createKey?: string): InsightDraftSeed {
  const [normalized] = normalizeInsightDrafts([draft])
  const safe: InsightDraftDraft = normalized ?? {
    draft_id: '', title: '', viewpoint: '', evidence: [], content: '',
  }
  const key = createKey ?? draftCreateKeys([safe])[0]
  return {
    title: safe.title,
    content: composeDraftContent(safe),
    folder_id: null,
    createKey: key,
    userNotes: safe.content,
    draftId: safe.draft_id,
    viewpoint: safe.viewpoint,
    keyword: draftSourceLabel(safe),
    evidenceCount: safe.evidence.length,
    evidenceLines: safe.evidence.map((item) => ({
      source: `${item.source.type}:${item.source.id}`,
      quote: item.quote,
    })),
  }
}

/** 组件/页面共用的批量入口：零草稿得到空数组（允许一次复盘提炼不出观点）。 */
export function reviewDraftsToSeeds(raw: unknown): InsightDraftSeed[] {
  const drafts = normalizeInsightDrafts(raw)
  const keys = draftCreateKeys(drafts)
  return drafts.map((draft, index) => insightDraftToSeed(draft, keys[index]))
}

/** 用户明确「另加一份」：在同一草稿上换一个全新的创建键。 */
export function duplicateSeed(seed: InsightDraftSeed, newKey: string): InsightDraftSeed {
  return { ...seed, createKey: newKey }
}
