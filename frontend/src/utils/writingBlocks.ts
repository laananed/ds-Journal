/**
 * 结构化正文（块）纯逻辑（Stage 3 / S3-T04）。
 *
 * 本文件**不依赖 React、不发请求**，因此可以用
 * `node --experimental-strip-types src/utils/writingBlocks.test.ts` 直接测试；
 * 编辑/阅读渲染在 `../components/{WritingEditor,WritingContent,AiReplyBlock}.tsx`。
 *
 * 权威来源：
 * - `docs/stage3-api.md` §2：块形状、content 与 content_blocks 互斥、
 *   客户端只能新增/编辑 user、编辑已有 ai_summary.text，其余保持；
 * - `docs/stage3-architecture.md` §3：`content_blocks` 非 NULL 即权威正文、
 *   用户段逐字输出、AI 段身份不可篡改、封口与空尾续写段；
 * - 后端 `backend/app/writing/service.py`：`project_blocks` / `validate_blocks`。
 *
 * 这里的两件事必须与后端**逐字对齐**，否则前端放行的请求会被 422/409 拒绝：
 *
 * 1. `projectBlocks` 必须等于后端 `project_blocks`（决定阅读投影与长度校验）；
 * 2. `validateBlocksForSave` 的规则必须镜像后端 `validate_blocks`
 *   （唯一 id、既有段不可重排、客户端不可新增 AI 段、身份不可改、
 *   ai_reply 文本不可改、AI 段删除须走专用接口、空续写段位置）。
 */

import type { AiBlock, Block, UserBlock } from '../types/writing.ts'
import { countCodePoints, isBlankText } from './contentValidation.ts'

/** 块的可读标签（仅用于界面，不参与提交）。 */
export const BLOCK_LABELS: Record<Block['kind'], string> = {
  user: '正文',
  ai_reply: 'AI 回复',
  ai_summary: 'AI 复盘',
}

/** 类型收窄：用户正文段。 */
export function isUserBlock(block: Block): block is UserBlock {
  return block.kind === 'user'
}

/** 类型收窄：AI 段（回复或总结）。 */
export function isAiBlock(block: Block): block is AiBlock {
  return block.kind === 'ai_reply' || block.kind === 'ai_summary'
}

