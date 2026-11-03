import * as edits from './goalEdits.ts'

const base = { type: 'doc', content: [
  { type: 'goalItem', attrs: { id: 'node-a', goal_id: 'goal-a', text: 'old', checked: false } },
  { type: 'goalItem', attrs: { id: 'node-b', goal_id: 'goal-b', text: 'second', checked: false } },
] } as const
const changed = { type: 'doc', content: [
  { type: 'goalItem', attrs: { id: 'node-a', goal_id: 'goal-a', text: 'new', checked: false } },
  { type: 'goalItem', attrs: { id: 'node-b', goal_id: 'goal-b', text: 'second', checked: false } },
] } as const
const metadata = { goal_links: [{ goal_id: 'goal-a', end_id: 23 }, { goal_id: 'goal-b', end_id: 24 }], related_revisions: [
  { type: 'journal', id: 23, revision: 5 }, { type: 'journal', id: 24, revision: 8 },
] } as const
const select = (edits as unknown as { goalRelatedRevisions?: (a: unknown, b: unknown, m: unknown) => unknown }).goalRelatedRevisions
function expect(value: boolean, label: string): void { if (!value) throw new Error(label) }
expect(typeof select === 'function', 'goal revision selector must exist')
expect(JSON.stringify(select!(base, changed, metadata)) === JSON.stringify([{type:'journal', id:23, revision:5}]), 'only affected related revision')
expect(JSON.stringify(select!(base, base, metadata)) === '[]', 'unchanged goal requires no related revisions')
let rejected = false
try { select!(base, changed, { ...metadata, related_revisions: [] }) } catch { rejected = true }
expect(rejected, 'missing related revision is rejected')
console.log('goal edit revisions: passed')
const valid = (edits as unknown as { validGoalText?: (value: string) => boolean }).validGoalText
expect(typeof valid === 'function', 'goal validation must exist')
expect(!valid!('  ') && valid!('one\ntwo') && !valid!('a'.repeat(2001)), 'goal input validation')
const update = (edits as unknown as { editGoalText?: (doc: unknown, id: string, text: string) => { content: Array<{ attrs: { goal_id: string; id: string; text: string } }> } }).editGoalText
expect(typeof update === 'function', 'goal draft update must exist')
const revised = update!(base, 'goal-a', 'new\nmore')
expect(revised.content[0].attrs.goal_id === 'goal-a' && revised.content[0].attrs.id === 'node-a', 'goal identity remains unchanged')
expect(revised.content[0].attrs.text === 'new\nmore' && base.content[0].attrs.text === 'old', 'goal content changes without mutating original')
