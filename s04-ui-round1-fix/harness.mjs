/**
 * 第一轮 UI 修复 · 缺陷回归装置（证据用，不属于产品代码）。
 *
 * 真实生产构建产物（frontend/dist，静态服务）+ 真实 App 组件；
 * 只在 CDP `Fetch` 域拦截 `127.0.0.1:8000/api/*`，用合成数据应答。
 * 不启动后端、不连数据库、不调用模型、不产生任何真实写入。
 *
 * 用法：node harness.mjs  （需先起静态服务与带调试端口的 Chrome，见 run.sh）
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5401/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9225'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round1-fix'
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { startedAt: new Date().toISOString(), scenarios: {}, requests: [], console: [] }
const apiLog = []

/* ------------------------------------------------------------ 合成数据 */
const doc = (text) => ({
  type: 'doc',
  content: [{
    type: 'paragraph',
    attrs: { id: '11111111-1111-4111-8111-111111111111' },
    content: text === '' ? [] : [{ type: 'text', text }],
  }],
})
const journal = (id, kind, title, body, date, revision = 3) => ({
  type: 'journal', id, title, display_title: title, content: body, revision, folder_id: null,
  created_at: `${date}T23:10:00.000000+08:00`, updated_at: `${date}T23:20:00.000000+08:00`,
  deleted_at: null, journal_date: date, journal_kind: kind, content_doc: doc(body),
  document_schema_version: 1, document_format: 'tiptap',
})

const BUSINESS_DATE = '2026-11-01' // 与运行环境本地日期（2026-11-02）不同，验证取服务端日期
const businessDay = {
  timezone: 'Asia/Shanghai', day_start_hour: 4,
  server_time: '2026-11-01T23:30:00.123456+08:00', business_date: BUSINESS_DATE,
}
const emptyPage = { items: [], page: 1, page_size: 20, total: 0, has_next: false }

/** 计划/复盘是否存在由场景决定；`writeMode` 控制写请求结果。 */
let world = { set: null, end: null }
/** 'ok' | 'fail500' | 'hold' */
let writeMode = 'ok'
const held = []

function resolveApi(url, method, postData) {
  const path = new URL(url).pathname
  if (method === 'OPTIONS') return [204, null]
  if (method === 'POST' && path === '/api/journals') {
    let body = {}
    try { body = JSON.parse(postData ?? '{}') } catch { body = {} }
    const text = textOf(body?.draft?.content_doc) || textOf(body?.content_doc)
    return [200, journal(501, 'writing', body?.draft?.title ?? '', text, BUSINESS_DATE, 1)]
  }
  if (method === 'PATCH' && path.startsWith('/api/journals/')) {
    let body = {}
    try { body = JSON.parse(postData ?? '{}') } catch { body = {} }
    const id = Number(path.split('/').pop())
    const text = textOf(body?.draft?.content_doc) || textOf(body?.content_doc) || textOf(body?.patch?.content_doc)
    return [200, journal(id, 'writing', body?.draft?.title ?? '', text, BUSINESS_DATE, 2)]
  }
  if (method !== 'GET') return [200, {}]
  if (path === '/api/business-day') return [200, businessDay]
  if (path === '/api/rituals') return [200, { journal_date: BUSINESS_DATE, set: world.set, end: world.end }]
  if (path === '/api/ritual-templates') return [200, { set: { questions: [], revision: 1 }, end: { questions: [], revision: 1 } }]
  if (path === '/api/journals') return [200, emptyPage]
  if (path === '/api/trash') return [200, emptyPage]
  if (path === '/api/search') return [200, emptyPage]
  if (path === '/api/folders') return [200, []]
  if (path === '/api/insights') return [200, emptyPage]
  if (path === '/api/ai/settings') {
    return [200, {
      custom_prompt: '', web_enabled: false, revision: 1, model: 'mock-model',
      model_configured: false, search_configured: false, effective_web_enabled: false,
      auto_go_deeper: false, auto_minds_comments: false, mind_preset_ids: [],
    }]
  }
  if (path === '/api/ai/usage') {
    return [200, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, unknown_subcalls: 0, search_requests: 0 }]
  }
  if (path.startsWith('/api/schedules')) return [200, emptyPage]
  return [200, emptyPage]
}

