import { addRecoveryEntry, findRecoveryEntry, readRecoveryIndex, removeRecoveryEntry, writeRecoveryIndex, recoveryKindMatches, RECOVERY_STORAGE_KEY, type AiRecoveryEntry, type StorageLike } from './aiRequestState.ts'

const assert = {
  equal(actual: unknown, expected: unknown, message = 'values differ') {
    if (actual !== expected) throw new Error(message)
  },
  deepEqual(actual: unknown, expected: unknown, message = 'values differ') {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message)
  },
}
const source = { type: 'inbox' as const, id: 91 }
const local: AiRecoveryEntry = { requestId: '11111111-1111-4111-8111-111111111111', kind: 'local', source }
const review: AiRecoveryEntry = { requestId: '22222222-2222-4222-8222-222222222222', kind: 'review', source }
assert.equal(recoveryKindMatches({ kind: 'review' }, 'review'), true)
assert.equal(recoveryKindMatches({ kind: 'local' }, 'review'), false)
assert.equal(recoveryKindMatches({}, 'review'), false)
const both = addRecoveryEntry(addRecoveryEntry([], local), review)
assert.equal(both.length, 2, 'different kinds for one source must coexist')
assert.equal(findRecoveryEntry(both, source, 'local')?.requestId, local.requestId)
assert.equal(findRecoveryEntry(both, source, 'review')?.requestId, review.requestId)
assert.equal(findRecoveryEntry([review], source, 'local'), null)
assert.deepEqual(removeRecoveryEntry(both, local.requestId), [review])
assert.deepEqual(removeRecoveryEntry(both, review.requestId), [local])
assert.equal(addRecoveryEntry(addRecoveryEntry([], review), local).length, 2)
const journal = { type: 'journal' as const, id: 92 }
assert.equal(findRecoveryEntry([{ ...review, source: journal }], journal, 'local'), null)
assert.equal(findRecoveryEntry([{ ...local, source: journal }], journal, 'local')?.requestId, local.requestId)

const unknown = { requestId: '33333333-3333-4333-8333-333333333333', kind: 'future', source }
let value: string | null = JSON.stringify({ version: 1, entries: [unknown, local] })
const storage: StorageLike = { getItem: () => value, setItem: (_key, next) => { value = next }, removeItem: () => { value = null } }
writeRecoveryIndex(storage, addRecoveryEntry(readRecoveryIndex(storage), review))
assert.deepEqual(JSON.parse(value!).entries, [local, review, unknown], 'unknown kind must survive writes')
writeRecoveryIndex(storage, removeRecoveryEntry(readRecoveryIndex(storage), local.requestId))
assert.deepEqual(JSON.parse(value!).entries, [review, unknown], 'clearing local preserves review and unknown')
value = '{corrupt'
writeRecoveryIndex(storage, [local])
assert.equal(value, '{corrupt', 'unparseable legacy index must not be overwritten')
value = JSON.stringify({ version: 2, entries: [unknown] })
const unknownVersion = value
writeRecoveryIndex(storage, [local])
assert.equal(value, unknownVersion, 'unknown index version must not be overwritten')
assert.equal(RECOVERY_STORAGE_KEY, 'seekjournal.ai.recovery.v1')
