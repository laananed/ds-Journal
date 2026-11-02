/**
 * 第一轮 UI 调整 · 独立测试装置（不属于产品代码，仅本轮证据）。
 *
 * 真实生产构建产物（独立目录 dist-app）+ 真实 App 组件；
 * 只在 CDP `Fetch` 域拦截 `127.0.0.1:8000/api/*`，用合成数据应答。
 * 不启动后端、不连数据库、不调用模型，全程不会产生任何真实写入。
 *
 * 用法：node harness.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = 'http://127.0.0.1:5399/'
const CDP = 'http://127.0.0.1:9223'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round1-independent'
const SHOTS = `${OUT}/shots`
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const report = { startedAt: new Date().toISOString(), scenarios: {}, nav: {}, requests: {}, console: [] }
const apiLog = []

/* ------------------------------------------------------------ 合成数据 */
const doc = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', attrs: { id: '11111111-1111-4111-8111-111111111111' }, content: [{ type: 'text', text }] }],
})
const journal = (id, kind, title, body, date) => ({
  type: 'journal', id, title, display_title: title, content: body, revision: 3, folder_id: null,
  created_at: `${date}T23:10:00.000000+08:00`, updated_at: `${date}T23:20:00.000000+08:00`,
  deleted_at: null, journal_date: date, journal_kind: kind, content_doc: doc(body),
  document_schema_version: 1, document_format: 'tiptap',
})

const BUSINESS_DATE = '2026-11-01' // 故意与运行环境本地日期（2026-11-02）不同
const businessDay = {
  timezone: 'Asia/Shanghai', day_start_hour: 4,
  server_time: '2026-11-01T23:30:00.123456+08:00', business_date: BUSINESS_DATE,
}
const emptyPage = { items: [], page: 1, page_size: 20, total: 0, has_next: false }

let mode = 'empty'
const MODES = {
  empty: { set: null, end: null, writings: [], fail: 0, delay: 0 },
  plan: { set: journal(101, 'set', '今天的计划', '已有计划的正文', BUSINESS_DATE), end: null, writings: [], fail: 0, delay: 0 },
  end: { set: journal(101, 'set', '今天的计划', '已有计划的正文', BUSINESS_DATE), end: journal(102, 'end', '今天的复盘', '已有复盘的正文', BUSINESS_DATE), writings: [], fail: 0, delay: 0 },
  writings: { set: null, end: null, writings: [journal(201, 'writing', '', '第一篇速记', BUSINESS_DATE), journal(202, 'writing', '', '第二篇速记', BUSINESS_DATE)], fail: 0, delay: 0 },
  error: { set: null, end: null, writings: [], fail: 503, delay: 0 },
  loading: { set: null, end: null, writings: [], fail: 0, delay: 2500 },
}

/** 返回 [status, body] */
function resolveApi(url, method) {
  const u = new URL(url)
  const path = u.pathname
  const cfg = MODES[mode]
  if (method === 'OPTIONS') return [204, null]
  if (method !== 'GET') {
    if (path === '/api/journals' && method === 'POST') {
      return [200, journal(501, 'writing', '', '测试速记内容', BUSINESS_DATE)]
    }
    return [200, {}] // 其余写请求不应发生；发生即记入日志
  }
  if (path === '/api/business-day') {
    if (cfg.fail) return [cfg.fail, { detail: 'upstream error' }]
    return [200, businessDay]
  }
  if (path === '/api/rituals') return [200, { journal_date: BUSINESS_DATE, set: cfg.set, end: cfg.end }]
  if (path === '/api/ritual-templates') return [200, { set: { questions: [], revision: 1 }, end: { questions: [], revision: 1 } }]
  if (path === '/api/journals') return [200, { items: cfg.writings, page: 1, page_size: 20, total: cfg.writings.length, has_next: false }]
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
  if (path.startsWith('/api/schedules')) return [200, { items: [], page: 1, page_size: 20, total: 0, has_next: false }]
  return [200, emptyPage]
}

/* ------------------------------------------------------------ CDP */
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
handlers['Log.entryAdded'] = (p) => { if (p.entry.level === 'error') { report.console.push(p.entry.text); console.error('[LOG]', p.entry.text) } }
handlers['Runtime.exceptionThrown'] = (p) => {
  const d = p.exceptionDetails
  const text = `${d.text} ${d.exception?.description ?? ''}`.replace(/\s+/g, ' ').slice(0, 600)
  report.console.push(`exception: ${text}`)
  console.error('[EXC]', text)
}
handlers['Runtime.consoleAPICalled'] = (p) => {
  if (p.type !== 'error' && p.type !== 'warning') return
  const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 400)
  report.console.push(`console.${p.type}: ${text}`)
  console.error(`[CONSOLE.${p.type}]`, text)
}

