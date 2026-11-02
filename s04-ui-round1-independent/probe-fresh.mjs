/**
 * 专项探针：全新浏览器配置（无 IndexedDB / 无本地草稿）首次进入「速记」再离开。
 * 目的：判断「空白新草稿离开被拦」是否与恢复历史本地草稿有关。
 */
import { writeFileSync } from 'node:fs'

const APP = 'http://127.0.0.1:5399/'
const CDP = 'http://127.0.0.1:9224'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round1-independent/shots'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const doc = (text) => ({ type: 'doc', content: [{ type: 'paragraph', attrs: { id: '11111111-1111-4111-8111-111111111111' }, content: [{ type: 'text', text }] }] })
const BD = '2026-11-01'
const setJournal = {
  type: 'journal', id: 101, title: '今天的计划', display_title: '今天的计划', content: '已有计划的正文', revision: 3,
  folder_id: null, created_at: `${BD}T23:10:00.000000+08:00`, updated_at: `${BD}T23:20:00.000000+08:00`,
  deleted_at: null, journal_date: BD, journal_kind: 'set', content_doc: doc('已有计划的正文'),
  document_schema_version: 1, document_format: 'tiptap',
}
const emptyPage = { items: [], page: 1, page_size: 20, total: 0, has_next: false }
let setState = setJournal
function api(url, method) {
  const u = new URL(url); const p = u.pathname
  if (method === 'OPTIONS') return [204, null]
  if (p === '/api/business-day') return [200, { timezone: 'Asia/Shanghai', day_start_hour: 4, server_time: `${BD}T23:30:00.1+08:00`, business_date: BD }]
  if (p === '/api/rituals') return [200, { journal_date: BD, set: setState, end: null }]
  if (p === '/api/ritual-templates') return [200, { set: { questions: [], revision: 1 }, end: { questions: [], revision: 1 } }]
  if (p === '/api/journals' && method === 'POST') return [200, { ...setJournal, id: 501, journal_kind: 'writing' }]
  if (p === '/api/journals') return [200, emptyPage]
  if (p === '/api/folders') return [200, []]
  if (p === '/api/ai/settings') return [200, { custom_prompt: '', web_enabled: false, revision: 1, model: 'm', model_configured: false, search_configured: false, effective_web_enabled: false, auto_go_deeper: false, auto_minds_comments: false, mind_preset_ids: [] }]
  if (p.startsWith('/api/')) return [200, emptyPage]
  return [200, emptyPage]
}

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`${CDP}/json/list`).then((r) => r.json())
      const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 未就绪 */ }
    await sleep(250)
  }
  throw new Error('no target')
}
const target = await findTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => { socket.addEventListener('open', res, { once: true }); socket.addEventListener('error', rej, { once: true }) })
let nextId = 1
const pending = new Map()
const handlers = {}
const log = []
socket.addEventListener('message', (e) => {
  const d = JSON.parse(e.data)
  if (typeof d.id === 'number' && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return }
  if (d.method && handlers[d.method]) handlers[d.method](d.params)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId; nextId += 1
  pending.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)))
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text}`)
  return r.result.value
}
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'))
}
await send('Page.enable'); await send('Runtime.enable')
handlers['Runtime.exceptionThrown'] = (p) => console.error('[EXC]', p.exceptionDetails.text)
await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
handlers['Fetch.requestPaused'] = async (p) => {
  try {
    if (!p.request.url.includes('8000/api/')) { await send('Fetch.continueRequest', { requestId: p.requestId }); return }
    log.push(`${p.request.method} ${new URL(p.request.url).pathname}`)
    const [status, body] = api(p.request.url, p.request.method)
    await send('Fetch.fulfillRequest', {
      requestId: p.requestId, responseCode: status,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' }, { name: 'Access-Control-Allow-Headers', value: 'Content-Type,If-Match' }],
      body: body === null ? '' : Buffer.from(JSON.stringify(body)).toString('base64'),
    })
  } catch { /* 请求已失效 */ }
}
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

const result = { cases: [] }
async function runCase(name, entryLabel, withSet, shotName) {
  setState = withSet ? setJournal : null
  log.length = 0
  await send('Page.navigate', { url: APP })
  await sleep(1600)
  await evaluate(`(() => {
    const byLabel = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(entryLabel)})
    if (byLabel) { byLabel.click(); return 'label' }
    const byText = [...document.querySelectorAll('.dash-action')].find(b => b.textContent.trim() === ${JSON.stringify(entryLabel)})
    if (byText) { byText.click(); return 'text' }
    return 'none'
  })()`)
  await sleep(2600)
  const entered = await evaluate(`(() => ({
    text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 170),
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
  }))()`)
  entered.requests = [...log]
  log.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('回到概览'))?.click()`)
  await sleep(1600)
  const back = await evaluate(`(() => ({
    dialogOpen: document.querySelector('dialog')?.open ?? false,
    dialogTitle: document.querySelector('#leave-title')?.textContent ?? null,
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
    title: document.querySelector('.dash-hero-title')?.textContent ?? null,
  }))()`)
  back.requests = [...log]
  if (shotName) await shot(shotName)
  result.cases.push({ name, entry: entryLabel, entered, back })
}
await runCase('virgin-速记-离开', '速记', true, '22-fresh-quick-leave.png')
await runCase('virgin-计划(无记录)-离开', '计划', false, '23-fresh-plan-empty-leave.png')

writeFileSync('C:/Programme/demo/SeekJournal/s04-ui-round1-independent/probe-fresh.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 1))
socket.close()
