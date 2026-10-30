/**
 * Insight 的会话传输适配（Stage 4 / S04-T11）。
 *
 * 与 T02 的 `journalSession.ts` 同构：`state/editSessions.ts`（会话核心）与
 * 具体 API 解耦，这一层只负责把会话里的 `DocumentDraft` 映射成
 * `docs/stage4-api.md` §3 的 Insight 创建 / PATCH 请求，并把响应折回 `ServerFile`。
 * 会话核心、写队列与 CAS 全部复用 T02，不新建第二套。
 *
 * 三条边界（T11 明确要求）：
 *
 * 1. **只提交 `content_doc`**：创建与更新都不发送旧 `content` / `content_blocks`，
 *    因此不存在「用旧写入口绕过 JSON 作者校验」的路径（API §2）。
 * 2. **旧格式不自动转换**：`legacy_conversion_required` 明确报成不可重试的失败
 *    （422 + 说明），而不是伪装成版本冲突，避免用户以为「换个版本重试就好」。
 * 3. **不为本地草稿扩域**：API §10 的本地草稿契约只覆盖 Journal，这里不写
 *    IndexedDB，也不复制第二套请求管理器。
 */

import { createInsight, updateInsight } from '../api/insights.ts'
import type { Insight } from '../types/insight.ts'
import type { DocumentDraft, SaveTransport, ServerFile } from './editSessions.ts'
import { insightCreatePayload, insightToDraft, insightUpdatePayload } from '../utils/insightDraft.ts'

/**
 * 会话表的 `tabId` 占位。
 *
 * 多标签本地草稿按 `tabId` 隔离，但 Insight 本期不落本地草稿（API §10），
 * 因此这里用一个固定标识；将来若扩展到 Insight 本地恢复，必须换成真实标签身份。
 */
export const INSIGHT_SESSION_TAB = 'insight'

/** 已有文件：同一文件在多个页面/面板间复用同一个会话。 */
export function insightSessionId(id: number): string {
  return `insight:${id}`
}

/** 新建草稿：稳定草稿身份（取得服务器 id 后会话内部改队列键，不重建会话）。 */
export function insightDraftSessionId(draftId: string): string {
  return `insight:draft:${draftId}`
}

/**
 * 旧文等价转换节点的稳定 ID。
 *
 * 服务端要求 `legacyText.id` 是 UUID，且该次转换必须「单个 user legacyText、
 * `raw_text` 与旧 `content` 逐字相同」。用「按文件 id 派生」而不是每次随机：
 * 同一文件重复打开得到同一份转换文档，转换请求重放时 payload 完全一致。
 */
export function legacyNodeIdFor(fileId: number): string {
  return `00000000-0000-4000-8000-${String(fileId).padStart(12, '0')}`
}

/** 后端详情 → 会话草稿（legacy 用等价转换文档先只读呈现）。 */
export function insightToDraftForSession(insight: Insight): DocumentDraft {
  return insightToDraft(insight, legacyNodeIdFor(insight.id))
}

/** 后端详情 → `ServerFile`（会话只关心身份、版本与权威草稿）。 */
export function insightToServerFile(insight: Insight): ServerFile {
  return { id: insight.id, revision: insight.revision, draft: insightToDraftForSession(insight) }
}

function isLegacyConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { code?: unknown }).code === 'legacy_conversion_required'
}

/**
 * 旧格式写保护：向带 blocks 的旧文件写 `content_doc`、或用非等价的文档
 * 覆盖 `content_doc IS NULL` 的文件，服务端返回 409 `legacy_conversion_required`。
 * 这不是版本冲突，重试不会成功，因此转成 422 让会话进入 `failed` 并保留草稿。
 */
function translateLegacy(error: unknown): never {
  const message = error instanceof Error ? error.message : '该文件仍是旧格式'
  throw Object.assign(
    new Error(`该文件仍是旧格式，未写入新正文（需先完成等价转换）：${message}`),
    { status: 422 },
  )
}

export interface InsightTransportOptions {
  /** 注入点：纯逻辑测试或离线验证时替换请求实现。 */
  create?: (payload: Parameters<typeof createInsight>[0]) => Promise<Insight>
  update?: (id: number, payload: Parameters<typeof updateInsight>[1]) => Promise<Insight>
  /** 每次服务器确认后的完整响应；页面据此更新详情/列表，不额外 GET。 */
  onSaved?: (insight: Insight) => void
}

/** 会话传输层：创建冻结首次 payload，更新只提交变化字段 + CAS 版本。 */
export function insightTransport(options: InsightTransportOptions = {}): SaveTransport {
  const createRequest = options.create ?? createInsight
  const updateRequest = options.update ?? updateInsight
  return {
    async create(request) {
      try {
        const saved = await createRequest(insightCreatePayload(request.draft, request.client_create_id))
        options.onSaved?.(saved)
        return insightToServerFile(saved)
      } catch (error: unknown) {
        if (isLegacyConflict(error)) translateLegacy(error)
        throw error
      }
    },
    async update(request) {
      try {
        const saved = await updateRequest(
          request.file_id,
          insightUpdatePayload(request.patch, request.expected_revision),
        )
        options.onSaved?.(saved)
        return insightToServerFile(saved)
      } catch (error: unknown) {
        if (isLegacyConflict(error)) translateLegacy(error)
        throw error
      }
    },
  }
}
