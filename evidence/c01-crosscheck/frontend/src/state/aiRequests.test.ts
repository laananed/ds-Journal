/**
 * 应用级 AI 请求状态的纯逻辑测试（Stage 4 / S04-T02）。
 *
 *   node --experimental-strip-types src/state/aiRequests.test.ts
 *
 * 只验证 T02 的责任边界：请求活得比页面久、同键不重复发送、
 * 恢复索引进存身份字段、未知状态不自动重发、跨文件结果不串。
 * Go Deeper / Minds 的业务结果与占位应用归 T08/T09，这里不冒充。
 */

import { createAiRequestStore } from './aiRequests.ts'
import {
  RECOVERY_STORAGE_KEY,
  type AiRecoveryEntry,
  type AiRequestLike,
  type StorageLike,
} from '../utils/aiRequestState.ts'

let passed = 0

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(`失败：${label}`)
  passed += 1
}

function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const actualText = JSON.stringify(actual)
  const expectedText = JSON.stringify(expected)
  check(actualText === expectedText, `${label}：期望 ${expectedText}，实际 ${actualText}`)
}

const REQUEST_A = '11111111-1111-4111-8111-111111111111'
const REQUEST_B = '22222222-2222-4222-8222-222222222222'
const SOURCE_A = { type: 'journal', id: 7 } as const
const SOURCE_B = { type: 'journal', id: 8 } as const

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] },
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function applied(requestId: string, reply = 'AI 回复'): AiRequestLike {
  return {
    request_id: requestId,
    status: 'applied',
    reply,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, unknown_subcalls: 0, search_requests: 0 },
    web_status: 'not_needed',
    citations: [],
  }
}

/* --------------------------------------------- 1. 同键只发一次 + 先登记后发送 */

async function testStartIsIdempotentAndIndexesFirst(): Promise<void> {
  const storage = memoryStorage()
  const store = createAiRequestStore({ storage })
  let sends = 0
  let indexAtSendTime = ''

  const first = store.start({
    requestId: REQUEST_A,
    kind: 'local',
    source: SOURCE_A,
    async send() {
      sends += 1
      indexAtSendTime = storage.data[RECOVERY_STORAGE_KEY] ?? ''
      return applied(REQUEST_A)
    },
  })
  const state = await first
  expectEqual(sends, 1, '首次调用只发送一次')
  check(indexAtSendTime.includes(REQUEST_A), '恢复索引在发送前已落盘（丢响应也能查回 id）')
  expectEqual(state.phase, 'applied', '结果进入 applied')
  expectEqual(state.usage?.total_tokens, 15, '保留计量')

  // 同一 request_id 再启动：返回既有状态，不重复付费。
  const again = await store.start({
    requestId: REQUEST_A,
    kind: 'local',
    source: SOURCE_A,
    async send() {
      sends += 1
      return applied(REQUEST_A)
    },
  })
  expectEqual(sends, 1, '同一 request_id 不重复发送')
  expectEqual(again.phase, 'applied', '重复启动返回既有状态')

  // applied 之后不再保留恢复入口。
  expectEqual(store.recoveryEntries(), [], 'applied 后清理恢复入口')
}

/* ------------------------------------------------ 2. 切页不影响在途请求 */

async function testNavigateAwayKeepsRequest(): Promise<void> {
  const storage = memoryStorage()
  const store = createAiRequestStore({ storage })
  const pending = deferred<AiRequestLike>()
  const started = store.start({
    requestId: REQUEST_A,
    kind: 'local',
    source: SOURCE_A,
    send: () => pending.promise,
  })

  // 页面卸载：没有任何订阅者，但请求仍在应用级表里。
  const unsubscribe = store.subscribe(() => {})
  unsubscribe()
  expectEqual(store.get(REQUEST_A)?.state.phase, 'sending', '切页后请求仍在途')
  expectEqual(store.get(REQUEST_A)?.settled, false, '切页不会把请求标成已结束')

  pending.resolve(applied(REQUEST_A, '切页后才回来的回复'))
  const state = await started
  expectEqual(state.phase, 'applied', '切页后仍然收到结果')
  expectEqual(store.get(REQUEST_A)?.state.reply, '切页后才回来的回复', '回来时可直接读到结果')
}

