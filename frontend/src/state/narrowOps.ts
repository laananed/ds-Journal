/**
 * 受控窄变化的**安全合并**（Stage 4 / S04-T09，补 T08 交接的两个缺口）。
 *
 * 权威依据：`docs/stage4-api.md` §10（`files` 确认提交快照，较新本地输入只接收
 * 与已知 `base_revision` 对应的窄 effects；不能整篇回填覆盖较新草稿）、
 * §7（prepare 只创建占位、apply 只替换占位）、§9（评论 Mark 只引用本文件评论）、
 * `docs/stage4-architecture.md` §4 第 4 步与 §7.1。
 *
 * 两个缺口：
 *
 * 1. **prepare 新占位遇到较新草稿**：`prepare` 会在服务端快照末尾插入
 *    `aiPlaceholder` + 一段空的 continuation 段落；这两个节点在本地较新草稿里
 *    根本不存在。旧实现只在本地按 ID 找节点，找不到就判冲突，于是「AI 处理期间
 *    继续写」会把会话打进冲突。这里改为**纯插入**：把服务端新增的节点插到
 *    基线最后一段之后、用户新写的段落之前，绝不改动任何本地节点内容。
 * 2. **comment_marks 未接入**：Minds apply 的 effect 只有 `{kind:'comment_marks'}`
 *    而没有 `node_id`。这里按节点做「只增 Mark」的核对：本地节点与服务器节点在
 *    去掉 `mindComment` 后完全一致，才整节点采用服务器版本；用户在附近改过字的
 *    段落保持原样（评论仍由侧栏显示，必要时由后端标记为失锚），不静默改用户文字。
 *
 * 本文件不依赖 React、不发请求，`mergeNarrowOps` 与 `applyNarrowOps` 的返回形状
 * 一致，因此可以用
 *
 *   node --experimental-strip-types src/state/narrowOps.test.ts
 *
 * 直接验证。会话表接线见 `state/editSessions.ts` 的 `applyNarrowOps`。
 */

/* --------------------------------------------------------------- 类型 */

/** 与 `editSessions.DocumentDraft` 结构一致的草稿最小形状。 */
export interface NarrowDraft {
  title: string
  content_doc: unknown
  date: string
  folder_id: number | null
}

/** 与 `editSessions.FileOp` 结构一致。 */
export interface NarrowOp {
  kind: string
  node_id?: string
}

export interface NarrowMergeResult<N extends NarrowDraft> {
  draft: N
  applied: string[]
  ignored: string[]
  /** 已应用但需要提示用户的情形（例如评论无法安全挂 Mark），不阻断保存。 */
  warnings: string[]
}

/* ------------------------------------------------------------- 小工具 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

function nodeIdOf(node: unknown): string | null {
  if (!isPlainObject(node)) return null
  const attrs = node.attrs
  if (!isPlainObject(attrs)) return null
  return typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : null
}

export function findNodeById(node: unknown, id: string): unknown {
  if (!isPlainObject(node)) return null
  if (nodeIdOf(node) === id) return node
  if (!Array.isArray(node.content)) return null
  for (const child of node.content) {
    const found = findNodeById(child, id)
    if (found !== null) return found
  }
  return null
}

/** 用 `replacement` 替换同 id 节点；本地找不到时返回 `null`（不猜测位置）。 */
function replaceNodeById(node: unknown, id: string, replacement: unknown): unknown | null {
  if (!isPlainObject(node)) return null
  if (nodeIdOf(node) === id) return replacement
  if (!Array.isArray(node.content)) return null
  let changed = false
  const nextContent: unknown[] = []
  for (const child of node.content) {
    const replaced = replaceNodeById(child, id, replacement)
    if (replaced === null) {
      nextContent.push(child)
      continue
    }
    changed = true
    nextContent.push(replaced)
  }
  return changed ? { ...node, content: nextContent } : null
}

function topLevelContent(document: unknown): unknown[] | null {
  if (!isPlainObject(document)) return null
  return Array.isArray(document.content) ? [...document.content] : null
}

function idsOf(nodes: readonly unknown[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    const id = nodeIdOf(node)
    if (id !== null) ids.push(id)
  }
  return ids
}

