/**
 * 应用级 AI 请求状态与恢复（Stage 4 / S04-T02）。
 *
 * 权威依据：`docs/stage4-architecture.md` §4（`state/aiRequests.ts` 持有在途
 * Promise、查询、恢复入口与结果；页面卸载不取消实际执行）、
 * `docs/stage4-api.md` §10（恢复索引只存 ID/kind/源身份）、产品 §10。
 *
 * 这里**不实现** T08 的 Go Deeper / Minds 业务（prepare/execute/apply 与占位应用
 * 归 T08、T09）。本模块只解决「请求活得比页面久」这件事：
 *
 * 1. 同一 `request_id` 只发送一次，重复启动返回既有状态（幂等，不重复付费）；
 * 2. 页面卸载 / 切页不影响在途请求，结果留在应用级表里，回来时直接读；
 * 3. 关页重开后只按恢复索引**查询**已登记请求，不自动重发、不自动换键；
 * 4. 恢复索引写入 localStorage 的只有 `request_id` / `kind` / 源 typed 身份，
 *    绝不写正文、问题、提示词或结果。
 *
 * 纯逻辑 + 注入存储/时钟，可用
 * `node --experimental-strip-types src/state/aiRequests.test.ts` 测试。
 */

import {
  addRecoveryEntry,
  applyAiQuery,
  applyAiResponse,
  applyAiTransportError,
  beginAiCall,
  initialAiCallState,
  planRecovery,
  readRecoveryIndex,
  removeRecoveryEntry,
  writeRecoveryIndex,
  type AiCallKind,
  type AiCallState,
  type AiNoopLike,
  type AiRecoveryEntry,
  type AiRequestLike,
  type AiTransportFailure,
  type AiSourceRef,
  type RecoveryPlan,
  type StorageLike,
} from '../utils/aiRequestState.ts'

/** 一条应用级请求记录：Promise 不再挂在组件上。 */
export interface AiRequestRecord {
  requestId: string
  kind: AiCallKind
  source: AiSourceRef
  state: AiCallState
  startedAt: number
  /** 请求是否已经落定（成功 / 失败 / 未知都算落定）。 */
  settled: boolean
}

export interface StartAiRequestInput {
  requestId: string
  kind: AiCallKind
  source: AiSourceRef
  /** 真正发送；本模块只负责保护它的生命周期与幂等。 */
  send: () => Promise<AiRequestLike | AiNoopLike>
}

/** 恢复一条入口时的查询器；返回 `'missing'` 表示服务端没有这个请求。 */
export type AiRequestLoader = (requestId: string) => Promise<AiRequestLike | 'missing'>

export interface RestoreResult {
  entry: AiRecoveryEntry
  plan: RecoveryPlan
  state: AiCallState | null
}

export interface AiRequestStoreOptions {
  storage?: StorageLike | null
  now?: () => number
  /** 初始恢复索引；省略时从 storage 读。 */
  initialEntries?: AiRecoveryEntry[]
}

export interface AiRequestStore {
  subscribe(listener: () => void): () => void
  getVersion(): number
  get(requestId: string): AiRequestRecord | null
  list(): AiRequestRecord[]
  findBySource(source: AiSourceRef | null): AiRequestRecord | null
  recoveryEntries(): AiRecoveryEntry[]
  start(input: StartAiRequestInput): Promise<AiCallState>
  /** 只查询已登记请求；不发送新请求、不产生新费用。 */
  refresh(requestId: string, load: AiRequestLoader): Promise<AiCallState>
  /** 关页重开后按恢复索引列出口；404 清除失效入口，不重建。 */
  restore(load: AiRequestLoader): Promise<RestoreResult[]>
  /** 传输层错误并入状态（503 未调用、无响应则 unknown）。 */
  noteTransportFailure(requestId: string, failure: AiTransportFailure): AiCallState
  forget(requestId: string): void
}

function sameSource(left: AiSourceRef | null, right: AiSourceRef | null): boolean {
  if (left === null || right === null) return false
  return left.type === right.type && left.id === right.id
}

