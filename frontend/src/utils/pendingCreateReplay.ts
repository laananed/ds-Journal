/**
 * 「首次创建响应丢失」的恢复执行（Stage 4 / S04-T06 与 S04-T02 交界）。
 *
 * 权威依据：`docs/stage4-api.md` §10「Journal 本地草稿恢复契约」、
 * `docs/stage4-architecture.md` §4 / §4.1、`docs/stage4-tasks.md` §3.3 / §3.7。
 *
 * 要解决的问题只有一句话：**POST 已经提交、响应丢了**，本地只剩「原创建键 +
 * 原首次 payload」，如果这时按当前草稿发一次新创建，服务器上就会出现两条记录。
 *
 * 因此恢复必须做到三件事，缺一不可：
 *
 * 1. 用**原 `client_create_id`**、**原首次 payload 逐字段**重放（不使用较新输入）；
 * 2. 重放拿到 id/revision 后，在**同一个会话**里用真实 CAS/PATCH 提交较新的输入；
 * 3. 任何一步不成立就停下并如实报告，绝不换键、绝不改写 payload。
 *
 * 实现方式：**一次原子打开**。`openSession` 同时收到「记录里的最新草稿」与
 * 「冻结的原首次请求」，会话核心把 `firstRequest` 挂在会话上——
 * `planWrite` 会优先按原键原 payload 发创建（即使草稿已经回到基线），
 * 创建成功后基线换成那次 payload，`drain` 紧接着按真实 `expected_revision`
 * 发 PATCH 提交最新输入。全程只有 T02 的一个按 typed key 串行的队列，
 * 没有第二套队列、没有第二套存储，也没有页面层的「先空草稿再塞内容」绕行。
 */

import {
  draftEquals,
  draftHasChanges,
  EditSessionRestoreError,
  type DocumentDraft,
  type EditSessionStore,
  type SaveTransport,
} from '../state/editSessions.ts'
import type { LocalJournalDraft } from '../state/localJournalDrafts.ts'
import {
  planReplay,
  writingSessionId,
  type ReplayRefusal,
} from './writingSession.ts'

export interface ReplayPendingCreateInput {
  /** 本地记录（含首次请求快照与最新未提交内容）。 */
  record: LocalJournalDraft
  store: EditSessionStore
  /** 页面使用的 Journal 传输层；与正常保存完全同一个实例。 */
  transport: SaveTransport
  /** 本标签身份：多标签各有独立草稿，不跨标签接管。 */
  tabId: string
  isSavable: (draft: DocumentDraft) => boolean
}

export type ReplayFailure =
  | ReplayRefusal
  /** 该草稿在本次会话里已经有输入（可能有未提交内容），不接管、不覆盖。 */
  | 'session_busy'
  /** 同一个创建键已被另一个会话占用（多标签 / 重复记录），不重复重放。 */
  | 'duplicate_key'
  /** 会话核心拒绝了这次恢复（键不一致 / 序号不成立 / 载荷不完整）。 */
  | 'restore_rejected'
  /** 重放创建本身失败（网络 / 409 等）。 */
  | 'create_failed'
  /** 创建成功，但较新输入的 PATCH 没成功（冲突或网络）。 */
  | 'patch_failed'

export interface ReplayPendingCreateResult {
  kind: 'created' | 'refused'
  sessionId: string
  draftId: string
  fileId: number | null
  revision: number | null
  /** 最新输入是否已经在服务器上（无差异时也视为已应用）。 */
  patchApplied: boolean
  reason: ReplayFailure | null
  /** 用户可读说明；不含正文。 */
  message: string
}

/**
 * 按原创建键与原首次 payload 重放一次创建，随后 PATCH 最新输入。
 *
 * 返回 `kind: 'created'` 只代表「服务器已经拿到这次创建」（`fileId` 非空）；
 * `patchApplied === false` 表示较新输入还没保存成功，调用方必须如实显示并保留草稿。
 */
