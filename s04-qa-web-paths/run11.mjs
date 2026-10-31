/**
 * 第十一轮：修正操作方式后重跑 Set / End 的组合矩阵。
 *
 * 上一轮 S1–S6 无效的原因：Set/End 在自动保存完成后会重建编辑器并丢失焦点，
 * 之后的 imeSetComposition 没有落点，等于没测。本轮每次组合前都重新聚焦并把
 * 光标放到末尾（等价于用户点回正文继续写）。
 *
 * 仍然是**浏览器层模拟组合**，不是真实中文输入法。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const OUT = process.env.QA_OUT ?? '.'
const results = []
const shots = []
let shotIndex = 0

async function api(path, options) {
  return await (await fetch(BASE + path, options)).json()
}
const reset = () => api('/__mock/reset', { method: 'POST' })
const readLog = () => api('/__mock/log')
const readState = () => api('/__mock/state')
const setFault = (patch) => api('/__mock/fault', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
})

let session = null

const editorText = () => session.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
const textOf = (selector) => session.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
const has = (selector) => session.eval(`document.querySelector(${JSON.stringify(selector)}) !== null`)
const caretAtEnd = async () => {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await sleep(80)
}

function summarize(journal) {
  if (!journal) return null
  const goals = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'goalItem') goals.push(node.attrs?.text ?? null)
    if (Array.isArray(node.content)) node.content.forEach(walk)
  }
  walk(journal.content_doc)
  return { id: journal.id, revision: journal.revision, text: journal.content, goals }
}

async function journalOf(kind) {
  const s = await readState()
  return summarize(s.journals.find((j) => j.journal_kind === kind && j.deleted_at === null) ?? null)
}

async function writesSince(iso) {
  const l = await readLog()
  return l.requests.filter((r) => r.iso >= iso).map((r) => ({
    dt: r.iso - iso,
    method: r.method,
    path: r.path,
    text: r.text ?? null,
    expectedRevision: r.body?.expected_revision ?? null,
    result: r.result ?? 200,
  }))
}

async function eventsSince(iso) {
  return (await session.qaEvents()).filter((e) => e.iso >= iso)
    .map((e) => ({ dt: e.iso - iso, type: e.type, data: e.data, inputType: e.inputType }))
}

async function shot(name) {
  shotIndex += 1
  const file = join(OUT, `r11-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

async function openModule(label) {
  await session.goto(BASE + '/')
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}

/** 聚焦 + 光标移到末尾（模拟用户点回正文末尾）。 */
async function resumeAtEnd() {
  await session.eval(`(() => { const el = document.querySelector('.s4-editor-content'); el.focus(); return true })()`)
  await caretAtEnd()
}

async function seed(text, kind) {
  await openModule(kind === 'set' ? '开始今天' : kind === 'end' ? '结束今天' : '写作')
  await resumeAtEnd()
  await session.send('Input.insertText', { text })
  await sleep(kind === 'writing' ? 2800 : 2600)
  return await journalOf(kind)
}

const scenarios = {}

/* R1：组合跨过 900ms 自动保存 —— 组合被打断，拼音落库 */
scenarios['R1 Set 组合跨过保存窗口（保持 1.4s）'] = async () => {
  const base = await seed('R1 已保存句。', 'set')
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const during = {
    editor: await editorText(),
    focused: await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`),
    writes: await writesSince(t0),
    status: await textOf('.ritual-status'),
  }
  await shot('set-composition-interrupted')
  // 打断后用户再上屏：拼音仍在，最终会与新字一起留在正文
  await resumeAtEnd()
  await session.imeCommit('你好')
  await sleep(2600)
  const after = {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  return { base, during, after, events: (await eventsSince(t0)).slice(0, 16) }
}

/* R2：组合在上屏窗口内完成 —— 正常路径 */
scenarios['R2 Set 组合在窗口内上屏（0.3s）'] = async () => {
  const base = await seed('R2 已保存句。', 'set')
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(300)
  await session.imeCommit('你好')
  await sleep(120)
  const focusedAfterCommit = await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`)
  await sleep(2500)
  return {
    base,
    focusedAfterCommit,
    after: {
      editor: await editorText(),
      writes: await writesSince(t0),
      journal: await journalOf('set'),
      status: await textOf('.ritual-status'),
    },
    events: (await eventsSince(t0)).slice(0, 20),
  }
}