export function createAiRequestStore(options: AiRequestStoreOptions = {}): AiRequestStore {
  const storage = options.storage ?? null
  const now = options.now ?? (() => Date.now())
  const records = new Map<string, AiRequestRecord>()
  const listeners = new Set<() => void>()
  let entries: AiRecoveryEntry[] = options.initialEntries ?? readRecoveryIndex(storage)
  let version = 0

  function emit(): void {
    version += 1
    for (const listener of listeners) listener()
  }

  function persist(): void {
    writeRecoveryIndex(storage, entries)
  }

  function put(record: AiRequestRecord): AiRequestRecord {
    records.set(record.requestId, record)
    emit()
    return record
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getVersion() {
      return version
    },
    get(requestId) {
      return records.get(requestId) ?? null
    },
    list() {
      return Array.from(records.values())
    },
    findBySource(source) {
      let found: AiRequestRecord | null = null
      for (const record of records.values()) {
        if (sameSource(record.source, source)) found = record
      }
      return found
    },
    recoveryEntries() {
      return [...entries]
    },

    /**
     * 发起一次请求。
     *
     * 恢复索引**先写后发**：即使随后进程被杀，重开也能按 id 查回状态，
     * 不需要猜测或重发。同一 request_id 重复调用只返回既有状态。
     */
    async start(input) {
      const existing = records.get(input.requestId)
      if (existing !== undefined) return existing.state

      // 索引里只放身份三件套；UUID 在发送前生成并登记。
      entries = addRecoveryEntry(entries, {
        requestId: input.requestId,
        kind: input.kind,
        source: input.source,
      })
      persist()

      // 状态机沿用 `utils/aiRequestState` 的语义；来源身份以记录里的
      // `RecoverySource` 为准（可以包含 Insight），因此这里直接构造 sending 态。
      const started: AiCallState = beginAiCall(initialAiCallState(), {
        requestId: input.requestId,
        source: input.source,
      })
      put({
        requestId: input.requestId,
        kind: input.kind,
        source: { type: input.source.type, id: input.source.id },
        state: started,
        startedAt: now(),
        settled: false,
      })

      try {
        const response = await input.send()
        const next = applyAiResponse(records.get(input.requestId)?.state ?? started, response)
        put({
          requestId: input.requestId,
          kind: input.kind,
          source: { type: input.source.type, id: input.source.id },
          state: next,
          startedAt: records.get(input.requestId)?.startedAt ?? now(),
          settled: true,
        })
        // 已有确定结果或零调用：不再需要恢复入口。
        if (next.phase === 'applied' || next.phase === 'noop' || next.phase === 'blocked') {
          entries = removeRecoveryEntry(entries, input.requestId)
          persist()
        }
        return next
      } catch (error: unknown) {
        const status = typeof error === 'object' && error !== null && 'status' in error
          && typeof (error as { status: unknown }).status === 'number'
          ? (error as { status: number }).status : null
        const message = error instanceof Error && error.message !== '' ? error.message : 'AI 调用失败'
        const next = applyAiTransportError(records.get(input.requestId)?.state ?? started, {
          status,
          message,
          requestId: input.requestId,
        })
        put({
          requestId: input.requestId,
          kind: input.kind,
          source: { type: input.source.type, id: input.source.id },
          state: next,
          startedAt: records.get(input.requestId)?.startedAt ?? now(),
          settled: true,
        })
        // 只有「可能已经调用过模型」的失败才需要恢复入口；
        // 503/429/4xx 明确没有产生调用，留着入口只会误导用户去查询。
        if (!next.mayHaveCharged) {
          entries = removeRecoveryEntry(entries, input.requestId)
          persist()
        }
        return next
      }
    },

    async refresh(requestId, load) {
      const record = records.get(requestId)
      if (record === undefined) {
        return {
          ...initialAiCallState(),
          phase: 'unknown',
          message: '本地没有这次请求的记录，已停止自动重试；请手动核对或重新发起。',
        }
      }
      let result: AiRequestLike | 'missing'
      try {
        result = await load(requestId)
      } catch (error: unknown) {
        const failure: AiTransportFailure = {
          status: null,
          message: error instanceof Error ? error.message : '查询失败',
          requestId,
        }
        const next = applyAiTransportError(record.state, failure)
        put({ ...record, state: next, settled: false })
        return next
      }
      const next = applyAiQuery({ ...record.state, recovered: record.state.recovered }, result)
      put({
        ...record,
        state: { ...next, recovered: record.state.recovered },
        settled: result !== 'missing' && result.status !== 'pending',
      })
      if (result === 'missing') {
        entries = removeRecoveryEntry(entries, requestId)
        persist()
      }
      return next
    },

    async restore(load) {
      const results: RestoreResult[] = []
      for (const entry of [...entries]) {
        let detail: AiRequestLike | 'missing'
        try {
          detail = await load(entry.requestId)
        } catch {
          // 查询失败（离线 / 5xx）：保留入口，显示为「状态未知」，绝不自动重发。
          const state: AiCallState = {
            ...initialAiCallState(),
            phase: 'unknown',
            requestId: entry.requestId,
            source: entry.source,
            mayHaveCharged: true,
            recovered: true,
            message: '重开时没能查到这次请求的状态（可能离线）。已保留入口，不会自动重发。',
          }
          put({
            requestId: entry.requestId,
            kind: entry.kind,
            source: entry.source,
            state,
            startedAt: now(),
            settled: false,
          })
          results.push({ entry, plan: { action: 'show' }, state })
          continue
        }
        const plan = planRecovery(entry, detail)
        if (plan.action === 'drop') {
          entries = removeRecoveryEntry(entries, entry.requestId)
          persist()
          results.push({ entry, plan, state: null })
          continue
        }
        const state = applyAiQuery(
          { ...initialAiCallState(), requestId: entry.requestId, source: entry.source, recovered: true },
          detail,
        )
        put({
          requestId: entry.requestId,
          kind: entry.kind,
          source: entry.source,
          state: { ...state, recovered: true },
          startedAt: now(),
          settled: detail !== 'missing' && detail.status !== 'pending',
        })
        results.push({ entry, plan, state: { ...state, recovered: true } })
      }
      return results
    },

    noteTransportFailure(requestId, failure) {
      const record = records.get(requestId)
      const base = record?.state ?? { ...initialAiCallState(), requestId }
      const next = applyAiTransportError(base, failure)
      if (record !== undefined) put({ ...record, state: next, settled: next.phase !== 'polling' })
      return next
    },

    forget(requestId) {
      records.delete(requestId)
      entries = removeRecoveryEntry(entries, requestId)
      persist()
      emit()
    },
  }
}

/** 应用级单例：AI 请求不随页面挂载 / 卸载消失。 */
function browserStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

export const aiRequestStore: AiRequestStore = createAiRequestStore({ storage: browserStorage() })
