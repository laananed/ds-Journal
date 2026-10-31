/** 诊断 A：种子文档打开后是否有额外写请求；诊断 B：目标命令期间编辑器锁定与 contenteditable 曲线。 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = 'http://127.0.0.1:8041'
const DAY = '2026-10-31'
const ED = '.s4-editor-content'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const reset = () => api('/__mock/reset', { method: 'POST' })
const log = () => api('/__mock/log')
const state = () => api('/__mock/state')

const docPara = (...ps) => ({ type: 'doc', content: ps.map((t, i) => ({ type: 'paragraph', attrs: { id: `p-seed-${i + 1}` }, content: t === '' ? [] : [{ type: 'text', text: t }] })) })

async function seed(kind, doc) {
  return await (await fetch(BASE + '/api/journals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ journal_kind: kind, journal_date: DAY, content_doc: doc, title: null }),
  })).json()
}

const out = { A: {}, B: {} }
const { child, wsUrl } = await launch({ port: 9261 })
const session = await openSession(wsUrl)
try {
  await session.installRecorder()

  /* A：打开种子文档后观察请求 */
  await reset()
  const j = await seed('set', docPara('诊断种子句。'))
  await session.goto(BASE + '/')
  await session.eval('localStorage.clear(); sessionStorage.clear(); true')
  await session.goto(BASE + '/')
  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('${ED}') !== null`, 15000)
  await sleep(2500)
  const sA = await state()
  out.A = {
    seedId: j.id,
    journals: sA.journals.map((x) => ({ id: x.id, revision: x.revision, text: x.content })),
    requests: sA.requests.map((r) => ({ method: r.method, path: r.path, text: r.text, body: r.body })),
    editor: await session.eval(`document.querySelector('${ED}').innerText`),
    doc: sA.journals[0]?.content_doc,
  }

  console.log('A_RESULT ' + JSON.stringify(out.A))
  /* B：目标命令（勾选）期间的锁与可编辑性曲线 */
  await reset()
  const b = await seed('set', { type: 'doc', content: [{ type: 'taskList', attrs: { id: 'tl-1' }, content: [{ type: 'taskItem', attrs: { id: 'ti-1', checked: false }, content: [{ type: 'paragraph', attrs: { id: 'tpp-1' }, content: [{ type: 'text', text: '写周报' }] }] }] }, { type: 'paragraph', attrs: { id: 'p-2' }, content: [] }] })
  await session.goto(BASE + '/')
  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('${ED}') !== null`, 15000)
  await sleep(3000)
  const beforeB = await state()
  await api('/__mock/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goalDelayMs: 3000 }) })
  // 先制造脏草稿
  await session.eval(`(() => { const el = document.querySelector('${ED}'); el.focus(); return true })()`)
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.insertText', { text: ' 补充' })
  await sleep(150)
  await session.eval(`(() => {
    window.__curve = []
    clearInterval(window.__curveTimer)
    window.__curveTimer = setInterval(() => {
      const el = document.querySelector('${ED}')
      window.__curve.push({
        t: Date.now(),
        editable: el?.getAttribute('contenteditable') ?? null,
        active: document.activeElement === el,
        goalsDisabled: document.querySelector('.ritual-goals input[type="checkbox"]')?.disabled ?? null,
        status: document.querySelector('.ritual-status')?.innerText?.replace(/\\s+/g, ' ').trim() ?? null,
      })
    }, 80)
    return true
  })()`)
  const box = await session.eval(`(() => { const el = document.querySelector('.ritual-goals input[type="checkbox"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (box === null) throw new Error('no goal checkbox')
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(4500)
  const curve = await session.eval(`(() => { clearInterval(window.__curveTimer); return window.__curve })()`)
  const sB = await state()
  out.B = {
    seeded: { id: b.id, revision: beforeB.journals[0]?.revision, text: beforeB.journals[0]?.content, goals: beforeB.journals[0]?.content_doc?.content?.[0]?.content?.length },
    curve: curve.map((c, i) => ({ ...c, t: c.t - curve[0].t })),
    requests: sB.requests.map((r) => ({ method: r.method, path: r.path, text: r.text, expected: r.body?.expected_revision ?? r.body?.expected_set_revision ?? null, result: r.result ?? 200 })),
    journal: sB.journals.map((x) => ({ revision: x.revision, text: x.content })),
  }
} catch (e) {
  console.log('DIAG_ERROR ' + String(e))
} finally {
  await session.close()
  child.kill()
}
console.log('B_RESULT ' + JSON.stringify(out.B))