function blockText(node: unknown): string {
  if (!isPlainObject(node)) return ''
  let text = ''
  for (const child of Array.isArray(node.content) ? node.content : []) {
    if (!isPlainObject(child)) continue
    if (child.type === 'text' && typeof child.text === 'string') text += child.text
    else if (child.type === 'hardBreak') text += '\n'
  }
  return text
}

/** 去掉 `mindComment` Mark 后的节点（其余内容与格式必须逐字一致才允许采用）。 */
export function stripCommentMarks(node: unknown): unknown {
  if (!isPlainObject(node)) return node
  const next: Record<string, unknown> = { ...node }
  if (Array.isArray(node.content)) {
    next.content = node.content.map((child) => stripCommentMarks(child))
  }
  if (Array.isArray(node.marks)) {
    const kept: unknown[] = node.marks
      .filter((mark) => !(isPlainObject(mark) && mark.type === 'mindComment'))
      .map((mark) => stripCommentMarks(mark))
    if (kept.length === 0) delete next.marks
    else next.marks = kept
  }
  return next
}

function hasCommentMarks(node: unknown): boolean {
  if (!isPlainObject(node)) return false
  if (Array.isArray(node.marks)
    && node.marks.some((mark) => isPlainObject(mark) && mark.type === 'mindComment')) return true
  if (!Array.isArray(node.content)) return false
  return node.content.some(hasCommentMarks)
}

/* ------------------------------------------------ 缺口一：插入新占位节点 */

interface InsertPlan {
  /** 在本地 `content` 中的插入位置（插在该下标之前）。 */
  index: number
  /** 要插入的服务端新增节点（保持服务端顺序）。 */
  nodes: unknown[]
}

/**
 * 计算「服务端新增节点插到哪里」。
 *
 * 规则（保守优先）：
 * - 只考虑服务端顶层中、基线里没有的**尾部连续段**；目标占位节点必须在这一段里；
 * - 这一段里的每个节点在本地都必须不存在（否则说明用户自己已经有了同 ID 节点，
 *   或两份状态已经分叉，交给冲突处理而不是猜位置）；
 * - 插入位置取「服务端这一段之前最后一个基线节点」在本地草稿中的位置之后；
 *   找不到这样的锚点（基线为空或用户删光了）时插到文档开头，仍不动任何本地节点。
 */
function planInsert(local: unknown, server: unknown, baseline: unknown, targetId: string): InsertPlan | null {
  const serverNodes = topLevelContent(server)
  const localNodes = topLevelContent(local)
  if (serverNodes === null || localNodes === null) return null
  const baselineIds = new Set(idsOf(topLevelContent(baseline) ?? []))
  const localIds = new Set(idsOf(localNodes))
  const targetIndex = serverNodes.findIndex((node) => nodeIdOf(node) === targetId)
  if (targetIndex < 0) return null

  // 从目标节点向左、右扩展出「服务端新增的连续段」。
  let start = targetIndex
  while (start > 0 && !baselineIds.has(nodeIdOf(serverNodes[start - 1]) ?? '')) start -= 1
  let end = targetIndex
  while (end < serverNodes.length - 1 && !baselineIds.has(nodeIdOf(serverNodes[end + 1]) ?? '')) end += 1

  const inserted = serverNodes.slice(start, end + 1)
  if (inserted.length === 0) return null
  for (const node of inserted) {
    const id = nodeIdOf(node)
    // 新节点必须带 ID 且本地确实没有：有 ID 冲突就不猜。
    if (id === null || localIds.has(id)) return null
    // 只接受已知的、可安全原位插入的块类型；其余一律交冲突处理。
    if (!isPlainObject(node)) return null
    if (node.type !== 'aiPlaceholder' && node.type !== 'aiReply' && node.type !== 'paragraph'
      && node.type !== 'heading') return null
  }
  if (!inserted.some((node) => nodeIdOf(node) === targetId)) return null

  // 锚点：服务端在插入段之前的最后一个本地也存在、且在基线里的节点。
  const anchorIds: string[] = []
  for (const node of serverNodes.slice(0, start)) {
    const id = nodeIdOf(node)
    if (id !== null && baselineIds.has(id) && localIds.has(id)) anchorIds.push(id)
  }
  if (anchorIds.length === 0 && baselineIds.size > 0) {
    // 基线不是空的，却找不到任何还能在本地定位的锚点：说明用户删改了插入点之前的
    // 全部内容。这时猜位置会把 AI 段插到错误的地方，交给冲突处理。
    return null
  }
  const anchorId = anchorIds.length > 0 ? anchorIds[anchorIds.length - 1] : null
  const localAnchor = anchorId === null ? -1 : localNodes.findIndex((node) => nodeIdOf(node) === anchorId)
  if (anchorId !== null && localAnchor < 0) return null
  return { index: localAnchor + 1, nodes: inserted }
}

