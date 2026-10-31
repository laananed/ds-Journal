/** 第十三轮：已保存目标是否被后续正文组合影响（用鼠标点选末尾，确保组合真正生效）。 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const reset = () => api('/__mock/reset', { method: 'POST' })
const readLog = () => api('/__mock/log')
const readState = () => api('/__mock/state')

const { child, wsUrl } = await launch({ port: 9248 })
const s = await openSession(wsUrl)
const out = {}
const editorText = () => s.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
const textOf = (sel) => s.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)

function summarize(j) {
  if (!j) return null
  const goals = []
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return
    if (n.type === 'goalItem') goals.push(n.attrs?.text ?? null)
    if (Array.isArray(n.content)) n.content.forEach(walk)
  }
  walk(j.content_doc)
  return { id: j.id, revision: j.revision, text: j.content, goals }
}
async function journalOf() {
  const st = await readState()
  return summarize(st.journals.find((j) => j.journal_kind === 'set' && j.deleted_at === null) ?? null)
}
async function writesSince(iso) {
  return (await readLog()).requests.filter((r) => r.iso >= iso).map((r) => ({ dt: r.iso - iso, method: r.method, text: r.text ?? null }))
}

/** 用真实鼠标点击正文最后一行末尾，避免 focus()+Ctrl+End 在特殊节点上失效。 */
async function clickLastLineEnd() {
  const pos = await s.eval(`(() => {
    const el = document.querySelector('.s4-editor-content')
    const last = el.lastElementChild || el
    const r = last.getBoundingClientRect()
    return { x: Math.min(r.right - 2, r.left + 200), y: r.top + r.height / 2 }
  })()`)
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
  await sleep(150)
  return await s.eval(`document.activeElement === document.querySelector('.s4-editor-content')`)
}

try {
  await s.installRecorder()
  await reset()
  await s.goto(BASE + '/')
  await s.clickText('开始今天')
  await s.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)

  await s.clickText('☑ 清单')
  await sleep(300)
  await s.eval(`(() => { document.querySelector('.s4-editor-content').focus(); return true })()`)
  await s.send('Input.insertText', { text: '买牛奶' })
  await sleep(2800)
  out.withGoal = { journal: await journalOf(), panel: await textOf('.ritual-goals') }

  await s.eval(`(() => { document.querySelector('.s4-editor-content').focus(); return true })()`)
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await s.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(200)
  await s.send('Input.insertText', { text: '备注段。' })
  await sleep(2600)
  out.withNote = { journal: await journalOf(), editor: await editorText() }

  const clicked = await clickLastLineEnd()
  await s.clearQaEvents()
  const t0 = Date.now()
  await s.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(1500)
  out.polluted = {
    clicked,
    editor: await editorText(),
    events: (await s.qaEvents()).map((e) => ({ dt: e.iso - t0, type: e.type, data: e.data })),
    writes: await writesSince(t0),
    journal: await journalOf(),
    panel: await textOf('.ritual-goals'),
  }

  await s.goto(BASE + '/')
  await s.clickText('开始今天')
  await s.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(1200)
  out.reopened = { editor: await editorText(), panel: await textOf('.ritual-goals'), journal: await journalOf() }
} catch (error) {
  out.error = String(error && error.stack || error)
} finally {
  await s.close()
  child.kill()
}

await writeFile(join('.', 'run13-results.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 1).slice(0, 3000))
