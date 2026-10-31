/** 对照：完全没输入时从「写作」切到「开始今天」是否也会弹离开确认（判断是否为既有行为）。 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()

let session = null
async function realClickText(label) {
  const box = await session.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled }
  })()`)
  if (box === null) throw new Error(label)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(150)
}
const snap = () => session.eval(`(() => {
  const d = document.querySelector('dialog')
  return {
    writing: document.querySelector('.writing-page') !== null,
    ritual: document.querySelector('.ritual-page') !== null,
    dialog: d && d.open ? d.querySelector('h2')?.textContent : null,
    status: document.querySelector('.writing-status')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    text: document.querySelector('.s4-editor-content')?.innerText ?? null,
  }
})()`)

const { child, wsUrl } = await launch({ port: 9251 })
session = await openSession(wsUrl)
try {
  await api('/__mock/reset', { method: 'POST' })
  await session.goto(BASE + '/')
  await session.clickText('写作')
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(1500)
  console.log('writing-idle', JSON.stringify(await snap()))
  await realClickText('开始今天')
  await sleep(900)
  console.log('after-nav', JSON.stringify(await snap()))
  console.log('journals', JSON.stringify((await api('/__mock/state')).journals.map((j) => ({ kind: j.journal_kind, rev: j.revision, text: j.content }))))
} finally {
  await session.close()
  child.kill()
}
