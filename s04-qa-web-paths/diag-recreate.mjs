/**
 * 诊断三：保存前后编辑器 DOM 节点是否被替换（实例重建），
 * 以及组合文本在重建后是否残留、是否收到 compositionend。
 * 采样 10ms，避免漏掉短暂的状态切换。
 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const readLog = () => api('/__mock/log')

const { child, wsUrl } = await launch({ port: 9245 })
const s = await openSession(wsUrl)
const out = {}

const startProbe = () => s.eval(`(() => {
  const el = document.querySelector('.s4-editor-content')
  if (el) el.dataset.qaMark = 'A'
  window.__probe = []
  window.__muts = 0
  const host = document.querySelector('.ritual-editor') || document.body
  window.__mo = new MutationObserver((list) => { window.__muts += list.length })
  window.__mo.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] })
  clearInterval(window.__probeTimer)
  window.__probeTimer = setInterval(() => {
    const e = document.querySelector('.s4-editor-content')
    window.__probe.push({
      t: Date.now(),
      mark: e ? (e.dataset.qaMark || 'NONE') : 'NO-EL',
      active: document.activeElement === e ? 'editor' : (document.activeElement ? document.activeElement.tagName : null),
      ce: e ? e.getAttribute('contenteditable') : null,
      text: e ? e.innerText : null,
    })
  }, 10)
  return document.querySelectorAll('.s4-editor-content').length
})()`)
const stopProbe = () => s.eval(`(() => {
  clearInterval(window.__probeTimer)
  if (window.__mo) window.__mo.disconnect()
  return { samples: window.__probe, mutations: window.__muts }
})()`)
const focus = () => s.eval(`(() => { const el = document.querySelector('.s4-editor-content'); el.focus(); return true })()`)

async function open(label) {
  await s.goto(BASE + '/')
  await s.clickText(label)
  await s.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}

function compress(samples) {
  const changes = []
  let prev = null
  for (const p of samples) {
    const key = `${p.mark}|${p.active}|${p.ce}`
    if (key !== prev) { changes.push({ dt: p.t - samples[0].t, mark: p.mark, active: p.active, ce: p.ce, text: p.text }); prev = key }
  }
  return changes
}

try {
  await s.installRecorder()
  await api('/__mock/reset', { method: 'POST' })

  /* A. Set 普通保存（非组合） */
  await open('开始今天')
  await focus()
  await s.send('Input.insertText', { text: 'E1 基础。' })
  await sleep(2600)
  await focus()
  const count = await startProbe()
  const t0 = Date.now()
  await s.send('Input.insertText', { text: ' 追加。' })
  await sleep(2600)
  const p1 = await stopProbe()
  out.setPlainSave = {
    editorCount: count,
    changes: compress(p1.samples),
    mutations: p1.mutations,
    writes: (await readLog()).requests.filter((r) => r.iso >= t0).map((r) => ({ dt: r.iso - t0, method: r.method, text: r.text })),
  }

  /* B. Set 组合跨过 900ms 保存窗口 */
  await open('开始今天')
  await focus()
  await s.send('Input.insertText', { text: 'E2 基础。' })
  await sleep(2600)
  await focus()
  await s.clearQaEvents()
  await startProbe()
  const t1 = Date.now()
  await s.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(2200)
  const p2 = await stopProbe()
  out.setCompositionCrossSave = {
    changes: compress(p2.samples),
    mutations: p2.mutations,
    events: (await s.qaEvents()).map((e) => ({ dt: e.iso - t1, type: e.type, data: e.data, inputType: e.inputType })),
    writes: (await readLog()).requests.filter((r) => r.iso >= t1).map((r) => ({ dt: r.iso - t1, method: r.method, text: r.text })),
    editor: await s.eval(`document.querySelector('.s4-editor-content').innerText`),
  }

  /* C. 组合被重建打断后，再点回编辑器提交：内容如何收场 */
  await s.eval(`(() => { document.querySelector('.s4-editor-content').focus(); return true })()`)
  await sleep(150)
  const beforeCommit = await s.eval(`document.querySelector('.s4-editor-content').innerText`)
  await s.send('Input.insertText', { text: '你好' })
  await sleep(2400)
  out.commitAfterInterrupt = {
    beforeCommit,
    editor: await s.eval(`document.querySelector('.s4-editor-content').innerText`),
    writes: (await readLog()).requests.filter((r) => r.iso >= t1).map((r) => ({ dt: r.iso - t1, method: r.method, text: r.text })),
  }
} catch (error) {
  out.error = String(error && error.stack || error)
} finally {
  await s.close()
  child.kill()
}

console.log(JSON.stringify(out, null, 2))
