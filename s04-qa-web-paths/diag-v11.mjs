/**
 * V11 单独诊断：组合中真实点击导航（blur → compositionend → click）。
 * 逐步打印模块状态、对话框、写请求与正文，定位卡在哪一步。
 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const out = { steps: [] }

let session = null
const log = (label, value) => { out.steps.push({ label, value }) ; console.log(label, JSON.stringify(value)) }

async function realClickText(label) {
  const box = await session.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled }
  })()`)
  if (box === null) throw new Error(`找不到按钮：${label}`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(150)
  return box
}

const snapshot = async () => await session.eval(`(() => {
  const dialog = document.querySelector('dialog')
  return {
    ritual: document.querySelector('.ritual-page') !== null,
    writing: document.querySelector('.writing-page') !== null,
    dashboard: document.querySelector('.dashboard-module') !== null,
    pressed: [...document.querySelectorAll('nav button')].map((b) => b.textContent.trim() + ':' + b.getAttribute('aria-pressed') + (b.disabled ? ':disabled' : '')),
    dialog: dialog ? { open: dialog.open, title: dialog.querySelector('h2')?.textContent ?? '' } : null,
    editorText: document.querySelector('.s4-editor-content')?.innerText ?? null,
    status: document.querySelector('.ritual-status')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
  }
})()`)

const { child, wsUrl } = await launch({ port: 9250 })
session = await openSession(wsUrl)
try {
  await api('/__mock/reset', { method: 'POST' })
  await session.goto(BASE + '/')
  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
  await session.eval(`document.querySelector('.s4-editor-content').focus()`)
  await session.send('Input.insertText', { text: 'V11 已保存句。' })
  await sleep(2600)
  log('saved', await snapshot())

  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(400)
  log('composing', await snapshot())

  await realClickText('写作')
  await sleep(600)
  log('after-click-600ms', await snapshot())
  await sleep(1800)
  log('after-click-2400ms', await snapshot())
  log('writes', (await api('/__mock/log')).requests.map((r) => ({ dt: r.iso - t0, method: r.method, text: r.text ?? null })))
  log('journal', (await api('/__mock/state')).journals.map((j) => ({ id: j.id, kind: j.journal_kind, rev: j.revision, text: j.content })))

  // 若出现确认框，先记录再关闭
  const dialogOpen = await session.eval(`(() => { const d = document.querySelector('dialog'); return d ? d.open : false })()`)
  if (dialogOpen) {
    log('dialog-buttons', await session.eval(`[...document.querySelectorAll('dialog button')].map((b) => b.textContent.trim())`))
    await realClickText('继续编辑')
    await sleep(600)
    log('after-keep-editing', await snapshot())
  }

  // 回到「开始今天」：验证离开 Set 时是否留下 ime 残留
  await realClickText('开始今天')
  await sleep(600)
  log('back-600ms', await snapshot())
  await sleep(2000)
  log('back-2600ms', await snapshot())
  const dialog2 = await session.eval(`(() => { const d = document.querySelector('dialog'); return d ? d.open : false })()`)
  if (dialog2) {
    log('back-dialog-buttons', await session.eval(`[...document.querySelectorAll('dialog button')].map((b) => b.textContent.trim())`))
    await realClickText('继续编辑')
    await sleep(800)
    log('back-after-continue', await snapshot())
  }
} finally {
  await session.close()
  child.kill()
}
console.log(JSON.stringify(out, null, 1).slice(0, 100))
