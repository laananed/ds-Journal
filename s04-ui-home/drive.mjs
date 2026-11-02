/**
 * 真实应用导航接线验证（CDP 驱动，不用 Mock 替换组件）。
 *
 * 目的：验证 `App.tsx` 里的真实导航接线——点击左栏图标、更多菜单、右下角快捷入口
 * 是否真的切换模块（`aria-current` 与渲染出的页面一起变），并确认全程只有 GET。
 *
 * 说明：本轮不启动后端，因此页面数据区会显示读取失败；这里只判断「模块切换是否正确」，
 * 不把数据加载失败当成导航失败，也不把本脚本当成视觉验收。
 *
 * 用法（chrome 需先以 --remote-debugging-port=9223 启动）：
 *   node s04-ui-home/drive.mjs http://127.0.0.1:5173/ http://127.0.0.1:9223
 */
import { writeFileSync } from 'node:fs'

const appUrl = process.argv[2] ?? 'http://127.0.0.1:5173/'
const cdpBase = process.argv[3] ?? 'http://127.0.0.1:9223'
const outDir = 'C:/Programme/demo/SeekJournal/s04-ui-home'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findPageTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await fetch(`${cdpBase}/json/list`).then((r) => r.json())
      const page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      // chrome 还没起来
    }
    await sleep(250)
  }
  throw new Error('找不到可调试的页面目标')
}

const target = await findPageTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  if (typeof data.id === 'number' && pending.has(data.id)) {
    pending.get(data.id)(data)
    pending.delete(data.id)
  }
})

function send(method, params = {}) {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    pending.set(id, (data) => {
      if (data.error) reject(new Error(`${method}: ${data.error.message}`))
      else resolve(data.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`求值失败：${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception ?? {})}`)
  }
  return result.result.value
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outDir}/${name}`, Buffer.from(data, 'base64'))
}

const log = []
function record(step, detail) {
  log.push({ step, ...detail })
}

await send('Page.enable')
await send('Runtime.enable')

// 在页面脚本之前挂请求记录器：只记录，不改行为
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const calls = [];
    window.__calls = calls;
    const real = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      calls.push({ method: (init && init.method) || 'GET', url });
      return real(input, init);
    };
  })();`,
})

await send('Page.navigate', { url: appUrl })
await sleep(3500)

const navProbe = `(() => {
  const items = [...document.querySelectorAll('.sj-nav__main .sj-nav__item')];
  const shortcuts = [...document.querySelectorAll('.sj-shortcuts__item')];
  const more = document.querySelector('.sj-nav__overflow > button');
  const read = (node) => ({
    label: node.getAttribute('aria-label'),
    tip: node.getAttribute('data-tip') ?? null,
    current: node.getAttribute('aria-current'),
    title: node.getAttribute('title'),
  });
  return {
    nav: items.map(read),
    shortcuts: shortcuts.map(read),
    more: more ? { ...read(more), expanded: more.getAttribute('aria-expanded'), haspopup: more.getAttribute('aria-haspopup') } : null,
    brand: (() => { const b = document.querySelector('.sj-nav__brand'); return b ? read(b) : null })(),
    main: document.querySelector('.sj-shell__main-inner')?.innerText.slice(0, 60) ?? null,
  };
})()`

record('initial', await evaluate(navProbe))