function insertNodes(document: unknown, plan: InsertPlan): unknown | null {
  const nodes = topLevelContent(document)
  if (nodes === null) return null
  const index = Math.max(0, Math.min(plan.index, nodes.length))
  const next = [...nodes.slice(0, index), ...plan.nodes, ...nodes.slice(index)]
  return { ...(document as Record<string, unknown>), content: next }
}

/* ------------------------------------------------ 缺口二：只增评论 Mark */

interface AdoptResult {
  node: unknown
  adopted: boolean
  /** 服务器有 Mark、但本地该节点已被用户改过，未采用。 */
  skipped: boolean
}

/**
 * 只做「增加 mindComment Mark」的节点级采用。
 *
 * 判据：去掉 `mindComment` 后本地节点与服务器节点**完全一致**（文字与其余格式都没变），
 * 而服务器节点确实带有评论 Mark。满足才整节点取服务器版本——这等价于只加了 Mark；
 * 用户在附近改过字则不采用，也不改用户文字（评论仍由侧栏显示，后端会把
 * 位置不可靠的评论标为 unavailable）。
 */
function adoptCommentMarks(localNode: unknown, serverNodes: readonly unknown[]): AdoptResult {
  const id = nodeIdOf(localNode)
  if (id === null) return { node: localNode, adopted: false, skipped: false }
  const serverNode = serverNodes.find((node) => nodeIdOf(node) === id)
  if (serverNode === undefined || !hasCommentMarks(serverNode)) {
    return { node: localNode, adopted: false, skipped: false }
  }
  if (!deepEqual(stripCommentMarks(localNode), stripCommentMarks(serverNode))) {
    return { node: localNode, adopted: false, skipped: true }
  }
  if (deepEqual(localNode, serverNode)) return { node: localNode, adopted: false, skipped: false }
  return { node: serverNode, adopted: true, skipped: false }
}

function adoptMarksInTree(localNode: unknown, serverNodes: readonly unknown[]): {
  node: unknown
  adopted: number
  skipped: number
} {
  let adopted = 0
  let skipped = 0
  const current = adoptCommentMarks(localNode, serverNodes)
  if (current.adopted) adopted += 1
  if (current.skipped) skipped += 1
  let node = current.node
  if (isPlainObject(node) && Array.isArray(node.content)) {
    const nextContent: unknown[] = []
    let touched = false
    for (const child of node.content) {
      const result = adoptMarksInTree(child, serverNodes)
      adopted += result.adopted
      skipped += result.skipped
      if (result.node !== child) touched = true
      nextContent.push(result.node)
    }
    if (touched) node = { ...(node as Record<string, unknown>), content: nextContent }
  }
  return { node, adopted, skipped }
}

/* --------------------------------------------------------------- 主入口 */

/**
 * 把服务端受控窄变化安全合并进（可能更新的）本地草稿。
 *
 * 与 `editSessions.applyNarrowOps` 完全同形，便于会话核心直接委托：
 * - 未识别 op、找不到位置、无法只增 Mark 之外的变化 → 计入 `ignored`（调用方判冲突）；
 * - 能安全合并但需要提示的情形（用户改过字的段落无法挂评论 Mark）→ `warnings`，
 *   **不**阻断保存，也不改用户文字。
 */