export async function replayPendingCreate(
  input: ReplayPendingCreateInput,
): Promise<ReplayPendingCreateResult> {
  const { record, store, transport, tabId, isSavable } = input
  const draftId = record.draft_id
  const sessionId = writingSessionId(draftId)
  const base = {
    sessionId,
    draftId,
    fileId: null as number | null,
    revision: null as number | null,
    patchApplied: false,
  }
  const refuse = (reason: ReplayFailure, message: string): ReplayPendingCreateResult => ({
    ...base,
    kind: 'refused',
    reason,
    message,
  })

  // 1) 记录自身是否还能当作「同一次创建」：身份、完整性、日期/类型、序号、可提交性。
  const plan = planReplay(record)
  if (plan.kind === 'unusable') return refuse(plan.reason, plan.message)

  // 2) 同一草稿身份已经开会话。
  const existing = store.getSession(sessionId)
  if (existing !== null) {
    if (existing.fileId !== null) {
      // 本次会话里已经创建成功：幂等返回，绝不重复发创建。
      const pending = draftHasChanges(existing.draft, existing.baseline)
      return {
        ...base,
        kind: 'created',
        fileId: existing.fileId,
        revision: existing.revision,
        patchApplied: !pending,
        reason: pending ? 'patch_failed' : null,
        message: pending
          ? '这篇已经在本次会话里创建成功，但还有输入没有保存到服务器。'
          : '这篇已经在本次会话里创建成功，没有重复提交。',
      }
    }
    // 会话里已经有用户输入：接管会覆盖现场内容，拒绝。
    const untouched = existing.inFlight === null
      && existing.inputSeq === 0
      && draftEquals(existing.draft, existing.baseline)
    if (!untouched) {
      return refuse('session_busy', '这份草稿已经在本次会话里编辑过，请先在那份会话里处理，避免两边同时提交。')
    }
    // 空白占位会话如果已经绑定了另一个创建键，说明它是另一次创建意图。
    if (existing.firstRequest !== null
      && existing.firstRequest.client_create_id !== plan.request.client_create_id) {
      return refuse('duplicate_key', '这份草稿已经绑定另一次创建请求，不能替换成记录里的创建键。')
    }
  }

  // 3) 同一个创建键不能被两个会话同时重放（多标签 / 重复记录）。
  const duplicate = store.listSessions().find((item) => item.sessionId !== sessionId
    && (item.createKey === plan.request.client_create_id
      || item.firstRequest?.client_create_id === plan.request.client_create_id))
  if (duplicate !== undefined) {
    return refuse('duplicate_key', '另一个标签页正在处理同一次创建，请先在那边确认结果，避免重复创建。')
  }

  // 4) 原子打开：最新草稿 + 冻结的原首次请求 + 延续的输入序号。
  try {
    store.openSession({
      sessionId,
      type: 'journal',
      tabId,
      draftId,
      draft: plan.latest,
      createKey: plan.request.client_create_id,
      extras: plan.request.extras,
      firstRequest: plan.request,
      resumedInputSeq: plan.latestSeq,
      transport,
      isSavable,
    })
  } catch (error: unknown) {
    if (error instanceof EditSessionRestoreError) {
      return refuse('restore_rejected', `恢复被拒绝：${error.message}`)
    }
    throw error
  }

  // 5) 一次排空：创建（原键原 payload）→ CAS PATCH（最新输入），同一个队列。
  //    `drain` 是有界屏障：若重放期间用户又输入了，它会返回 `queued` 而不越界提交，
  //    这里再排一次（序号已前进），直到不再有新输入或状态被阻塞。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const step = await store.saveToSequence(sessionId)
    if (step.kind !== 'queued') break
  }

  const session = store.getSession(sessionId)
  if (session === null || session.fileId === null) {
    const detail = session?.error ?? ''
    return refuse('create_failed', detail === ''
      ? '重放创建没有成功，本地草稿仍然保留；可以稍后重试或另存为新草稿。'
      : `重放创建没有成功：${detail}。本地草稿仍然保留。`)
  }

  const patched = !draftHasChanges(session.draft, session.baseline)
  return {
    ...base,
    kind: 'created',
    fileId: session.fileId,
    revision: session.revision,
    patchApplied: patched,
    reason: patched ? null : 'patch_failed',
    message: patched
      ? '已按原请求找回这篇记录，本地内容已保存到服务器。'
      : `已按原请求找回这篇记录，但较新的输入还没有保存：${session.error === '' ? '请稍后重试' : session.error}。本地内容仍在编辑器里。`,
  }
}
