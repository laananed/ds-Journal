import { journalEditorRoute } from "./journalEditorRoute.ts"

function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`)
}

equal(journalEditorRoute({ journal_kind: "writing", content_doc: { type: "doc", content: [] } }), "structured")
equal(journalEditorRoute({ journal_kind: "writing", content_doc: null }), "legacy")
equal(journalEditorRoute({ journal_kind: "set", content_doc: { type: "doc", content: [] } }), "ritual")
equal(journalEditorRoute({ journal_kind: "end", content_doc: { type: "doc", content: [] } }), "ritual")
console.log("journal editor routing: passed")