await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
handlers['Fetch.requestPaused'] = async (p) => {
  const { requestId, request } = p
  const isApi = request.url.includes('127.0.0.1:8000/api/')
  try {
    if (!isApi) { await send('Fetch.continueRequest', { requestId }); return }
    const cfg = MODES[mode]
    apiLog.push({ method: request.method, url: request.url })
    // 请求可能已被页面 abort（React 开发期双调用 / 快速切页），拦截 ID 随即失效；
    // 这类失败不计入产品缺陷，只记录为 skipped。
    if (cfg.delay) {
      await sleep(cfg.delay)
      if (!pendingOrActive(requestId)) return
    }
    const [status, body] = resolveApi(request.url, request.method)
    const headers = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Access-Control-Allow-Origin', value: '*' },
      { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' },
      { name: 'Access-Control-Allow-Headers', value: 'Content-Type,If-Match' },
      { name: 'Access-Control-Max-Age', value: '600' },
      { name: 'Cache-Control', value: 'no-store' },
    ]
    await send('Fetch.fulfillRequest', {
      requestId, responseCode: status,
      responseHeaders: headers,
      body: body === null ? '' : Buffer.from(JSON.stringify(body)).toString('base64'),
    })
  } catch (error) {
    report.skippedInterceptions = (report.skippedInterceptions ?? 0) + 1
  }
}
function pendingOrActive() { return true }

async function loadPage(m, width = 1440, height = 900) {
  mode = m
  apiLog.length = 0
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: APP })
  await sleep(400)
  return apiLog
}

/* ------------------------------------------------------------ 场景 1：空数据 */
{
  await loadPage('empty')
  await waitFor(`document.querySelector('.dash-hero') !== null`)
  await sleep(400)
  const s = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.dash-action')].map(b => ({
      text: b.textContent.trim(), disabled: b.disabled,
      describedBy: b.getAttribute('aria-describedby'),
      bg: getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color,
      opacity: getComputedStyle(b).opacity,
    }))
    return {
      bodyBg: getComputedStyle(document.body).backgroundColor,
      dateLabel: document.querySelector('.dash-hero-eyebrow')?.textContent ?? null,
      title: document.querySelector('.dash-hero-title')?.textContent ?? null,
      note: document.querySelector('#dash-hero-note')?.textContent ?? null,
      meta: document.querySelector('.dash-meta')?.textContent ?? null,
      buttons: btn,
      quick: document.querySelector('.dash-quick')?.textContent ?? null,
      navCount: document.querySelectorAll('.sj-nav__main .sj-nav__item').length,
      sidebar: getComputedStyle(document.querySelector('.sj-shell__sidebar')).width,
    }
  })()`)
  s.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  report.scenarios.empty = s
  await shot('01-desktop-empty-disabled.png')
}

/* ------------------------------------------------------------ 场景 2：有计划 */
{
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  report.scenarios.plan = await evaluate(`(() => ({
    note: document.querySelector('#dash-hero-note')?.textContent ?? null,
    buttons: [...document.querySelectorAll('.dash-action')].map(b => ({ text: b.textContent.trim(), disabled: b.disabled })),
    requests: null,
  }))()`)
  report.scenarios.plan.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('02-desktop-plan-enabled.png')
}

/* ------------------------------------------------------------ 场景 3：已有复盘 */
{
  await loadPage('end')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  report.scenarios.end = await evaluate(`(() => ({
    note: document.querySelector('#dash-hero-note')?.textContent ?? null,
    buttons: [...document.querySelectorAll('.dash-action')].map(b => ({ text: b.textContent.trim(), disabled: b.disabled })),
  }))()`)
  await shot('03-desktop-end.png')
}

/* ------------------------------------------------------------ 场景 4：多篇速记 */
{
  await loadPage('writings')
  await waitFor(`document.querySelector('.dash-meta') !== null`)
  await sleep(300)
  report.scenarios.writings = await evaluate(`document.querySelector('.dash-meta')?.textContent ?? null`)
}

/* ------------------------------------------------------------ 场景 5：接口失败 + 重试 */
{
  await loadPage('error')
  await waitFor(`document.querySelector('.dash-hero--error') !== null`)
  await sleep(300)
  const err = await evaluate(`(() => ({
    role: document.querySelector('.dash-hero--error')?.getAttribute('role') ?? null,
    kind: document.querySelector('.dash-hero--error')?.className ?? null,
    title: document.querySelector('.dash-hero--error .dash-hero-title')?.textContent ?? null,
    sub: document.querySelector('.dash-hero--error .dash-hero-sub')?.textContent ?? null,
    note: document.querySelector('.dash-hero--error .dash-hero-note')?.textContent ?? null,
    retry: document.querySelector('.dash-hero--error .dash-action')?.textContent ?? null,
  }))()`)
  err.requestsOnError = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('04-desktop-error.png')
  // 重试：把 mock 切回 empty 后点「重新读取」，必须只重新 GET
  mode = 'empty'
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('.dash-action')].find(b => b.textContent.includes('重新读取'))?.click()`)
  await waitFor(`document.querySelector('.dash-hero-title')?.textContent === '先计划，再复盘'`)
  await sleep(300)
  err.requestsOnRetry = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  err.afterRetryTitle = await evaluate(`document.querySelector('.dash-hero-title')?.textContent ?? null`)
  report.scenarios.error = err
}

