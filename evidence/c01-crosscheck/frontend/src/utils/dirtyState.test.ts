import { isDraftDirty, type ContentDraft } from './dirtyState.ts'
let passed = 0
function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  passed += 1
}
const initial: ContentDraft = { title: '', content: '', journal_date: '2026-10-08', folder_id: null }
check(!isDraftDirty(initial, { ...initial }), 'default date and empty form are clean')
check(isDraftDirty(initial, { ...initial, title: 'thought' }), 'title change is dirty')
check(isDraftDirty(initial, { ...initial, content: '  markdown  ' }), 'raw content change is dirty')
check(isDraftDirty(initial, { ...initial, journal_date: '2026-10-07' }), 'date change is dirty')
check(isDraftDirty(initial, { ...initial, folder_id: 8 }), 'folder change is dirty')
check(!isDraftDirty(initial, { ...initial, title: '' }), 'restored title is clean')
check(!isDraftDirty(initial, { ...initial, content: '' }), 'restored content is clean')
const daily = { title: '2026-10-08', content: '' }
check(!isDraftDirty(daily, { ...daily }), 'default Daily title is clean')
const saved = { title: 'saved', content: 'source', journal_date: '2026-10-07' }
check(!isDraftDirty(saved, { ...saved }), 'server response becomes new clean baseline')
check(isDraftDirty(saved, { ...saved, content: 'source ' }), 'trailing spaces are real edits')
check(!isDraftDirty(saved, { ...saved, content: 'source' }), 'restoring all fields is clean')
console.log(`dirtyState: ${passed} assertions passed`)
