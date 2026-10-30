import { strict as assert } from 'node:assert'
import { AiCallError, executeAIWriting, prepareAIWriting, applyAIWriting, deleteAIComment } from './ai.ts'

const requestId = '11111111-1111-4111-8111-111111111111'
const originalFetch = globalThis.fetch
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'timeout', request_id: requestId }), {
    status: 504, headers: { 'Content-Type': 'application/json' },
  })
  await assert.rejects(() => executeAIWriting(requestId), (error: unknown) =>
    error instanceof AiCallError && error.status === 504 && error.requestId === requestId)
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
  assert.deepEqual(JSON.parse(String(requests[0].options?.body)), payload)
  assert.deepEqual(JSON.parse(String(requests[1].options?.body)), { expected_revision: 3 })
  assert.equal((requests[2].options?.headers as Record<string, string>)['If-Match'], '"4"')
} finally {
  globalThis.fetch = originalFetch
}