/* ------------------------------------------------------------ 场景 6：加载中 */
{
  await send('Page.navigate', { url: APP })
  mode = 'loading'
  apiLog.length = 0
  await sleep(150)
  await send('Page.navigate', { url: APP })
  await waitFor(`document.querySelector('.dash-hero--loading') !== null`, 4000)
  report.scenarios.loading = await evaluate(`(() => ({
    busy: document.querySelector('.dash-hero--loading')?.getAttribute('aria-busy') ?? null,
    live: document.querySelector('.dash-hero--loading')?.getAttribute('aria-live') ?? null,
    text: document.querySelector('.dash-hero-status')?.textContent ?? null,
    skeletons: document.querySelectorAll('.dash-skeleton-row').length,
  }))()`)
  await shot('05-desktop-loading.png')
  await sleep(2600)
}

/* ------------------------------------------------------------ 场景 7：导航接线 */
{
  const nav = { steps: [] }
  const click = async (label, shotName) => {
    // 每项独立重载再点击：避免上一页的「离开确认」弹窗干扰后续项。
    await loadPage('plan')
    await waitFor(`document.querySelector('.dash-hero-title') !== null`)
    await sleep(300)
    apiLog.length = 0
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (el) el.click()
      return el !== undefined
    })()`)
    await sleep(900)
    const state = await evaluate(`(() => {
      const cur = [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim())
      const main = document.querySelector('.sj-shell__main')
      return {
        current: cur,
        heading: document.querySelector('.sj-shell__main h1, .sj-shell__main h2')?.textContent?.trim() ?? null,
        text: (main?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 120),
        dialogOpen: document.querySelector('dialog')?.open ?? false,
      }
    })()`)
    state.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
    nav.steps.push({ click: label, ...state })
    if (shotName) await shot(shotName)
  }
  await click('速记', '06-nav-quick.png')
  await click('记录', '07-nav-records.png')
  await click('洞察', '08-nav-insight.png')
  await click('概览', '09-nav-overview.png')

  // 「更多」菜单：重载后展开
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '更多')?.click()`)
  await sleep(450)
  nav.overflow = await evaluate(`(() => {
    const t = [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '更多')
    return {
      expanded: t?.getAttribute('aria-expanded') ?? null,
      items: [...document.querySelectorAll('.sj-nav__menu-item')].map(e => e.textContent.trim()),
      focused: document.activeElement?.textContent?.trim() ?? null,
      focusedLabel: document.activeElement?.getAttribute('aria-label') ?? null,
    }
  })()`)
  await shot('10-nav-more-menu.png')

  // 菜单项逐项验证（每次重载 + 展开 + 点第 N 项）
  for (const label of ['日程', 'AI 复盘', '历史收件箱', '文件夹']) {
    await loadPage('plan')
    await waitFor(`document.querySelector('.dash-hero-title') !== null`)
    await sleep(300)
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '更多')?.click()`)
    await sleep(300)
    apiLog.length = 0
    await evaluate(`(() => {
      const item = [...document.querySelectorAll('.sj-nav__menu-item')].find(e => e.textContent.trim() === ${JSON.stringify(label)})
      if (item) item.click()
      return item !== undefined
    })()`)
    await sleep(900)
    const st = await evaluate(`(() => ({
      current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
      overflowActive: [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '更多')?.dataset.active ?? null,
      text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 110),
    }))()`)
    st.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
    nav.steps.push({ click: `更多>${label}`, ...st })
    if (label === 'AI 复盘') await shot('11-nav-ai-review.png')
  }
  // 右下角快捷入口
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  const shortcuts = await evaluate(`(() => {
    const box = document.querySelector('.sj-shortcuts')
    if (box === null) return { exists: false, rootHtml: (document.getElementById('root')?.innerHTML ?? '').slice(0, 200) }
    const r = box.getBoundingClientRect()
    return {
      exists: true,
      items: [...box.querySelectorAll('button')].map(b => b.getAttribute('aria-label')),
      right: Math.round(window.innerWidth - r.right),
      bottom: Math.round(window.innerHeight - r.bottom),
      vertical: [...box.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top)),
    }
  })()`)
  nav.shortcuts = shortcuts
  for (const label of ['搜索', '设置', '回收箱']) {
    await loadPage('plan')
    await waitFor(`document.querySelector('.dash-hero-title') !== null`)
    await sleep(300)
    apiLog.length = 0
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('.sj-shortcuts button')].find(b => b.getAttribute('aria-label') === ${JSON.stringify(label)})
      if (el) el.click()
      return el !== undefined
    })()`)
    await sleep(900)
    const st = await evaluate(`(() => ({
      current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
      text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 100),
    }))()`)
    st.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
    nav.steps.push({ click: `快捷>${label}`, ...st })
    if (label === '回收箱') await shot('12-shortcut-trash.png')
  }
  report.nav = nav
  report.requests.nav = '见各 step.requests'
}

