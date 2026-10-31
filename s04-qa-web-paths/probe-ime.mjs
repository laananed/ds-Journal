/**
 * 探针：验证 CDP 的 IME 组合命令在真实 Blink 里到底产生哪些事件。
 *
 * 目的不是测产品，而是先确认「脚本模拟 composition」的能力边界：
 * 之后所有产品结论都必须标注这是浏览器层模拟，不是真实中文 IME。
 */
import { launch, openSession, sleep } from './cdp.mjs'

const HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><meta charset="utf-8">
<div id="box" contenteditable="true" style="font:16px sans-serif;border:1px solid #888;padding:8px;min-height:40px"></div>
<pre id="out"></pre>
<script>
window.__ev = []
for (const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown']) {
  document.addEventListener(type, (e) => {
    window.__ev.push({ type, data: e.data ?? null, inputType: e.inputType ?? null, key: e.key ?? null, iso: Date.now() })
  }, true)
}
</script>`)}`

const { child, wsUrl } = await launch({ port: 9241 })
const session = await openSession(wsUrl)
const out = {}

try {
  await session.goto(HTML)
  await session.eval(`(() => { const b = document.getElementById('box'); b.focus(); return true })()`)
  await session.send('Input.insertText', { text: '前缀。' })
  await sleep(200)

  // 1) 组合开始 + 两次更新
  await session.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
  await sleep(300)
  await session.send('Input.imeSetComposition', { text: 'nihaoa', selectionStart: 6, selectionEnd: 6 })
  await sleep(300)
  out.whileComposing = {
    text: await session.eval(`document.getElementById('box').innerText`),
    events: await session.eval(`window.__ev.map(e => ({ type: e.type, data: e.data, inputType: e.inputType }))`),
  }

  // 2) 用 insertText 提交上屏
  await session.send('Input.insertText', { text: '你好' })
  await sleep(400)
  out.afterCommit = {
    text: await session.eval(`document.getElementById('box').innerText`),
    events: await session.eval(`window.__ev.map(e => ({ type: e.type, data: e.data, inputType: e.inputType }))`),
  }

  // 3) 取消组合：imeSetComposition 置空
  await session.eval(`window.__ev.length = 0`)
  await session.send('Input.imeSetComposition', { text: 'shijie', selectionStart: 6, selectionEnd: 6 })
  await sleep(300)
  const duringCancel = await session.eval(`document.getElementById('box').innerText`)
  await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await sleep(300)
  out.cancelByEmpty = {
    during: duringCancel,
    after: await session.eval(`document.getElementById('box').innerText`),
    events: await session.eval(`window.__ev.map(e => ({ type: e.type, data: e.data }))`),
  }

  // 4) 取消组合：Escape
  await session.eval(`window.__ev.length = 0`)
  await session.send('Input.imeSetComposition', { text: 'quxiao', selectionStart: 6, selectionEnd: 6 })
  await sleep(300)
  const duringEsc = await session.eval(`document.getElementById('box').innerText`)
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await sleep(300)
  out.cancelByEscape = {
    during: duringEsc,
    after: await session.eval(`document.getElementById('box').innerText`),
    events: await session.eval(`window.__ev.map(e => ({ type: e.type, data: e.data, key: e.key }))`),
  }
} catch (error) {
  out.error = String(error && error.stack || error)
} finally {
  await session.close()
  child.kill()
}

console.log(JSON.stringify(out, null, 2))