/** 生成稳定块 id；优先用密码学随机 UUID，退化为时间戳+随机串。 */
export function newBlockId(): string {
  const globalCrypto: Crypto | undefined = globalThis.crypto
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID()
  }
  return `block-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 新建一个用户段。 */
export function newUserBlock(text = ''): UserBlock {
  return { id: newBlockId(), kind: 'user', text }
}

/**
 * 旧正文（`content_blocks` 为 NULL）的**等价转换**：
 * 把整段历史正文原样放进**一个** user 段，不 trim、不改空白、不改 Unicode。
 *
 * 这样首次结构化保存提交的 `content_blocks` 投影与旧 `content` 完全一致，
 * 后端会走「等价转换」分支跳过长度重校验（见 `validate_blocks`），
 * 因此旧超长正文也不会被截断或重新拒绝。
 */
export function legacyBlocksFromContent(content: string): Block[] {
  return [newUserBlock(content)]
}

/**
 * 块 → 阅读投影。**必须与后端 `project_blocks` 逐字一致**：
 *
 * - user：`text` 原样拼接（不加段落、不 trim）；
 * - ai_reply：`\n\n> AI 回复\n` + 每行加 `> ` 前缀 + `\n\n`；
 * - ai_summary：`\n\n---\n\nAI 复盘\n\n` + `text`（不加尾随换行）。
 */
export function projectBlocks(blocks: Block[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      parts.push(block.text)
    } else if (block.kind === 'ai_reply') {
      const lines = block.text.split('\n')
      parts.push(`\n\n> AI 回复\n${lines.map((line) => `> ${line}`).join('\n')}\n\n`)
    } else {
      parts.push(`\n\n---\n\nAI 复盘\n\n${block.text}`)
    }
  }
  return parts.join('')
}

/** 块数组判等：顺序、id、kind、text、request_id 全部逐字段比较。 */
export function blocksEqual(a: Block[] | null, b: Block[] | null): boolean {
  if (a === null || b === null) return a === b
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left.id !== right.id || left.kind !== right.kind || left.text !== right.text) return false
    if (left.kind !== 'user' && right.kind !== 'user' && left.request_id !== right.request_id) return false
  }
  return true
}

/** 按 id 取块。 */
export function findBlock(blocks: Block[], id: string): Block | undefined {
  return blocks.find((block) => block.id === id)
}

/** 列出所有 AI 段 id（用于判断哪些段须通过专用接口删除）。 */
export function aiBlockIds(blocks: Block[]): string[] {
  return blocks.filter(isAiBlock).map((block) => block.id)
}

/**
 * 改写某一段的文本。
 *
 * 只有 **user** 与 **ai_summary** 可编辑（`docs/stage3-api.md` §2）；
 * `ai_reply` 文本不可编辑，传入时**原样返回**（不抛错，由调用方按 UI 约束避免）。
 * 任何情况下都不改变 `id` / `kind` / `request_id`。
 */
export function setBlockText(blocks: Block[], id: string, text: string): Block[] {
  return blocks.map((block) => {
    if (block.id !== id) return block
    if (block.kind === 'ai_reply') return block
    if (block.text === text) return block
    return { ...block, text }
  })
}

/** 该段是否允许通过界面删除（只有 AI 段可以，用户段走文本编辑）。 */
export function canDeleteBlock(block: Block): boolean {
  return isAiBlock(block)
}

/** 移除指定 AI 段；传入 user 段 id 时原样返回（用户段不能被「删除」）。 */
export function removeAiBlock(blocks: Block[], id: string): Block[] {
  const target = findBlock(blocks, id)
  if (target === undefined || !canDeleteBlock(target)) return blocks
  return blocks.filter((block) => block.id !== id)
}

/** 是否存在至少一个非空白的 user 段。 */
export function hasNonBlankUserBlock(blocks: Block[]): boolean {
  return blocks.some((block) => block.kind === 'user' && !isBlankText(block.text))
}

/**
 * 正文是否满足后端的「普通保存至少有有效用户正文」规则
 * （`validate_blocks`：`has_user || has_saved_summary`）。
 *
 * `serverBlockIds` 是**服务器上已存在**的块 id 集合：
 * 只有服务器已存在的非空 `ai_summary` 才能单独构成有效正文，
 * 本地伪造/新增的总结不被承认。
 */
export function blocksBodySavable(blocks: Block[], serverBlockIds: ReadonlySet<string>): boolean {
  if (hasNonBlankUserBlock(blocks)) return true
  return blocks.some(
    (block) => block.kind === 'ai_summary' && serverBlockIds.has(block.id) && !isBlankText(block.text),
  )
}

/** 结构校验错误码（镜像后端 `validate_blocks` 的各类拒绝原因）。 */
export type BlocksValidationCode =
  | 'duplicate_id'
  | 'reordered'
  | 'new_ai_block'
  | 'kind_changed'
  | 'ai_identity_changed'
  | 'ai_reply_edited'
  | 'ai_block_removed'
  | 'empty_continuation'

export interface BlocksValidationError {
  code: BlocksValidationCode
  message: string
}

function fail(code: BlocksValidationCode, message: string): BlocksValidationError {
  return { code, message }
}

/**
 * 镜像后端 `validate_blocks` 的结构校验。
 *
 * 后端对「旧正文等价转换」有一个例外分支（`old_blocks is None and 单段空 user
 * and old_content == ''`）。前端**不在这里重复**该例外：调用方在
 * `isUpdateSavable` 中先比较阅读投影，投影未变时整体跳过正文校验，
 * 等价覆盖了同一个场景，且不会误放行真正的空正文。
 *
 * 返回 `undefined` 表示结构合法；正文长度与「至少有效用户正文」由调用方
 * 分别用 `countCodePoints` / `blocksBodySavable` 判定。
 */
export function validateBlocksForSave(
  blocks: Block[],
  serverBlocks: Block[] | null,
): BlocksValidationError | undefined {
  const ids = blocks.map((block) => block.id)
  if (new Set(ids).size !== ids.length) {
    return fail('duplicate_id', '块 id 必须唯一')
  }
  const serverList = serverBlocks ?? []
  const serverById = new Map(serverList.map((block) => [block.id, block]))
  const serverOrder = serverList.filter((block) => ids.includes(block.id)).map((block) => block.id)
  const keptServerOrder = ids.filter((id) => serverById.has(id))
  if (keptServerOrder.join('|') !== serverOrder.join('|')) {
    return fail('reordered', '既有段不能重排')
  }
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const previous = serverById.get(block.id)
    if (previous === undefined) {
      if (block.kind !== 'user') {
        return fail('new_ai_block', '客户端不能新增 AI 段')
      }
      if (block.text === '' && (index !== blocks.length - 1 || index === 0 || blocks[index - 1].kind !== 'user')) {
        return fail('empty_continuation', '空续写段必须紧跟在最后的用户段之后')
      }
      continue
    }
    if (previous.kind !== block.kind) {
      return fail('kind_changed', '既有段的 kind 不能改变')
    }
    if (!isUserBlock(previous) && !isUserBlock(block)) {
      if (previous.request_id !== block.request_id) {
        return fail('ai_identity_changed', 'AI 段的来源身份不能改变')
      }
      if (previous.kind === 'ai_reply' && previous.text !== block.text) {
        return fail('ai_reply_edited', 'AI 回复不能编辑')
      }
    }
  }
  if (serverList.some((block) => block.kind !== 'user' && !ids.includes(block.id))) {
    return fail('ai_block_removed', '删除 AI 段必须使用专用接口')
  }
  return undefined
}

/**
 * 封口 / 空尾续写段：**只允许在最后一段是非空 user 段之后**追加一个空 user 段。
 *
 * - 末尾已经是空 user 段 → 原样返回（幂等）；
 * - 末尾是 AI 段 → 原样返回：客户端不擅自制造「AI 段后跟空 user 段」这种
 *   后端会拒绝的结构（`validate_blocks` 要求空续写段的前一段是 user）。
 *   T07 的正确顺序是「AI 插入前先封口」，回复由服务端插在既有边界上；
 * - 空数组 → 原样返回。
 */
export function appendContinuation(blocks: Block[]): Block[] {
  const last = blocks[blocks.length - 1]
  if (last === undefined) return blocks
  if (last.kind === 'user' && last.text === '') return blocks
  if (last.kind !== 'user') return blocks
  return [...blocks, newUserBlock('')]
}

/**
 * 删除 AI 段成功、重读服务器详情后，把「服务器基线」与「本地较新草稿」安全合并。
 *
 * - `server === null`（服务器不是结构化文件）→ 返回 `null`；
 * - 服务器已删除的段（AI 段）从草稿中剔除，避免再次提交时因「客户端删除 AI 段」被拒；
 * - 用户段保留本地输入（可能是在删除请求期间继续打的字）；
 * - AI 段一律以服务器文本与身份为准（客户端本就不可编辑）。
 */
export function pruneBlocksToServer(draft: Block[] | null, server: Block[] | null): Block[] | null {
  if (server === null) return null
  if (draft === null) return server
  const byId = new Map(server.map((block) => [block.id, block]))
  const result: Block[] = []
  for (const block of draft) {
    const onServer = byId.get(block.id)
    if (onServer === undefined) continue
    result.push(block.kind === 'user' ? block : onServer)
  }
  return result
}

/** 投影的 Unicode 码点数（用于界面提示「当前字数」）。 */
export function projectionLength(blocks: Block[]): number {
  return countCodePoints(projectBlocks(blocks))
}

/** 阅读渲染的一个片段：连续 user 段合并成一段，AI 段各自独立。 */
export type ReadingRun =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; block: AiBlock }

/**
 * 把有序块分组为阅读片段。
 *
 * **连续 user 段合并为一段**（`docs/stage3-architecture.md` §3「阅读时 user 跨段还原」），
 * 这样跨 textarea 的 Markdown 连续语法（列表、代码块、引用）在阅读时能重新连起来；
 * AI 段保持独立，以便单独加蓝色竖线与来源标签，同时天然打断 Markdown 语法。
 */
export function groupReadingRuns(blocks: Block[]): ReadingRun[] {
  const runs: ReadingRun[] = []
  for (const block of blocks) {
    if (block.kind === 'user') {
      const last = runs[runs.length - 1]
      if (last !== undefined && last.kind === 'user') {
        runs[runs.length - 1] = { kind: 'user', text: last.text + block.text }
      } else {
        runs.push({ kind: 'user', text: block.text })
      }
      continue
    }
    runs.push({ kind: 'ai', block })
  }
  return runs
}