/* ------------------------------------------------------------ 场景 8：首页 → 计划 → 复盘 → 返回 */
{
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('.dash-action')].find(b => b.textContent.trim() === '计划')?.click()`)
  await sleep(1400)
  const plan = await evaluate(`(() => ({
    text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 260),
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
    hasExistingBody: (document.body.innerText || '').includes('已有计划的正文'),
  }))()`)
  plan.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('13-plan-existing.png')

  // 返回首页（品牌按钮）
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('回到概览'))?.click()`)
  await sleep(1200)
  const back = await evaluate(`(() => ({
    title: document.querySelector('.dash-hero-title')?.textContent ?? null,
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
  }))()`)
  back.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('14-back-home.png')

  // 进入复盘（已有计划 → 可用）
  await loadPage('end')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('.dash-action')].find(b => b.textContent.trim() === '复盘')?.click()`)
  await sleep(1400)
  const endStep = await evaluate(`(() => ({
    hasExistingBody: (document.body.innerText || '').includes('已有复盘的正文'),
    text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200),
  }))()`)
  endStep.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('15-end-existing.png')

  report.scenarios.flow = { plan, back, end: endStep }
}

/* ------------------------------------------------------------ 场景 9：键盘 */
{
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(400)
  await evaluate(`document.activeElement?.blur()`)
  await send('Runtime.evaluate', { expression: 'window.focus(); document.body.focus()' })
  const order = []
  for (let i = 0; i < 14; i += 1) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    await sleep(90)
    order.push(await evaluate(`(() => {
      const el = document.activeElement
      if (!el || el === document.body) return 'BODY'
      return (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24)
    })()`))
  }
  // 焦点可见性：聚焦导航项后取计算样式
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '速记')?.focus()`)
  await sleep(120)
  const focusStyle = await evaluate(`(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow.slice(0, 80), tip: el.getAttribute('data-tip'),
      tipVisible: (() => { const before = getComputedStyle(el, '::after'); return { content: before.content, opacity: before.opacity } })() }
  })()`)
  // 真实按键 Enter 激活（带 text，触发按钮默认动作）
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(1200)
  const enterResult = await evaluate(`(() => ({
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
    text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 80),
  }))()`)
  await shot('16-keyboard-focus.png')
  report.keyboard = { tabOrder: order, focusStyle, enterResult }
}

/* ------------------------------------------------------------ 场景 10：窄屏 */
{
  await loadPage('empty', 500, 900)
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(400)
  report.scenarios.narrow = await evaluate(`(() => {
    const sidebar = document.querySelector('.sj-shell__sidebar')
    const r = sidebar.getBoundingClientRect()
    const nav = document.querySelector('.sj-nav__main')
    return {
      sidebarWidth: Math.round(r.width),
      sidebarHeight: Math.round(r.height),
      sidebarTop: Math.round(r.top),
      navDirection: getComputedStyle(nav).flexDirection,
      navItems: [...nav.querySelectorAll('.sj-nav__item')].map(b => b.getAttribute('aria-label')),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }
  })()`)
  await shot('17-narrow-empty-disabled.png')

  await loadPage('plan', 500, 900)
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(400)
  report.scenarios.narrowPlan = await evaluate(`(() => ({
    buttons: [...document.querySelectorAll('.dash-action')].map(b => ({ text: b.textContent.trim(), disabled: b.disabled, w: Math.round(b.getBoundingClientRect().width) })),
  }))()`)
  await shot('18-narrow-plan-enabled.png')
}