function textOf(node) {
  if (node === null || typeof node !== 'object') return ''
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : ''
  if (Array.isArray(node.content)) return node.content.map(textOf).join('')
  return ''
}

/* ------------------------------------------------------------ CDP 引导 */
async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await fetch(`${CDP}/json/list`).then((r) => r.json())
      const page = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* chrome 未就绪 */ }
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
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOTS}/${name}`, Buffer.from(data, 'base64'))
}
async function waitFor(expr, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expr)) return true } catch { /* 导航中 */ }
    await sleep(120)
  }
  return false
}

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
handlers['Log.entryAdded'] = (p) => { if (p.entry.level === 'error') report.console.push(p.entry.text) }
handlers['Runtime.exceptionThrown'] = (p) => {
  const d = p.exceptionDetails
  report.console.push(`exception: ${`${d.text} ${d.exception?.description ?? ''}`.replace(/\s+/g, ' ').slice(0, 400)}`)
}

await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
handlers['Fetch.requestPaused'] = async (p) => {
  const { requestId, request } = p
  const isApi = request.url.includes('127.0.0.1:8000/api/')
  try {
    if (!isApi) { await send('Fetch.continueRequest', { requestId }); return }
    const isWrite = request.method !== 'GET' && request.method !== 'OPTIONS'
    apiLog.push({ method: request.method, path: new URL(request.url).pathname, body: request.postData ?? null })
    if (isWrite && writeMode === 'hold') { held.push({ requestId, request }); return }
    if (isWrite && writeMode === 'fail500') {
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 500,
        responseHeaders: jsonHeaders(),
        body: Buffer.from(JSON.stringify({ detail: 'mock 写入失败' })).toString('base64'),
      })
      return
    }
    const [status, body] = resolveApi(request.url, request.method, request.postData)
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: jsonHeaders(),
      body: body === null ? '' : Buffer.from(JSON.stringify(body)).toString('base64'),
    })
  } catch {
    report.skippedInterceptions = (report.skippedInterceptions ?? 0) + 1
  }
}
function jsonHeaders() {
  return [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type,If-Match' },
    { name: 'Access-Control-Max-Age', value: '600' },
    { name: 'Cache-Control', value: 'no-store' },
  ]
}

/** 释放被扣住的写请求（按当前 writeMode 之外的路径正常应答）。 */
async function releaseHeld() {
  const queue = held.splice(0)
  for (const item of queue) {
    const [status, body] = resolveApi(item.request.url, item.request.method, item.request.postData)
    await send('Fetch.fulfillRequest', {
      requestId: item.requestId, responseCode: status,
      responseHeaders: jsonHeaders(),
      body: Buffer.from(JSON.stringify(body)).toString('base64'),
    })
  }
  return queue.length
}

async function loadPage(nextWorld = world, width = 1440, height = 900) {
  world = nextWorld
  apiLog.length = 0
  // 每个场景从空的本机草稿库开始，避免上一场景留下的记录干扰计数。
  try {
    await send('Storage.clearDataForOrigin', { origin: new URL(APP).origin, storageTypes: 'indexeddb' })
  } catch { /* 清不掉也不影响读取，只在报告里体现为计数偏差 */ }
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: APP })
  await waitFor(`document.querySelector('.dash-hero') !== null`)
  await sleep(350)
}

const writeRequests = () => apiLog.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS')

/** 左边栏按无障碍名称点击。 */
async function clickNav(label) {
  const ok = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.sj-nav button, .sj-shortcuts button')]
      .find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)})
    if (!node) return false
    node.click()
    return true
  })()`)
  await sleep(700)
  return ok
}

