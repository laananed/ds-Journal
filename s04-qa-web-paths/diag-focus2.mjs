/**
 * 焦点 / 节点身份诊断（修复后）：区分「产品丢焦点」与「无头浏览器 activeElement 抖动」。
 *
 * 采样 15ms，记录 activeElement 的标签、contenteditable、document.hasFocus()、
 * 以及节点身份标记；只打印状态发生变化的那几条，便于对齐自动保存时刻。
 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const out = {}

async function api(path, options) {
  return await (await fetch(BASE + path, options)).json()
}

let session = null

async function openModule(label) {
  await session.goto(BASE + '/')
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}

async function focusEnd() {
  await session.eval(`(() => { document.querySelector('.s4-editor-content').focus(); return true })()`)
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await sleep(50)
}

async function sample(ms) {
  await session.eval(`(() => {
    window.__s = []; clearInterval(window.__st)
    window.__st = setInterval(() => {
      const el = document.querySelector('.s4-editor-content')
      const a = document.activeElement
      window.__s.push({
        t: Date.now(),
        active: a === el,
        tag: a ? a.tagName : null,
        cls: a && a.className ? String(a.className).slice(0, 40) : null,
        hasFocus: document.hasFocus(),
        editable: el?.getAttribute('contenteditable') ?? null,
        mark: el?.dataset.qaMark ?? null,
      })
    }, 15)
    return true
  })()`)
  await sleep(ms)
  const raw = await session.eval(`(() => { clearInterval(window.__st); return window.__s })()`)
  const changes = []
  let last = null
  for (const point of raw) {
    const key = `${point.active}|${point.tag}|${point.cls}|${point.hasFocus}|${point.editable}|${point.mark}`
    if (key !== last) { changes.push(point); last = key }
  }
  return { total: raw.length, changes, raw }
}

async function scenario(label, moduleLabel, key) {
  await api('/__mock/reset', { method: 'POST' })
  await openModule(moduleLabel)
  await focusEnd()
  await session.send('Input.insertText', { text: `焦点诊断 ${key} 基线句。` })
  await sleep(2600)
  await session.eval(`(() => { const el = document.querySelector('.s4-editor-content'); el.dataset.qaMark = ${JSON.stringify(key)}; el.focus(); return true })()`)
  await focusEnd()
  const t0 = Date.now()
  const sampler = sample(2600)
  await sleep(60)
  await session.send('Input.insertText', { text: ' 追加。' })
  const result = await sampler
  await sleep(300)
  const typing = await (async () => {
    await session.send('Input.insertText', { text: '续写' })
    await sleep(150)
    return await session.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
  })()
  out[label] = {
    totalSamples: result.total,
    changes: result.changes.map((c) => ({ dt: c.t - t0, active: c.active, tag: c.tag, cls: c.cls, hasFocus: c.hasFocus, editable: c.editable, mark: c.mark })),
    typingLanded: typing.includes('续写'),
    text: typing,
  }
}

const { child, wsUrl } = await launch({ port: 9249 })
session = await openSession(wsUrl)
try {
  await scenario('set', '开始今天', 'S')
  await scenario('writing', '写作', 'W')
} finally {
  await session.close()
  child.kill()
}
console.log(JSON.stringify(out, null, 1))