async function click(selectorExpression, label) {
  const clicked = await evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selectorExpression)})]
      .find((item) => item.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!node) return false;
    node.click();
    return true;
  })()`)
  await sleep(1200)
  return clicked
}

/** 依次点击每个入口，记录「谁被选中」与「主区域渲染出什么」。 */
const navSteps = [
  ['速记', 'section[aria-label="写作"]'],
  ['记录', 'h2'],
  ['洞察', 'main'],
  ['概览', 'main'],
]
for (const [label] of navSteps) {
  const clicked = await click('.sj-nav__main .sj-nav__item', label)
  const state = await evaluate(`(() => {
    const active = [...document.querySelectorAll('.sj-nav__main .sj-nav__item')]
      .filter((item) => item.getAttribute('aria-current') === 'page')
      .map((item) => item.getAttribute('aria-label'));
    return { active, main: document.querySelector('.sj-shell__main-inner')?.innerText.slice(0, 80) ?? null };
  })()`)
  record(`nav:${label}`, { clicked, ...state })
}

// 记录页截图：验证「新建记录」已随导航收窄移到列表工具条
await click('.sj-nav__main .sj-nav__item', '记录')
await shot('13-app-records.png')

// 「新建记录」仍是可用入口（原在导航栏，本轮移到工具条）
const newEntry = await evaluate(`(() => {
  const node = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === '新建记录');
  if (!node) return { found: false };
  node.click();
  return { found: true };
})()`)
await sleep(900)
record('records:new', {
  ...newEntry,
  hasEditor: await evaluate(`Boolean(document.querySelector('.journal-editor, textarea, input[type="text"]'))`),
  main: await evaluate(`document.querySelector('.app-content')?.innerText.slice(0, 80) ?? null`),
})
await shot('17-app-new-record.png')
await click('.sj-nav__main .sj-nav__item', '记录')

// 更多菜单
await evaluate(`document.querySelector('.sj-nav__overflow > button').click()`)
await sleep(500)
const menu = await evaluate(`(() => ({
  expanded: document.querySelector('.sj-nav__overflow > button').getAttribute('aria-expanded'),
  items: [...document.querySelectorAll('.sj-nav__menu-item')].map((item) => ({
    text: item.innerText,
    current: item.getAttribute('aria-current'),
  })),
}))()`)
record('more:open', menu)
await shot('14-app-more-menu.png')

for (const label of ['日程', 'AI 复盘', '历史收件箱', '文件夹']) {
  // 菜单可能已经开着（上一步点完会关闭），这里按真实 aria-expanded 决定是否补点一次
  await evaluate(`(() => {
    const trigger = document.querySelector('.sj-nav__overflow > button');
    if (trigger && trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  })()`)
  await sleep(500)
  const clicked = await evaluate(`(() => {
    const node = [...document.querySelectorAll('.sj-nav__menu-item')]
      .find((item) => item.innerText.trim() === ${JSON.stringify(label)});
    if (!node) return false;
    node.click();
    return true;
  })()`)
  await sleep(1200)
  const state = await evaluate(`(() => ({
    active: [...document.querySelectorAll('.sj-nav__main .sj-nav__item, .sj-nav__menu-item')]
      .filter((item) => item.getAttribute('aria-current') === 'page')
      .map((item) => item.getAttribute('aria-label') ?? item.innerText.trim()),
    moreActive: document.querySelector('.sj-nav__overflow > button').getAttribute('data-active'),
    main: document.querySelector('.sj-shell__main-inner')?.innerText.slice(0, 70) ?? null,
  }))()`)
  record(`more:${label}`, { clicked, ...state })
}

// 右下角快捷入口
for (const label of ['搜索', '设置', '回收箱']) {
  const clicked = await click('.sj-shortcuts__item', label)
  const state = await evaluate(`(() => ({
    active: [...document.querySelectorAll('.sj-shortcuts__item')]
      .filter((item) => item.getAttribute('aria-current') === 'page')
      .map((item) => item.getAttribute('aria-label')),
    main: document.querySelector('.sj-shell__main-inner')?.innerText.slice(0, 70) ?? null,
  }))()`)
  record(`shortcut:${label}`, { clicked, ...state })
}
await shot('15-app-trash.png')

// 回到首页：无后端时的失败态（真实应用，未替换组件）
await click('.sj-nav__main .sj-nav__item', '概览')
await shot('16-app-home-no-backend.png')

// 请求方法汇总：只允许 GET
const calls = await evaluate('window.__calls ?? []')
const methods = [...new Set(calls.map((item) => item.method))]

// 键盘可达性：Tab 顺序里的焦点元素
const focusOrder = await evaluate(`(() => {
  const focusables = [...document.querySelectorAll('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => node.offsetParent !== null || node.className.includes('skip'));
  return focusables.slice(0, 14).map((node) => ({
    tag: node.tagName,
    label: node.getAttribute('aria-label') ?? node.innerText?.trim().slice(0, 12) ?? '',
  }));
})()`)

const report = { appUrl, methods, callCount: calls.length, nonGet: calls.filter((c) => c.method !== 'GET'), focusOrder, log }
writeFileSync(`${outDir}/drive-report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ methods, callCount: calls.length, nonGet: report.nonGet.length, steps: log.length }, null, 2))
socket.close()
