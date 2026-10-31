/**
 * 第十四轮：用 aria-pressed 判断当前模块，重测「保存中点导航」。
 * 上一轮用 `.dashboard` 选择器判断，选择器不存在，结论作废。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const reset = () => api('/__mock/reset', { method: 'POST' })
const readLog = () => api('/__mock/log')
const readState = () => api('/__mock/state')
const setFault = (patch) => api('/__mock/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })

const { child, wsUrl } = await launch({ port: 9249 })
const s = await openSession(wsUrl)
const out = {}

const activeModule = () => s.eval(`(() => {
  const b = document.querySelector('nav.app-navigation button[aria-pressed="true"]')
  return b ? b.textContent.trim() : null
})()`)
const navButtons = () => s.eval(`[...document.querySelectorAll('nav.app-navigation button')].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.title || null }))`)
const visibleHint = () => s.eval(`(() => {
  const t = document.body.innerText
  return {
    saving: /保存中|正在保存|保存失败|未提交/.test(t),
    notice: (document.querySelector('.detail-success')?.innerText || '').trim(),
    status: (document.querySelector('.writing-status')?.innerText || document.querySelector('.ritual-status')?.innerText || '').replace(/\\s+/g, ' ').trim(),
  }
})()`)
const editorText = () => s.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)

async function openModule(label) {
  await s.goto(BASE + '/')
  await s.clickText(label)
  await s.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}
async function resumeAtEnd() {
  await s.eval(`(() => { const el = document.querySelector('.s4-editor-content'); el.focus(); return true })()`)
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await sleep(80)
}

/** 点击导航并测量模块切换耗时（最多 8s）。 */
async function clickNavAndMeasure(label) {
  const clickedAt = Date.now()
  const clicked = await s.eval(`(() => {
    const btn = [...document.querySelectorAll('nav.app-navigation button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!btn) return { found: false }
    const state = { found: true, disabled: btn.disabled, title: btn.title || null }
    btn.click()
    return state
  })()`)
  let changedAt = null
  for (let i = 0; i < 160; i += 1) {
    const mod = await activeModule()
    if (mod === label) { changedAt = Date.now(); break }
    await sleep(50)
  }
  return { clicked, msToChange: changedAt === null ? null : changedAt - clickedAt, finalModule: await activeModule() }
}

try {
  await s.installRecorder()

  /* 基线：没有保存在途时，导航应当立刻切走 */
  await reset()
  await openModule('写作')
  await resumeAtEnd()
  await s.send('Input.insertText', { text: 'N0 基线句。' })
  await sleep(2800)
  out.baseline = { before: await activeModule(), ...await clickNavAndMeasure('概览') }

  /* Writing：3s 慢保存中点击导航 */
  await reset()
  await openModule('写作')
  await resumeAtEnd()
  await s.send('Input.insertText', { text: 'N1 慢保存句。' })
  await sleep(2800)
  await setFault({ patchDelayMs: 3000 })
  await resumeAtEnd()
  await s.send('Input.insertText', { text: ' 追加。' })
  await sleep(1150)
  out.writingSlow = {
    navBefore: await navButtons(),
    hintBefore: await visibleHint(),
    ...await clickNavAndMeasure('概览'),
  }
  out.writingSlow.hintAfterClick = await visibleHint()
  await s.screenshot(join('.', 'r14-01-writing-nav-during-save.png'))
  await sleep(2500)
  await setFault({ patchDelayMs: 0 })
  const st = await readState()
  out.writingSlow.journal = st.journals.map((j) => ({ id: j.id, revision: j.revision, text: j.content }))

  /* Set：3s 慢保存中点击导航 */
  await reset()
  await openModule('开始今天')
  await resumeAtEnd()
  await s.send('Input.insertText', { text: 'N2 慢保存句。' })
  await sleep(2400)
  await setFault({ patchDelayMs: 3000 })
  await resumeAtEnd()
  await s.send('Input.insertText', { text: ' 追加。' })
  await sleep(1150)
  out.setSlow = {
    navBefore: await navButtons(),
    hintBefore: await visibleHint(),
    ...await clickNavAndMeasure('写作'),
  }
  out.setSlow.hintAfterClick = await visibleHint()
  await s.screenshot(join('.', 'r14-02-set-nav-disabled.png'))
  await sleep(3200)
  await setFault({ patchDelayMs: 0 })
  out.setSlow.finalModule = await activeModule()
  out.setSlow.navAfter = await navButtons()
  out.setSlow.journal = (await readState()).journals.map((j) => ({ id: j.id, revision: j.revision, text: j.content }))

  /* 保存完成后从 Set 导航：应当正常切走 */
  out.setAfterSave = { ...await clickNavAndMeasure('写作') }
} catch (error) {
  out.error = String(error && error.stack || error)
} finally {
  await s.close()
  child.kill()
}

await writeFile(join('.', 'run14-results.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 1))