export function mergeNarrowOps<N extends NarrowDraft>(
  draft: N,
  serverDraft: NarrowDraft | null,
  ops: readonly NarrowOp[],
  baseline?: NarrowDraft,
): NarrowMergeResult<N> {
  const applied: string[] = []
  const ignored: string[] = []
  const warnings: string[] = []
  if (serverDraft === null) {
    return { draft, applied, ignored: ops.map((op) => op.kind), warnings }
  }
  let doc = draft.content_doc
  let changed = false

  for (const op of ops) {
    if (op.kind === 'comment_marks') {
      // effect 不带 node_id：按节点做「只增 Mark」核对。
      const result = adoptMarksInTree(doc, topLevelContent(serverDraft.content_doc) ?? [])
      if (result.adopted > 0) {
        doc = result.node
        changed = true
        applied.push(op.kind)
      } else if (result.skipped > 0) {
        // 有评论无法安全挂到本地（段落已被改写）：结果仍保留在侧栏，不阻断保存。
        applied.push(op.kind)
        warnings.push('有评论无法挂到已改动的段落上：评论保留在侧栏，可能显示为失锚。')
      } else {
        ignored.push(op.kind)
      }
      continue
    }

    if (op.kind === 'goal_fields' || op.kind === 'goal_visibility') {
      if (typeof op.node_id !== 'string') {
        ignored.push(op.kind)
        continue
      }
      const local = findNodeById(doc, op.node_id)
      const original = baseline === undefined ? null : findNodeById(baseline.content_doc, op.node_id)
      const replacement = findNodeById(serverDraft.content_doc, op.node_id)
      if (!isPlainObject(local) || !isPlainObject(original) || !isPlainObject(replacement)
        || local.type !== 'goalReview' || replacement.type !== 'goalReview'
        || !deepEqual(local.attrs, original.attrs)) {
        ignored.push(op.kind)
        continue
      }
      const next = replaceNodeById(doc, op.node_id, { ...local, attrs: replacement.attrs })
      if (next === null) {
        ignored.push(op.kind)
        continue
      }
      doc = next
      changed = true
      applied.push(op.kind)
      continue
    }

    if (op.kind === 'replace_placeholder') {
      if (typeof op.node_id !== 'string') {
        ignored.push(op.kind)
        continue
      }
      const localNode = findNodeById(doc, op.node_id)
      if (localNode !== null) {
        // 本地已有同 ID 节点：只有它本身就是 AI 边界节点时才原位替换。
        // 若本地同 ID 的用户段落（ID 撞车或状态已分叉），替换会直接吃掉用户文字，
        // 因此一律判 ignored 交冲突处理，绝不为了「合并成功」覆盖用户输入。
        const localType = isPlainObject(localNode) ? localNode.type : null
        if (localType !== 'aiPlaceholder' && localType !== 'aiReply') {
          ignored.push(op.kind)
          continue
        }
        const replacement = findNodeById(serverDraft.content_doc, op.node_id)
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
        continue
      }
      // 本地没有这个节点：服务端新建的占位（prepare）。纯插入，不动任何本地内容。
      const plan = planInsert(doc, serverDraft.content_doc, baseline?.content_doc ?? null, op.node_id)
      if (plan === null) {
        ignored.push(op.kind)
        continue
      }
      const next = insertNodes(doc, plan)
      if (next === null) {
        ignored.push(op.kind)
        continue
      }
      doc = next
      changed = true
      applied.push(op.kind)
      continue
    }

    ignored.push(op.kind)
  }

  return { draft: changed ? { ...draft, content_doc: doc } : draft, applied, ignored, warnings }
}

/* ------------------------------------------------------- 辅助判定 */

/**
 * 本地草稿里是否已经含有服务端新增的占位节点。
 *
 * 供 UI 判断「prepare 的占位是否已经合并进当前草稿」——没有合并成功时不要
 * 显示「已插入占位」，也不要把 AI 结果当作已附着。
 */
export function hasNode(draft: NarrowDraft, nodeId: string): boolean {
  return findNodeById(draft.content_doc, nodeId) !== null
}

/** 顶层块文字（诊断 / 测试用，口径与后端 `_plain` 的基础部分一致）。 */
export function nodeText(node: unknown): string {
  return blockText(node)
}
