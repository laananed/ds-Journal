/**
 * AI 写作客户端的契约行为测试（Stage 4 / S04-T08）。
 *
 *   node --experimental-strip-types src/api/aiWriting.test.ts
 *
 * 只验证客户端约定：504 必须转成带 request_id 的 AiCallError（不得自动换键重发），
 * prepare/apply 的请求体保持原 payload 与 expected_revision，delete 带 If-Match 版本。
 * 不证明任何后端行为；fetch 被整体替换，不访问真实后端或模型。
 */

import { AiCallError, executeAIWriting, prepareAIWriting, applyAIWriting, deleteAIComment } from './ai.ts'

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

/** 与 assert.rejects(promiseFn, predicate) 等价：必须抛出，且错误满足 predicate。 */
async function expectRejects(
  run: () => Promise<unknown>,
  predicate: (error: unknown) => boolean,
  label: string,
): Promise<void> {
  try {
    await run()
  } catch (error) {
    check(predicate(error), `${label}：抛出的错误不符合预期（${String(error)}）`)
    return
  }
  throw new Error(`失败：${label}：期望抛出错误，实际成功返回`)
}

const requestId = '11111111-1111-4111-8111-111111111111'
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'timeout', request_id: requestId }), {
    status: 504, headers: { 'Content-Type': 'application/json' },
  })
  await expectRejects(() => executeAIWriting(requestId),
    (error: unknown) => error instanceof AiCallError && error.status === 504 && error.requestId === requestId,
    '504 必须抛 AiCallError 并保留 request_id')
  const requests: Array<{ url: string; options: RequestInit | undefined }> = []
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), options })
    if (options?.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({request_id: requestId, status: 'prepared', files: [], effects: []}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  const payload = { request_id: requestId, kind: 'minds_comments' as const, trigger: 'automatic' as const,
    source: { type: 'journal' as const, id: 1, expected_revision: 2 },
    mind_preset_ids: ['gentle_reflection' as const], scope: { ranges: [{ node_id: requestId, start: 1, end: 2 }] } }
  await prepareAIWriting(payload)
  await applyAIWriting(requestId, 3)
  await deleteAIComment(1, requestId, 4)
  expectEqual(JSON.parse(String(requests[0].options?.body)), payload, 'prepare 请求体必须与提交的 payload 一致')
  expectEqual(JSON.parse(String(requests[1].options?.body)), { expected_revision: 3 }, 'apply 必须只带 expected_revision')
  const deleteHeaders = requests[2].options?.headers as Record<string, string> | undefined
  check(deleteHeaders?.['If-Match'] === '"4"', 'delete 必须带 If-Match 版本')
} finally {
  globalThis.fetch = originalFetch
}

console.log(`aiWriting: ${passed} assertions passed`)
