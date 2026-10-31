import { getSearchTarget } from './search.ts'
import { readLinkTarget } from './links.ts'

const urls: string[] = []
globalThis.fetch = async input => {
  urls.push(String(input))
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
}
await getSearchTarget({ type: 'inbox', id: 1 })
await readLinkTarget({ type: 'inbox', id: 2 })
if (!urls[0]?.endsWith('/api/inboxes/1') || !urls[1]?.endsWith('/api/inboxes/2')) {
  throw new Error('Inbox targets must remain reachable until the coordinated cutover')
}
