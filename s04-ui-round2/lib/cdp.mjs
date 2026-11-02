/**
 * 第二轮 UI 证据装置的 CDP 驱动（仅测试用，不属于产品代码）。
 *
 * 只用 Node 内置 `fetch` + 全局 `WebSocket`，不安装任何依赖。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolveApi, apiLog, held, write, world } from './mock-api.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function jsonHeaders() {
  return [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type,If-Match' },
    { name: 'Access-Control-Max-Age', value: '600' },
    { name: 'Cache-Control', value: 'no-store' },
  ]
}

export async function connect(cdpUrl) {
  let page = null
  for (let i = 0; i < 80 && page === null; i += 1) {
    try {
      const list = await fetch(`${cdpUrl}/json/list`).then((r) => r.json())
      page = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl) ?? null
    } catch { /* chrome 尚未就绪 */ }
    if (page === null) await sleep(250)
  }
  if (page === null) throw new Error('找不到可调试页面')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true })
    socket.addEventListener('error', rej, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const handlers = {}
  const consoleErrors = []
  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data)
    if (typeof data.id === 'number' && pending.has(data.id)) {
      pending.get(data.id)(data)
      pending.delete(data.id)
      return
    }
    handlers[data.method]?.(data.params)
  })

  const send = (method, params = {}) => {
    const id = nextId
    nextId += 1
    return new Promise((res, rej) => {
      pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)))
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`求值失败：${result.exceptionDetails.text}`)
    return result.result.value
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  handlers['Log.entryAdded'] = (params) => {
    if (params.entry.level === 'error') consoleErrors.push(params.entry.text)
  }
  handlers['Runtime.consoleAPICalled'] = (params) => {
    const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
    consoleErrors.push(`console.${params.type}: ${text}`)
  }
  handlers['Runtime.exceptionThrown'] = (params) => {
    const d = params.exceptionDetails
    consoleErrors.push(`exception: ${`${d.text} ${d.exception?.description ?? ''}`.replace(/\s+/g, ' ').slice(0, 400)}`)
  }

  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  handlers['Fetch.requestPaused'] = async (params) => {
    const { requestId, request } = params
    try {
      if (!request.url.includes('127.0.0.1:8000/api/')) {
        await send('Fetch.continueRequest', { requestId })
        return
      }
      const isWrite = request.method !== 'GET' && request.method !== 'OPTIONS'
      apiLog.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.postData ?? null,
      })
      if (isWrite && write.mode === 'hold') {
        held.push({ requestId, request })
        return
      }
      if (isWrite && write.mode === 'abort') {
        // 请求层断网：Fetch 拦截的请求已被接管，emulateNetworkConditions 对它无效，
        // 只能用 failRequest 模拟「请求根本没到达服务器」。
        await send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' })
        return
      }
      if (isWrite && write.mode === 'fail500') {
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 500,
          responseHeaders: jsonHeaders(),
          body: Buffer.from(JSON.stringify({ detail: 'mock 写入失败' })).toString('base64'),
        })
        return
      }
      if (isWrite && write.mode === 'conflict409') {
        await send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 409,
          responseHeaders: jsonHeaders(),
          body: Buffer.from(JSON.stringify({ detail: '版本冲突：服务器上已有更新的版本' })).toString('base64'),
        })
        return
      }
      const [status, body] = resolveApi(request.url, request.method, request.postData)
      await send('Fetch.fulfillRequest', {
        requestId,
        responseCode: status,
        responseHeaders: jsonHeaders(),
        body: body === null ? '' : Buffer.from(JSON.stringify(body)).toString('base64'),
      })
    } catch { /* 已取消的请求 */ }
  }

  const releaseHeld = async (respond = true) => {
    const queue = held.splice(0)
    for (const item of queue) {
      if (!respond) {
        await send('Fetch.failRequest', { requestId: item.requestId, errorReason: 'Aborted' })
        continue
      }
      const [status, body] = resolveApi(item.request.url, item.request.method, item.request.postData)
      await send('Fetch.fulfillRequest', {
        requestId: item.requestId,
        responseCode: status,
        responseHeaders: jsonHeaders(),
        body: Buffer.from(JSON.stringify(body)).toString('base64'),
      })
    }
    return queue.length
  }

  const shot = async (dir, name) => {
    mkdirSync(dir, { recursive: true })
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${dir}/${name}`, Buffer.from(data, 'base64'))
    return `${dir}/${name}`
  }

  const waitFor = async (expression, timeout = 8000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      try { if (await evaluate(expression)) return true } catch { /* 导航中 */ }
      await sleep(120)
    }
    return false
  }

  /** 真实按键序列（keyDown + text），让 ProseMirror 的输入规则按真实路径触发。 */
  const pressKey = async (key, code, virtualKeyCode) => {
    const text = key.length === 1 ? key : undefined
    const base = { key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text, unmodifiedText: text, ...base })
    await sleep(12)
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    await sleep(12)
  }

  const KEY = {
    '-': ['-', 'Minus', 189],
    ' ': [' ', 'Space', 32],
    '[': ['[', 'BracketLeft', 219],
    ']': [']', 'BracketRight', 221],
    '.': ['.', 'Period', 190],
    Enter: ['Enter', 'Enter', 13],
    Tab: ['Tab', 'Tab', 9],
    Escape: ['Escape', 'Escape', 27],
    Backspace: ['Backspace', 'Backspace', 8],
    ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37],
    ArrowRight: ['ArrowRight', 'ArrowRight', 39],
    Home: ['Home', 'Home', 36],
  }
  const charSpec = (ch) => {
    if (KEY[ch] !== undefined) return KEY[ch]
    if (/[a-zA-Z]/.test(ch)) return [ch, `Key${ch.toUpperCase()}`, ch.toUpperCase().charCodeAt(0)]
    if (/[0-9]/.test(ch)) return [ch, `Digit${ch}`, ch.charCodeAt(0)]
    return [ch, '', 0]
  }
  const type = async (text) => {
    for (const ch of text) {
      const [key, code, vk] = charSpec(ch)
      await pressKey(key, code, vk)
    }
  }
  const press = async (name) => {
    const [key, code, vk] = KEY[name]
    await pressKey(key, code, vk)
  }

  const clickBySelector = async (selector) => {
    const ok = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (node === null) return false
      node.click()
      return true
    })()`)
    await sleep(400)
    return ok
  }

  const clickByLabel = async (selector, label) => {
    const ok = await evaluate(`(() => {
      const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((item) => (item.getAttribute('aria-label') ?? item.textContent ?? '').trim() === ${JSON.stringify(label)})
      if (node === null || node === undefined) return false
      node.click()
      return true
    })()`)
    await sleep(500)
    return ok
  }

  /** 鼠标移动（沉浸模式的「重新显示」触发源）。 */
  const moveMouse = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await sleep(200)
  }

  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  }

  const clearLocalDrafts = async (origin) => {
    try {
      await send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' })
    } catch { /* 清不掉时报告里体现为计数偏差 */ }
  }

  return {
    send, evaluate, shot, waitFor, type, press, pressKey,
    clickBySelector, clickByLabel, moveMouse, setViewport, clearLocalDrafts,
    releaseHeld, consoleErrors, world, apiLog, close: () => socket.close(),
  }
}

export const writeRequests = () => apiLog.filter((r) => r.method !== 'GET' && r.method !== 'OPTIONS')

export function resetLog() {
  apiLog.length = 0
}
