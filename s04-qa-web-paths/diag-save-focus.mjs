/**
 * 诊断二：自动保存期间 Set/End 编辑器是否被切成只读、焦点是否丢失，
 * 以及「组合中途保存」时浏览器是否主动结束组合。
 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const reset = () => api('/__mock/reset', { method: 'POST' })
const readLog = () => api('/__mock/log')

const { child, wsUrl } = await launch({ port: 9244 })
const s = await openSession(wsUrl)
const out = {}

const startProbe = () => s.eval(`(() => {
  window.__probe = []
  clearInterval(window.__probeTimer)
  window.__probeTimer = setInterval(() => {
    const el = document.querySelector('.s4-editor-content')
    window.__probe.push({
      t: Date.now(),
      active: document.activeElement === el ? 'editor' : (document.activeElement ? document.activeElement.tagName : null),
      ce: el ? el.getAttribute('contenteditable') : null,
      text: el ? el.innerText : null,
    })
  }, 50)
  return true
})()`)
const stopProbe = () => s.eval(`(() => { clearInterval(window.__probeTimer); return window.__probe })()`)
const focus = () => s.eval(`(() => { document.querySelector('.s4-editor-content').focus(); return true })()`)

async function open(label) {
  await s.goto(BASE + '/')
  await s.clickText(label)
  await s.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}

try {
  await s.installRecorder()
  await reset()

  /* ---------- A. Set：自动保存期间的 contenteditable / 焦点变化 ---------- */
  await open('开始今天')
  await focus()
  await s.send('Input.insertText', { text: 'D1 基础。' })
  await sleep(2600)
  out.afterFirstSave = await s.eval(`(() => {
    const el = document.querySelector('.s4-editor-content')
    return { active: document.activeElement === el ? 'editor' : document.activeElement.tagName, ce: el.getAttribute('contenteditable') }
  })()`)

  await focus()
  await startProbe()
  const t0 = Date.now()
  await s.send('Input.insertText', { text: ' 第二段。' })
  await sleep(2600)
  const timeline = await stopProbe()
  const changes = []
  let prev = null
  for (const p of timeline) {
    const key = `${p.active}|${p.ce}`
    if (key !== prev) { changes.push({ dt: p.t - t0, ...p, t: undefined }); prev = key }
  }
  out.setSaveTimeline = { changes, writes: (await readLog()).requests.filter((r) => r.iso >= t0).map((r) => ({ dt: r.iso - t0, method: r.method, text: r.text })) }

  // 保存结束后不重新点击、直接输入：文字会不会丢？
  const beforeBlind = await s.eval(`document.querySelector('.s4-editor-content').innerText`)
  await s.send('Input.insertText', { text: '盲打。' })
  await sleep(300)
  const afterBlind = await s.eval(`document.querySelector('.s4-editor-content').innerText`)
  out.blindTyping = { before: beforeBlind, after: afterBlind, inserted: afterBlind !== beforeBlind }

  /* ---------- B. Writing 对照：同样的保存过程 ---------- */
  await open('写作')
  await focus()
  await s.send('Input.insertText', { text: 'D2 基础。' })
  await sleep(2800)
  await focus()
  await startProbe()
  const t1 = Date.now()
  await s.send('Input.insertText', { text: ' 第二段。' })
  await sleep(2800)
  const timeline2 = await stopProbe()
  const changes2 = []
  let prev2 = null
  for (const p of timeline2) {
    const key = `${p.active}|${p.ce}`
    if (key !== prev2) { changes2.push({ dt: p.t - t1, ...p, t: undefined }); prev2 = key }
  }
  out.writingSaveTimeline = { changes: changes2, writes: (await readLog()).requests.filter((r) => r.iso >= t1).map((r) => ({ dt: r.iso - t1, method: r.method, text: r.text })) }

  /* ---------- C. Set：组合中途触发自动保存 ---------- */
  await open('开始今天')
  await focus()
  await s.send('Input.insertText', { text: 'D3 基础。' })
  await sleep(2600)
  await focus()
  await s.clearQaEvents()
  await startProbe()
  const t2 = Date.now()
  await s.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(1600)
  const probe3 = await stopProbe()
  const changes3 = []
  let prev3 = null
  for (const p of probe3) {
    const key = `${p.active}|${p.ce}`
    if (key !== prev3) { changes3.push({ dt: p.t - t2, ...p, t: undefined }); prev3 = key }
  }
  out.setCompositionSave = {
    timeline: changes3,
    events: (await s.qaEvents()).map((e) => ({ dt: e.iso - t2, type: e.type, data: e.data, inputType: e.inputType })),
    writes: (await readLog()).requests.filter((r) => r.iso >= t2).map((r) => ({ dt: r.iso - t2, method: r.method, text: r.text })),
    editor: await s.eval(`document.querySelector('.s4-editor-content').innerText`),
  }

  /* ---------- D. Writing：组合中途（900ms 等待） ---------- */
  await open('写作')
  await focus()
  await s.send('Input.insertText', { text: 'D4 基础。' })
  await sleep(2800)
  await focus()
  await s.clearQaEvents()
  const t3 = Date.now()
  await s.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(1600)
  out.writingCompositionSave = {
    events: (await s.qaEvents()).map((e) => ({ dt: e.iso - t3, type: e.type, data: e.data, inputType: e.inputType })),
    writes: (await readLog()).requests.filter((r) => r.iso >= t3).map((r) => ({ dt: r.iso - t3, method: r.method, text: r.text })),
    editor: await s.eval(`document.querySelector('.s4-editor-content').innerText`),
  }
} catch (error) {
  out.error = String(error && error.stack || error)
} finally {
  await s.close()
  child.kill()
}

console.log(JSON.stringify(out, null, 2))