/* ------------------------------------------------------------ 场景 11：未输入即离开 */
{
  // A：进入速记后立刻离开（编辑器刚挂载）
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '速记')?.click()`)
  await sleep(350)
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '记录')?.click()`)
  await sleep(1200)
  const early = await evaluate(`(() => ({
    dialogOpen: document.querySelector('dialog')?.open ?? false,
    dialogTitle: document.querySelector('#leave-title')?.textContent ?? null,
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
  }))()`)
  early.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)

  // B：进入速记后停留 3.2 秒（不输入）再离开
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '速记')?.click()`)
  await sleep(3200) // 给本地草稿与自动保存队列充分时间
  const before = await evaluate(`(() => ({
    mirror: document.querySelector('.sj-shell__main')?.innerText?.includes('本地草稿待写入') ?? null,
    text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 140),
    idb: null,
  }))()`)
  before.requestsDuringWait = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '记录')?.click()`)
  await sleep(1200)
  const blocked = await evaluate(`(() => {
    const dlg = document.querySelector('dialog')
    return {
      dialogOpen: dlg?.open ?? false,
      dialogTitle: document.querySelector('#leave-title')?.textContent ?? null,
      dialogBody: dlg?.querySelector('p')?.textContent ?? null,
      current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
    }
  })()`)
  blocked.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('19-leave-dialog-on-empty-draft.png')

  // C：选择「继续编辑」后改走品牌标识回概览
  await evaluate(`[...document.querySelectorAll('dialog button')].find(b => b.textContent.trim() === '继续编辑')?.click()`)
  await sleep(800)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes('回到概览'))?.click()`)
  await sleep(1200)
  const brandBack = await evaluate(`(() => ({
    dialogOpen: document.querySelector('dialog')?.open ?? false,
    dialogTitle: document.querySelector('#leave-title')?.textContent ?? null,
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
    text: (document.querySelector('.sj-shell__main')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 60),
  }))()`)
  brandBack.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('20-brand-back-blocked.png')
  report.scenarios.leaveOnEmptyDraft = { early, before, blocked, brandBack }
}

/* ------------------------------------------------------------ 场景 12：输入后离开 */
{
  await loadPage('plan')
  await waitFor(`document.querySelector('.dash-hero-title') !== null`)
  await sleep(300)
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '速记')?.click()`)
  await sleep(1500)
  await evaluate(`document.querySelector('.ProseMirror')?.focus()`)
  await sleep(200)
  await send('Input.insertText', { text: '测试速记内容' })
  await sleep(3200)
  const typed = await evaluate(`(() => ({
    editorText: (document.querySelector('.ProseMirror')?.innerText ?? '').slice(0, 40),
    requests: null,
  }))()`)
  typed.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  typed.writeCount = apiLog.filter((r) => r.method !== 'GET').length
  apiLog.length = 0
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === '记录')?.click()`)
  await sleep(1600)
  const afterLeave = await evaluate(`(() => ({
    dialogOpen: document.querySelector('dialog')?.open ?? false,
    dialogTitle: document.querySelector('#leave-title')?.textContent ?? null,
    current: [...document.querySelectorAll('[aria-current="page"]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
  }))()`)
  afterLeave.requests = apiLog.map((r) => `${r.method} ${new URL(r.url).pathname}`)
  await shot('21-typed-then-leave.png')
  report.scenarios.typedThenLeave = { typed, afterLeave }
}

/* ------------------------------------------------------------ 汇总 */
report.allRequests = apiLog
writeFileSync(`${OUT}/harness-report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  empty: report.scenarios.empty,
  plan: report.scenarios.plan,
  error: report.scenarios.error,
  loading: report.scenarios.loading,
  narrow: report.scenarios.narrow,
}, null, 2))
console.log('NAV_STEPS', report.nav.steps.length, 'SHORTCUTS', JSON.stringify(report.nav.shortcuts))
console.log('OVERFLOW', JSON.stringify(report.nav.overflow))
console.log('KEYBOARD', JSON.stringify(report.keyboard))
console.log('CONSOLE', JSON.stringify(report.console.slice(0, 6)))
socket.close()
