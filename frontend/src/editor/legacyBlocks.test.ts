import { getSchema } from '@tiptap/core'
import { projectDocument, userTextDocument } from './documentProjection.ts'
import { buildExtensions, protectedSignature, toServerDocument } from './schema.ts'

const block = { type: 'legacyBlocks', attrs: { id: '33333333-3333-4333-8333-333333333333', format_version: 1,
  blocks: [{ id: '11111111-1111-4111-8111-111111111111', kind: 'user', text: '甲' },
    { id: '22222222-2222-4222-8222-222222222222', kind: 'user', text: '乙' }] } }
const doc = { type: 'doc', content: [block] }
if (projectDocument(doc) !== '甲乙' || userTextDocument(doc) !== '甲乙') throw new Error('legacy projection mismatch')
const schema = getSchema(buildExtensions())
const before = schema.nodeFromJSON(doc)
const edited = structuredClone(doc)
edited.content[0].attrs.blocks[0].text = '新'
if (protectedSignature(before) !== protectedSignature(schema.nodeFromJSON(edited))) throw new Error('user edit rejected')
edited.content[0].attrs.blocks[0].id = '44444444-4444-4444-8444-444444444444'
if (protectedSignature(before) === protectedSignature(schema.nodeFromJSON(edited))) throw new Error('identity modification allowed')
if (JSON.stringify(toServerDocument(before.toJSON())) !== JSON.stringify(doc)) throw new Error('server serialization changed legacy content')
