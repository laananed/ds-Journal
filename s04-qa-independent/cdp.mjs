/**
 * 极简 CDP 驱动（无第三方依赖）：用 Chrome/Edge 的 DevTools 协议操作真实页面。
 * 只服务于本轮 QA 夹具，不进入产品代码。
 */
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

const CHROME = process.env.QA_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch { /* 还没起来 */ }
    if (Date.now() - start > timeoutMs) throw new Error(`调试端口未就绪：${url}`)
    await sleep(150)
  }
}

export async function launch({ port = 9223, width = 1280, height = 900 } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'sj-qa-'))
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    'about:blank',
  ]
  const child = spawn(CHROME, args, { stdio: 'ignore' })
  const version = await waitForHttp(`http://127.0.0.1:${port}/json/version`)
  return { child, wsUrl: version.webSocketDebuggerUrl, profile }
}

export class Session {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.sessionId = null
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', reject)
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
        else resolve(msg.result)
        return
      }
      this.events.push(msg)
      if (this.events.length > 500) this.events.shift()
    })
  }

  async send(method, params = {}, useSession = true) {
    await this.ready
    const id = ++this.id
    const payload = { id, method, params }
    if (useSession && this.sessionId !== null) payload.sessionId = this.sessionId
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    this.ws.send(JSON.stringify(payload))
    return promise
  }

  async attach() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' }, false)
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false)
    this.sessionId = sessionId
    this.targetId = targetId
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Network.enable')
    await this.send('Log.enable')
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
    await sleep(600)
    await this.waitFor('document.readyState === "complete"', 15000)
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常：${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`)
    }
    return result.result?.value
  }

  async waitFor(expression, timeoutMs = 10000, label = expression) {
    const start = Date.now()
    for (;;) {
      let value = false
      try { value = await this.eval(`Boolean(${expression})`) } catch { value = false }
      if (value === true) return true
      if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
      await sleep(120)
    }
  }

  async clickText(label, { index = 0 } = {}) {
    const clicked = await this.eval(`(() => {
      const wanted = ${JSON.stringify(label)}
      const nodes = [...document.querySelectorAll('button, a, [role="button"]')]
        .filter((el) => el.textContent.trim() === wanted && !el.disabled)
      const el = nodes[${index}]
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!clicked) throw new Error(`找不到可点击按钮：${label}`)
    await sleep(150)
  }

  async clickContains(fragment) {
    const clicked = await this.eval(`(() => {
      const el = [...document.querySelectorAll('button, a, [role="button"]')]
        .find((n) => n.textContent.includes(${JSON.stringify(fragment)}) && !n.disabled)
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!clicked) throw new Error(`找不到包含文字的按钮：${fragment}`)
    await sleep(150)
  }

  async setInput(selector, value) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    if (!ok) throw new Error(`找不到输入框：${selector}`)
    await sleep(120)
  }

  /** 在正文编辑器里输入文字（真实 insertText，走 ProseMirror 的 beforeinput）。 */
  async typeBody(text) {
    const focused = await this.eval(`(() => {
      const el = document.querySelector('.s4-editor-content')
      if (!el) return false
      el.focus()
      return true
    })()`)
    if (!focused) throw new Error('找不到正文编辑器')
    await this.send('Input.insertText', { text })
    await sleep(150)
  }

  async bodyText() {
    return await this.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(path, Buffer.from(data, 'base64'))
  }

  async setOffline(offline) {
    await this.send('Network.emulateNetworkConditions', {
      offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    })
  }

  /**
   * 在每个新文档里安装事件记录器。
   *
   * 只记录浏览器真实派发的事件（CDP 的 IME 命令会产生这些事件），
   * 不用 JS 合成 CompositionEvent —— 合成事件不能代表真实输入法行为。
   */
  async installRecorder() {
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__qa = { ev: [], installedAt: Date.now() }
        for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'keydown']) {
          document.addEventListener(type, (e) => {
            window.__qa.ev.push({
              type,
              data: e.data ?? null,
              inputType: e.inputType ?? null,
              key: e.key ?? null,
              iso: Date.now(),
            })
          }, true)
        }
      `,
    })
  }

  async qaEvents() {
    return await this.eval(`window.__qa ? window.__qa.ev : []`)
  }

  async clearQaEvents() {
    await this.eval(`(() => { if (window.__qa) window.__qa.ev.length = 0; return true })()`)
  }

  /** 组合中（preedit）：浏览器层真实派发 compositionstart / compositionupdate。 */
  async imeSet(text, selectionStart = text.length, selectionEnd = text.length) {
    await this.send('Input.imeSetComposition', { text, selectionStart, selectionEnd })
  }

  /** 上屏提交：走真实的 insertText，会以 compositionend 收尾。 */
  async imeCommit(text) {
    await this.send('Input.insertText', { text })
  }

  /** 取消 preedit（等价于把组合文本清空）；部分真实输入法的 Esc 取消无法据此模拟。 */
  async imeCancel() {
    await this.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  }

  async networkLog() {
    const { body } = await this.send('Network.getAllCookies').catch(() => ({ body: null }))
    return body
  }

  async close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

export async function openSession(wsUrl) {
  const session = new Session(wsUrl)
  await session.attach()
  return session
}