/** 首页主卡按钮（计划 / 复盘）。 */
async function clickHero(label) {
  const ok = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.dash-action')]
      .find((item) => item.textContent.trim() === ${JSON.stringify(label)})
    if (!node) return false
    node.click()
    return true
  })()`)
  await sleep(700)
  return ok
}

async function typeInEditor(text) {
  await evaluate(`document.querySelector('.ProseMirror')?.focus()`)
  await send('Input.insertText', { text })
  await sleep(200)
}

/** 本地草稿库（IndexedDB）里的记录：键、条数与关键字段（用于判断是否空白占位）。 */
function readLocalDrafts() {
  return evaluate(`(async () => {
    // 库不存在时不要 open（见 probe-blank.mjs 的同款说明）。
    const known = await indexedDB.databases()
    if (!known.some((item) => item.name === 'seekjournal.local.drafts')) {
      return { records: 0, keys: [], note: 'db_absent' }
    }
    return new Promise((resolve) => {
    const request = indexedDB.open('seekjournal.local.drafts')
    request.onerror = () => resolve({ keys: [], error: 'open_failed' })
    request.onupgradeneeded = () => resolve({ keys: [], error: 'no_db' })
    request.onsuccess = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('journal_drafts')) { resolve({ keys: [], error: 'no_store' }); return }
      const all = db.transaction('journal_drafts', 'readonly').objectStore('journal_drafts').getAll()
      all.onerror = () => resolve({ keys: [], error: 'read_failed' })
      all.onsuccess = () => resolve({
        records: all.result.length,
        keys: all.result.map((item) => item.key),
        detail: all.result.map((item) => ({
          keys: Object.keys(item ?? {}),
          raw: JSON.stringify(item ?? null).slice(0, 420),
        })),
      })
    }
    })
  })()`)
}

/** 页面可观测状态：主区标题、离开弹窗是否真的打开、本地草稿计数文案。 */
function readUi() {
  return evaluate(`(() => {
    const dialog = document.querySelector('dialog.leave-dialog')
    const banner = [...document.querySelectorAll('p')]
      .map((p) => p.textContent ?? '')
      .find((text) => text.includes('未提交的草稿'))
    return {
      module: document.querySelector('[aria-current="page"]')?.getAttribute('aria-label') ?? null,
      heading: document.querySelector('.app-content h2')?.textContent?.trim() ?? null,
      dialogOpen: dialog === null ? null : dialog.open,
      dialogText: dialog !== null && dialog.open
        ? (dialog.querySelector('#leave-title')?.textContent?.trim() ?? null)
        : null,
      draftBanner: banner ?? null,
      draftButton: [...document.querySelectorAll('button')]
        .map((b) => b.textContent ?? '')
        .find((text) => text.startsWith('本地草稿（')) ?? null,
      activePageLabels: [...document.querySelectorAll('[aria-current="page"]')]
        .map((n) => n.getAttribute('aria-label') ?? n.textContent.trim()),
    }
  })()`)
}

/* ============================================================ 场景 1
 * 缺陷 1 回归：空白速记 → 点「记录」应正常离开，且零写请求、零本地草稿。
 */
{
  await loadPage({ set: null, end: null })
  await clickNav('速记')
  await waitFor(`document.querySelector('.ProseMirror') !== null`)
  // 逐段采样：确认空白草稿是否在挂载/停稳后写入本机（缺陷 2）。
  const timeline = []
  for (let i = 0; i < 6; i += 1) {
    timeline.push({ at: i * 300, drafts: await readLocalDrafts() })
    await sleep(300)
  }
  const entered = await readUi()
  const draftsBeforeLeave = await readLocalDrafts()
  const writesBeforeLeave = writeRequests().length
  await clickNav('记录')
  await waitFor(`document.querySelector('.app-content h2') !== null`)
  await sleep(400)
  const after = await readUi()
  const draftsAfter = await readLocalDrafts()
  report.scenarios.blankQuickLeave = {
    entered,
    timeline,
    draftsInEditor: draftsBeforeLeave,
    writesInEditor: writeRequests().slice(0, writesBeforeLeave).map((r) => `${r.method} ${r.path}`),
    afterLeave: after,
    draftsAfterLeave: draftsAfter,
    writes: writeRequests().map((r) => `${r.method} ${r.path}`),
    left: after.dialogOpen !== true && after.module === '记录',
  }
  await shot('01-blank-quick-left.png')
}

/* ============================================================ 场景 2
 * 真实输入 + 保存成功：仍不被拦，且本地草稿在服务器确认后清掉。
 */
{
  await loadPage({ set: null, end: null })
  await clickNav('速记')
  await waitFor(`document.querySelector('.ProseMirror') !== null`)
  await typeInEditor('真实的速记内容')
  await sleep(2000) // 等首次 POST 与本地镜像
  const draftsAfterSave = await readLocalDrafts()
  await clickNav('记录')
  await sleep(400)
  const after = await readUi()
  const draftsAfterLeave = await readLocalDrafts()
  report.scenarios.typedSaved = {
    draftsAfterSave,
    draftsAfterLeave,
    afterLeave: after,
    writes: writeRequests().map((r) => `${r.method} ${r.path}`),
    left: after.dialogOpen !== true,
  }
  await shot('02-typed-saved-left.png')
}

/* ============================================================ 场景 3
 * 保存失败：必须仍然拦截（保护真实输入），不能因为修复被放宽。
 */
{
  await loadPage({ set: null, end: null })
  writeMode = 'fail500'
  await clickNav('速记')
  await waitFor(`document.querySelector('.ProseMirror') !== null`)
  await typeInEditor('写入会失败的内容')
  await sleep(2000)
  await clickNav('记录')
  await sleep(600)
  const after = await readUi()
  const drafts = await readLocalDrafts()
  report.scenarios.typedSaveFailed = {
    afterLeave: after,
    drafts,
    writes: writeRequests().map((r) => `${r.method} ${r.path}`),
    blocked: after.dialogOpen === true,
  }
  await shot('03-typed-save-failed-blocked.png')
  writeMode = 'ok'
}

/* ============================================================ 场景 4
 * 写入在途 + 继续输入：离开要等保存落地，且第二段输入不能丢。
 */
{
  await loadPage({ set: null, end: null })
  writeMode = 'hold'
  await clickNav('速记')
  await waitFor(`document.querySelector('.ProseMirror') !== null`)
  await typeInEditor('第一段')
  await sleep(1200) // 首次 POST 被扣住，进入在途
  await typeInEditor('第二段')
  await sleep(300)
  await clickNav('记录')
  await sleep(500)
  const during = await readUi()
  const released = await releaseHeld()
  writeMode = 'ok'
  await sleep(1800)
  const after = await readUi()
  const writeBodies = writeRequests().map((r) => ({ method: r.method, path: r.path, body: r.body }))
  report.scenarios.inFlightTyping = {
    duringPending: during,
    releasedHeldRequests: released,
    afterRelease: after,
    writeBodies,
    finalContainsBoth: writeBodies.some((w) => (w.body ?? '').includes('第一段') && (w.body ?? '').includes('第二段')),
  }
  await shot('04-inflight-typed-more.png')
}

/* ============================================================ 场景 5
 * 无障碍：「更多」子项为当前页时，关闭状态也要能表达；焦点不能掉到 body。
 */
{
  await loadPage({ set: null, end: null })
  const triggerClick = await evaluate(`(() => {
    const trigger = document.querySelector('.sj-nav__overflow > button')
    if (!trigger) return false
    trigger.click()
    return true
  })()`)
  await sleep(500)
  const opened = await evaluate(`(() => {
    const trigger = document.querySelector('.sj-nav__overflow > button')
    return {
      expanded: trigger?.getAttribute('aria-expanded'),
      label: trigger?.getAttribute('aria-label'),
      focusedText: document.activeElement?.textContent?.trim() ?? null,
      items: [...document.querySelectorAll('.sj-nav__menu-item')].map((b) => b.textContent.trim()),
    }
  })()`)
  const clickedSchedule = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.sj-nav__menu-item')].find((b) => b.textContent.trim() === '日程')
    if (!item) return false
    item.click()
    return true
  })()`)
  await sleep(800)
  const closed = await evaluate(`(() => {
    const trigger = document.querySelector('.sj-nav__overflow > button')
    return {
      expanded: trigger?.getAttribute('aria-expanded'),
      label: trigger?.getAttribute('aria-label'),
      tip: trigger?.getAttribute('data-tip'),
      hasPopup: trigger?.getAttribute('aria-haspopup'),
      focusIsTrigger: document.activeElement === trigger,
      focusedTag: document.activeElement?.tagName ?? null,
      currentLabels: [...document.querySelectorAll('[aria-current="page"]')]
        .map((n) => n.getAttribute('aria-label') ?? n.textContent.trim()),
    }
  })()`)
  const reopen = await evaluate(`(() => {
    document.querySelector('.sj-nav__overflow > button')?.click()
    return true
  })()`)
  await sleep(500)
  const reopened = await evaluate(`(() => ({
    currentInMenu: [...document.querySelectorAll('.sj-nav__menu-item')]
      .filter((n) => n.getAttribute('aria-current') === 'page')
      .map((n) => n.textContent.trim()),
  }))()`)
  await shot('05-more-menu-a11y.png')
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)
  const afterEsc = await evaluate(`(() => ({
    expanded: document.querySelector('.sj-nav__overflow > button')?.getAttribute('aria-expanded'),
    focusIsTrigger: document.activeElement === document.querySelector('.sj-nav__overflow > button'),
  }))()`)
  report.scenarios.overflowA11y = {
    triggerClick, opened, clickedSchedule, closed, reopen, reopened, afterEsc,
  }
}