/* R3：组合中取消选词，且取消发生在保存窗口内 */
scenarios['R3 Set 组合窗口内取消（0.3s）'] = async () => {
  const base = await seed('R3 已保存句。', 'set')
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('shijie')
  await sleep(300)
  await session.imeCancel()
  await sleep(2400)
  return {
    base,
    after: { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set') },
    events: (await eventsSince(t0)).slice(0, 20),
  }
}

/* R4：组合跨过窗口后再取消 —— 取消是否还能送达 */
scenarios['R4 Set 组合跨窗口后取消'] = async () => {
  const base = await seed('R4 已保存句。', 'set')
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('shijie')
  await sleep(1450)
  const beforeCancel = { editor: await editorText(), focused: await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`) }
  await session.imeCancel()
  await sleep(2400)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set') }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }
  return { base, beforeCancel, after, reopened, events: (await eventsSince(t0)).slice(0, 20) }
}

/* R5：组合中切页（保存尚未触发） */
scenarios['R5 Set 组合中切页'] = async () => {
  const base = await seed('R5 已保存句。', 'set')
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(300)
  const before = { editor: await editorText(), nav: await session.eval(`[...document.querySelectorAll('nav button')].slice(0, 4).map((b) => ({ label: b.textContent.trim(), disabled: b.disabled }))`) }
  await session.clickText('写作')
  await sleep(2000)
  const afterNav = { onWriting: await has('.writing-editor'), writes: await writesSince(t0), journal: await journalOf('set') }
  await shot('set-nav-during-composition')
  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000)
  await sleep(1400)
  return { base, before, afterNav, back: { editor: await editorText(), journal: await journalOf('set') } }
}

/* R6：组合跨窗口 + 保存失败 */
scenarios['R6 Set 组合跨窗口且保存失败'] = async () => {
  const base = await seed('R6 已保存句。', 'set')
  await setFault({ patchStatus: 503 })
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('shibai')
  await sleep(1700)
  const during = {
    editor: await editorText(),
    focused: await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`),
    writes: await writesSince(t0),
    status: await textOf('.ritual-status'),
    alert: await textOf('.ritual-alert'),
  }
  await shot('set-fail-during-composition')
  await setFault({ patchStatus: null })
  await sleep(600)
  return { base, during, events: (await eventsSince(t0)).slice(0, 16), journal: await journalOf('set') }
}

/* R7：End 页同场景（抽样） */
scenarios['R7 End 组合跨窗口'] = async () => {
  const base = await seed('R7 已保存句。', 'end')
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const during = {
    editor: await editorText(),
    focused: await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`),
    writes: await writesSince(t0),
  }
  return { base, during, events: (await eventsSince(t0)).slice(0, 16), journal: await journalOf('end') }
}

/* R8：已保存正文被拼音污染（含既有内容） */
scenarios['R8 Set 既有正文 + 组合跨窗口'] = async () => {
  await openModule('开始今天')
  await resumeAtEnd()
  await session.send('Input.insertText', { text: '第一段已保存。' })
  await sleep(2400)
  await resumeAtEnd()
  await session.send('Input.insertText', { text: ' 第二段已保存。' })
  await sleep(2600)
  const base = await journalOf('set')
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const polluted = { editor: await editorText(), journal: await journalOf('set'), writes: await writesSince(t0) }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }
  return { base, polluted, reopened }
}

/* R9：组合跨窗口 + 自动转目标（目标文本被拼音固化） */
scenarios['R9 Set 组合跨窗口触发自动转目标'] = async () => {
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await resumeAtEnd()
  await session.send('Input.insertText', { text: '买' })
  const t0 = Date.now()
  await session.imeSet('ni')
  await sleep(1900)
  const mid = {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf('.ritual-goals'),
  }
  await shot('set-goal-pinyin')
  await resumeAtEnd()
  await session.imeCommit('你好')
  await sleep(2800)
  const after = {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf('.ritual-goals'),
  }
  await openModule('开始今天')
  const reopened = { goalsPanel: await textOf('.ritual-goals'), journal: await journalOf('set') }
  return { mid, after, reopened }
}

/* R10：Writing 对照（同样跨窗口） */
scenarios['R10 Writing 组合跨窗口（对照）'] = async () => {
  const base = await seed('R10 已保存句。', 'writing')
  await resumeAtEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const during = {
    editor: await editorText(),
    focused: await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`),
    writes: await writesSince(t0),
    status: await textOf('.writing-status'),
  }
  await session.imeCommit('你好')
  await sleep(2600)
  return {
    base,
    during,
    after: { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('writing') },
    events: (await eventsSince(t0)).slice(0, 20),
  }
}

