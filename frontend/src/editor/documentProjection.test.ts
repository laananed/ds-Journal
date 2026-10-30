import { readFileSync } from 'node:fs'
import { projectDocument, userTextDocument, utf16ToCodePoint } from './documentProjection.ts'

const cases = JSON.parse(readFileSync(new URL('../../../tests/fixtures/stage4_documents/projections.json', import.meta.url), 'utf8')) as { id: string; input: unknown; R: string; U: string }[]
for (const item of cases) {
  if (projectDocument(item.input) !== item.R || userTextDocument(item.input) !== item.U) {
    throw new Error(`projection fixture failed: ${item.id}`)
  }
}
console.log(`${cases.length} shared projection fixtures passed`)
if (utf16ToCodePoint('甲😀乙', 3) !== 2) throw new Error('unicode offset conversion failed')
let rejected = false
try { utf16ToCodePoint('甲😀乙', 2) } catch { rejected = true }
if (!rejected) throw new Error('offset splitting surrogate pair was accepted')
