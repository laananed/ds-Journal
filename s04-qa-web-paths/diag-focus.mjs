/** 诊断：事件记录器是否安装、Set 页保存后焦点/选区是否还在。 */
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const { child, wsUrl } = await launch({ port: 9243 })
const s = await openSession(wsUrl)
const out = {}

const probe = () => s.eval(`(() => {
  const el = document.querySelector('.s4-editor-content')
  const sel = window.getSelection()
  return {
    recorder: typeof window.__qa === 'object' ? window.__qa.ev.length : 'missing',
    active: document.activeElement ? (document.activeElement.className || document.activeElement.tagName) : null,
    editableFocused: el !== null && document.activeElement === el,
    selectionInEditor: el !== null && sel !== null && sel.anchorNode !== null && el.contains(sel.anchorNode),
    text: el ? el.innerText : null,
  }
})()`)

try {
  await s.installRecorder()
  await s.goto(BASE + '/')
  out.afterGoto = await s.eval(`typeof window.__qa`)

  await s.clickText('开始今天')
  await s.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
  out.beforeFocus = await probe()

  await s.eval(`(() => { document.querySelector('.s4-editor-content').focus(); return true })()`)
  out.afterFocus = await probe()

  await s.send('Input.insertText', { text: '诊断句。' })
  await sleep(200)
  out.afterType = await probe()

  await sleep(2400)
  out.afterSave = await probe()

  await s.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(400)
  out.duringComposition = await probe()
  out.events = await s.qaEvents()
} catch (error) {
  out.error = String(error && error.stack || error)
} finally {
  await s.close()
  child.kill()
}
console.log(JSON.stringify(out, null, 2))