/* ============================================================ 场景 6
 * 命名：目标页标题与导航一致（速记 / 计划 / 复盘 / AI 复盘）。
 */
{
  await loadPage({ set: journal(101, 'set', '', '计划正文', BUSINESS_DATE), end: null })
  await clickNav('速记')
  await waitFor(`document.querySelector('.writing-eyebrow') !== null`)
  const writing = await evaluate(`(() => ({
    eyebrow: document.querySelector('.writing-eyebrow')?.textContent ?? null,
    ariaLabel: document.querySelector('.writing-page')?.getAttribute('aria-label') ?? null,
  }))()`)
  await shot('06-writing-naming.png')

  await loadPage({ set: journal(101, 'set', '', '计划正文', BUSINESS_DATE), end: null })
  await clickHero('计划')
  await waitFor(`document.querySelector('.ritual-eyebrow') !== null`)
  const plan = await evaluate(`(() => ({
    eyebrow: document.querySelector('.ritual-eyebrow')?.textContent ?? null,
    title: document.querySelector('.ritual-title')?.textContent?.trim() ?? null,
  }))()`)
  await shot('07-plan-naming.png')

  await loadPage({ set: journal(101, 'set', '', '计划正文', BUSINESS_DATE), end: null })
  const openMore = await evaluate(`(() => { document.querySelector('.sj-nav__overflow > button')?.click(); return true })()`)
  await sleep(400)
  const clickAiReview = await evaluate(`(() => {
    const item = [...document.querySelectorAll('.sj-nav__menu-item')].find((b) => b.textContent.trim() === 'AI 复盘')
    if (!item) return false
    item.click()
    return true
  })()`)
  await sleep(800)
  const review = await evaluate(`(() => ({
    heading: document.querySelector('.review-page h2')?.textContent ?? null,
    ariaLabel: document.querySelector('.review-page')?.getAttribute('aria-label') ?? null,
  }))()`)
  await shot('08-ai-review-naming.png')
  report.scenarios.naming = { writing, plan, openMore, clickAiReview, review }
}

/* ============================================================ 汇总 */
report.requests = apiLog.map((r) => `${r.method} ${r.path}`)
report.writeRequestCount = writeRequests().length
report.endedAt = new Date().toISOString()
writeFileSync(`${OUT}/harness-report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  scenarios: Object.fromEntries(Object.entries(report.scenarios).map(([k, v]) => [k, summarize(v)])),
  consoleErrors: report.console,
}, null, 2))

function summarize(value) {
  const keys = ['left', 'blocked', 'finalContainsBoth', 'focusIsTrigger', 'label', 'heading', 'eyebrow', 'title']
  const out = {}
  for (const key of keys) if (key in value) out[key] = value[key]
  return out
}

socket.close()