/* ------------------------------------------------------ 3. 跨文件隔离 */

async function testCrossFileIsolation(): Promise<void> {
  const storage = memoryStorage()
  const store = createAiRequestStore({ storage })
  const a = deferred<AiRequestLike>()
  const b = deferred<AiRequestLike>()

  const startedA = store.start({ requestId: REQUEST_A, kind: 'local', source: SOURCE_A, send: () => a.promise })
  const startedB = store.start({ requestId: REQUEST_B, kind: 'local', source: SOURCE_B, send: () => b.promise })

  // B 先返回、A 后失败：两个文件的状态互不影响。
  b.resolve(applied(REQUEST_B, 'B 文件的回复'))
  await startedB
  a.reject(Object.assign(new Error('上游超时'), { status: 504 }))
  await startedA

  expectEqual(store.findBySource(SOURCE_A)?.state.phase, 'polling', 'A 的 5xx 转查询状态')
  expectEqual(store.findBySource(SOURCE_A)?.state.mayHaveCharged, true, 'A 可能已计费')
  expectEqual(store.findBySource(SOURCE_B)?.state.phase, 'applied', 'B 保持自己的结果')
  expectEqual(store.findBySource(SOURCE_B)?.state.reply, 'B 文件的回复', 'B 的结果没有被 A 覆盖')
  expectEqual(store.list().length, 2, '两个文件各一条记录')
}

/* ---------------------------------------------- 4. noop / 503 / 无响应 */

async function testNoopAndFailures(): Promise<void> {
  // noop：零调用，不保留恢复入口。
  const noopStore = createAiRequestStore({ storage: memoryStorage() })
  const noop = await noopStore.start({
    requestId: REQUEST_A, kind: 'local', source: SOURCE_A,
    async send() { return { status: 'noop', message: '要我分析啥啊？' } },
  })
  expectEqual(noop.phase, 'noop', 'noop 单独成相')
  expectEqual(noopStore.recoveryEntries(), [], 'noop 不保留恢复入口')

  // 503 缺配置：没有调用模型，不产生费用，也不留恢复入口。
  const blockedStore = createAiRequestStore({ storage: memoryStorage() })
  const blocked = await blockedStore.start({
    requestId: REQUEST_A, kind: 'local', source: SOURCE_A,
    async send() { throw Object.assign(new Error('未配置 Key'), { status: 503 }) },
  })
  expectEqual(blocked.phase, 'blocked', '503 进入 blocked')
  expectEqual(blocked.mayHaveCharged, false, '503 未调用模型')
  expectEqual(blockedStore.recoveryEntries(), [], '503 不留恢复入口')

  // 完全没拿到响应：unknown + 可能已计费 + 保留入口供查询（绝不重发）。
  const unknownStore = createAiRequestStore({ storage: memoryStorage() })
  let sends = 0
  const unknown = await unknownStore.start({
    requestId: REQUEST_A, kind: 'local', source: SOURCE_A,
    async send() { sends += 1; throw new Error('Failed to fetch') },
  })
  expectEqual(sends, 1, '网络失败只发送过一次')
  expectEqual(unknown.phase, 'unknown', '无响应进入 unknown')
  expectEqual(unknown.mayHaveCharged, true, 'unknown 不承诺未计费')
  expectEqual(unknownStore.recoveryEntries().length, 1, 'unknown 保留恢复入口')

  // 迟到 / 重复状态查询不会自动补发。
  const state = await unknownStore.refresh(REQUEST_A, async () => 'missing')
  expectEqual(state.phase, 'failed', '查询 404 说明未登记，移除入口')
  expectEqual(unknownStore.recoveryEntries(), [], '404 后清理失效入口')
  expectEqual(sends, 1, '查询不会重发请求')
}

/* --------------------------------------------------------- 5. 恢复流程 */