/* R11：Writing 组合中切页 */
scenarios['R11 Writing 组合中切页'] = async () => {
  const base = await seed('R11 已保存句。', 'writing')
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(300)
  await session.clickText('概览')
  await sleep(2200)
  const afterNav = { writes: await writesSince(t0), journal: await journalOf('writing') }
  return { base, afterNav }
}

/* R12：Writing 保存中点导航 —— 量化等待与反馈 */
scenarios['R12 Writing 保存中点导航'] = async () => {
  await openModule('写作')
  await resumeAtEnd()
  await session.send('Input.insertText', { text: 'R12 慢保存句。' })
  await sleep(2800)
  await setFault({ patchDelayMs: 3000 })
  await resumeAtEnd()
  await session.send('Input.insertText', { text: ' 追加。' })
  const t0 = Date.now()
  await sleep(1150)
  const navBefore = await session.eval(`[...document.querySelectorAll('nav button')].filter((b) => ['概览','写作','开始今天'].includes(b.textContent.trim())).map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.title || null }))`)
  const clickedAt = Date.now()
  await session.clickText('概览')
  let changedAt = null
  for (let i = 0; i < 30; i += 1) {
    if (await has('.dashboard')) { changedAt = Date.now(); break }
    await sleep(100)
  }
  const during = {
    changedWithin1500ms: changedAt !== null,
    msToChange: changedAt === null ? null : changedAt - clickedAt,
    bodyHasSavingHint: await session.eval(`/保存中|正在保存/.test(document.body.innerText)`),
    status: await textOf('.writing-status'),
  }
  await shot('writing-nav-during-save')
  await sleep(2800)
  await setFault({ patchDelayMs: 0 })
  const after = { onDashboard: await has('.dashboard'), msTotal: Date.now() - clickedAt, journal: await journalOf('writing') }
  return { navBefore, during, after, patchSentAt: (await writesSince(t0)).map((w) => w.dt) }
}

/* R13：Set 保存中点导航 */
scenarios['R13 Set 保存中点导航'] = async () => {
  await openModule('开始今天')
  await resumeAtEnd()
  await session.send('Input.insertText', { text: 'R13 慢保存句。' })
  await sleep(2400)
  await setFault({ patchDelayMs: 3000 })
  await resumeAtEnd()
  await session.send('Input.insertText', { text: ' 追加。' })
  await sleep(1150)
  const navBefore = await session.eval(`[...document.querySelectorAll('nav button')].filter((b) => ['概览','写作','开始今天'].includes(b.textContent.trim())).map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.title || null }))`)
  const statusDuring = await textOf('.ritual-status')
  const clicked = await session.eval(`(() => {
    const btn = [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === '写作')
    if (!btn) return { found: false }
    btn.click()
    return { found: true, disabled: btn.disabled, title: btn.title || null }
  })()`)
  await sleep(900)
  const during = { clicked, stillOnRitual: await has('.ritual-page'), status: statusDuring, navTitleAttr: clicked.title }
  await shot('set-nav-disabled-during-save')
  await sleep(3000)
  await setFault({ patchDelayMs: 0 })
  const after = { nav: await session.eval(`[...document.querySelectorAll('nav button')].slice(0, 4).map((b) => b.disabled)`), journal: await journalOf('set'), stillOnRitual: await has('.ritual-page') }
  return { navBefore, during, after }
}

async function main() {
  const { child, wsUrl } = await launch({ port: 9246 })
  session = await openSession(wsUrl)
  try {
    await session.installRecorder()
    for (const [name, fn] of Object.entries(scenarios)) {
      await reset()
      try {
        const data = await fn()
        results.push({ scenario: name, ...data })
        console.log(`\n### ${name}`)
        console.log(JSON.stringify(data).slice(0, 800))
      } catch (error) {
        results.push({ scenario: name, error: String(error && error.stack || error) })
        console.log(`\n### ${name} FAILED: ${error}`)
        await shot('failure').catch(() => {})
      }
    }
    results.push({
      scenario: '控制台',
      exceptions: session.events.filter((e) => e.method === 'Runtime.exceptionThrown')
        .map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 200)).slice(-5),
    })
  } finally {
    await session.close()
    child.kill()
  }
  await writeFile(join(OUT, 'run11-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第十一轮完成：${results.length} 条`)
}

main().catch((error) => { console.error(error); process.exit(1) })
