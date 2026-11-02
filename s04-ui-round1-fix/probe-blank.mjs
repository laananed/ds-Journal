/**
 * 缺陷 2 取证探针：空白速记到底会不会写本机草稿。
 *
 * 只读观察：加载真实构建产物 → 点「速记」→ 不做任何输入 →
 * 按时间采样 IndexedDB 并导出完整记录。不连后端、不连数据库。
 *
 * 用法：node probe-blank.mjs
 */
import { writeFileSync } from 'node:fs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5401/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9225'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const apiLog = []

const businessDay = {
  timezone: 'Asia/Shanghai', day_start_hour: 4,
  server_time: '2026-11-01T23:30:00.123456+08:00', business_date: '2026-11-01',
}
const emptyPage = { items: [], page: 1, page_size: 20, total: 0, has_next: false }

function resolveApi(url, method) {
  const path = new URL(url).pathname
  if (method === 'OPTIONS') return [204, null]
  if (method !== 'GET') return [200, {}]
  if (path === '/api/business-day') return [200, businessDay]
  if (path === '/api/rituals') return [200, { journal_date: '2026-11-01', set: null, end: null }]
  if (path === '/api/ritual-templates') return [200, { set: { questions: [], revision: 1 }, end: { questions: [], revision: 1 } }]
  if (path === '/api/ai/settings') {
    return [200, {
      custom_prompt: '', web_enabled: false, revision: 1, model: 'mock', model_configured: false,
      search_configured: false, effective_web_enabled: false, auto_go_deeper: false,
      auto_minds_comments: false, mind_preset_ids: [],
    }]
  }
  if (path === '/api/ai/usage') return [200, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, unknown_subcalls: 0, search_requests: 0 }]
  if (path === '/api/folders') return [200, []]
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
  throw new Error('找不到可调试页面')
}
const target = await findTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  socket.addEventListener('open', res, { once: true })
  socket.addEventListener('error', rej, { once: true })
})
let nextId = 1
const pending = new Map()
const handlers = {}
socket.addEventListener('message', (event) => {
  const d = JSON.parse(event.data)
  if (typeof d.id === 'number' && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return }
  if (d.method && handlers[d.method]) handlers[d.method](d.params)
})
function send(method, params = {}) {
  const id = nextId; nextId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)))
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`求值失败：${r.exceptionDetails.text}`)
  return r.result.value
}
async function waitFor(expr, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expr)) return true } catch { /* 导航中 */ }
    await sleep(100)
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
handlers['Fetch.requestPaused'] = async (p) => {
  const { requestId, request } = p
  try {
    if (!request.url.includes('127.0.0.1:8000/api/')) { await send('Fetch.continueRequest', { requestId }); return }
    apiLog.push({ method: request.method, path: new URL(request.url).pathname })
    const [status, body] = resolveApi(request.url, request.method)
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' },
        { name: 'Access-Control-Allow-Headers', value: 'Content-Type,If-Match' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: body === null ? '' : Buffer.from(JSON.stringify(body)).toString('base64'),
    })
  } catch { /* 请求已失效 */ }
}

const dumpDrafts = () => evaluate(`(async () => {
  // 只读：库还不存在时**不能** open——那会以 v1 建出一个没有 object store 的空库，
  // 使被测代码后续无法建 store（装置自身缺陷，会把「没写」伪装成「写失败」）。
  const known = await indexedDB.databases()
  if (!known.some((item) => item.name === 'seekjournal.local.drafts')) {
    return { records: 0, items: [], note: 'db_absent' }
  }
  return new Promise((resolve) => {
  const request = indexedDB.open('seekjournal.local.drafts')
  request.onupgradeneeded = () => resolve({ records: 0, items: [], note: 'created' })
  request.onerror = () => resolve({ records: 0, items: [], note: 'open_failed' })
  request.onsuccess = () => {
    const db = request.result
    if (!db.objectStoreNames.contains('journal_drafts')) { resolve({ records: 0, items: [], note: 'no_store' }); return }
    const all = db.transaction('journal_drafts', 'readonly').objectStore('journal_drafts').getAll()
    all.onsuccess = () => resolve({
      records: all.result.length,
      items: all.result.map((row) => ({ key: row.key, record: row.record ?? null })),
    })
  }
  })
})()`)

await send('Page.navigate', { url: APP })
await waitFor(`document.querySelector('.dash-hero') !== null`)
const before = await dumpDrafts()
const entered = await evaluate(`(() => {
  const node = [...document.querySelectorAll('.sj-nav button')].find((b) => b.getAttribute('aria-label') === '速记')
  if (!node) return false
  node.click()
  return true
})()`)
const timeline = []
for (let i = 0; i <= 12; i += 1) {
  timeline.push({ at: i * 250, drafts: await dumpDrafts() })
  await sleep(250)
}
const ui = await evaluate(`(() => ({
  banner: [...document.querySelectorAll('p')].map((p) => p.textContent).find((t) => (t ?? '').includes('未提交的草稿')) ?? null,
  button: [...document.querySelectorAll('button')].map((b) => b.textContent).find((t) => (t ?? '').startsWith('本地草稿（')) ?? null,
  editor: document.querySelector('.ProseMirror')?.textContent ?? null,
}))()`)

const out = {
  at: new Date().toISOString(),
  beforeEntering: before.records,
  entered,
  timeline: timeline.map((t) => ({ at: t.at, records: t.drafts.records, note: t.drafts.note ?? null })),
  firstWrite: timeline.find((t) => t.drafts.records > 0)?.at ?? null,
  ui,
  items: timeline.at(-1).drafts.items,
  writes: apiLog.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS'),
}
writeFileSync('C:/Programme/demo/SeekJournal/s04-ui-round1-fix/probe-blank.json', JSON.stringify(out, null, 2))
console.log(JSON.stringify({ ...out, items: out.items.map((i) => ({ key: i.key, record: summarize(i.record) })) }, null, 2))
socket.close()

function summarize(record) {
  if (record === null) return null
  const doc = JSON.stringify(record.content_doc ?? null)
  return {
    title: record.title,
    input_seq: record.input_seq,
    first_request: record.first_request ?? null,
    has_text_node: doc.includes('"text"'),
    content_doc: doc.slice(0, 300),
  }
}