async function testRestore(): Promise<void> {
  const entryA: AiRecoveryEntry = { requestId: REQUEST_A, kind: 'local', source: SOURCE_A }
  const entryB: AiRecoveryEntry = { requestId: REQUEST_B, kind: 'review', source: SOURCE_B }
  const storage = memoryStorage({
    [RECOVERY_STORAGE_KEY]: JSON.stringify({ version: 1, entries: [entryA, entryB] }),
  })
  const store = createAiRequestStore({ storage })
  expectEqual(store.recoveryEntries().length, 2, '从存储读回恢复索引')

  const results = await store.restore(async (requestId) => {
    if (requestId === REQUEST_A) return 'missing'
    return { request_id: REQUEST_B, status: 'pending' }
  })

  const dropped = results.find((item) => item.entry.requestId === REQUEST_A)
  const polling = results.find((item) => item.entry.requestId === REQUEST_B)
  expectEqual(dropped?.plan, { action: 'drop' }, '404 的入口被丢弃')
  expectEqual(dropped?.state, null, '丢弃的入口不产生状态')
  expectEqual(polling?.plan, { action: 'poll' }, 'pending 的入口继续查询')
  expectEqual(polling?.state?.phase, 'polling', 'pending 映射为等待结果')
  expectEqual(polling?.state?.recovered, true, '标明来自恢复查询')
  expectEqual(store.recoveryEntries(), [entryB], '只清理丢弃的入口，保留仍需查询的')

  // 离线：查询抛错 → 状态未知、入口保留、绝不重发。
  const offline = createAiRequestStore({
    storage: memoryStorage({ [RECOVERY_STORAGE_KEY]: JSON.stringify({ version: 1, entries: [entryA] }) }),
  })
  const offlineResults = await offline.restore(async () => { throw new Error('offline') })
  expectEqual(offlineResults[0].state?.phase, 'unknown', '离线恢复状态未知')
  expectEqual(offlineResults[0].state?.mayHaveCharged, true, '离线不承诺未计费')
  expectEqual(offline.recoveryEntries().length, 1, '离线保留入口')

  // 已有结果（ready）直接展示，不重新发送。
  const ready = createAiRequestStore({
    storage: memoryStorage({ [RECOVERY_STORAGE_KEY]: JSON.stringify({ version: 1, entries: [entryB] }) }),
  })
  const readyResults = await ready.restore(async () => ({ request_id: REQUEST_B, status: 'ready', reply: '已有结果' }))
  expectEqual(readyResults[0].plan, { action: 'show' }, 'ready 直接展示')
  expectEqual(readyResults[0].state?.phase, 'ready', 'ready 状态可读')
}

/* ------------------------------------------------------ 6. 索引只存身份 */

async function testIndexKeepsOnlyIdentity(): Promise<void> {
  const storage = memoryStorage()
  const store = createAiRequestStore({ storage })
  await store.start({
    requestId: REQUEST_A,
    kind: 'local',
    source: { type: 'journal', id: 3 },
    async send() {
      throw Object.assign(new Error('上游 504'), { status: 504 })
    },
  })
  const raw = storage.data[RECOVERY_STORAGE_KEY] ?? ''
  check(raw.includes(REQUEST_A), '索引里有 request_id')
  check(!raw.includes('AI 回复'), '索引不含结果正文')
  check(!raw.includes('sk-'), '索引不含密钥')
  check(!raw.includes('question'), '索引不含问题')
  const parsed = JSON.parse(raw) as { entries: unknown[] }
  expectEqual(parsed.entries.length, 1, '索引只有一条')
  expectEqual(Object.keys(parsed.entries[0] as Record<string, unknown>).sort(), ['kind', 'requestId', 'source'], '条目只有三个身份字段')

  store.forget(REQUEST_A)
  expectEqual(store.recoveryEntries(), [], 'forget 同时清理索引')
  expectEqual(storage.data[RECOVERY_STORAGE_KEY], JSON.stringify({ version: 1, entries: [] }), '索引落盘为空')
}

/* -------------------------------------------------- 7. 传输层错误并入状态 */

{
  const store = createAiRequestStore({ storage: memoryStorage() })
  const state = store.noteTransportFailure('33333333-3333-4333-8333-333333333333', {
    status: 409,
    message: '文件版本已变化',
  })
  expectEqual(state.phase, 'conflict', '409 传输错误映射为冲突')
  expectEqual(state.mayHaveCharged, false, '409 未调用模型')
}

await testStartIsIdempotentAndIndexesFirst()
await testNavigateAwayKeepsRequest()
await testCrossFileIsolation()
await testNoopAndFailures()
await testRestore()
await testIndexKeepsOnlyIdentity()

console.log(`aiRequests: ${passed} 项通过`)
