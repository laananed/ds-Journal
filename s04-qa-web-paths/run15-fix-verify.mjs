/**
 * 第十五轮：S04 输入法组合 / 编辑器重建缺陷修复后的验证。
 *
 * 与 run11 的差别：
 * - 组合期不再要求「先重新聚焦」——焦点本就不该丢，聚焦只作为兜底并单独记录；
 * - 每个场景同时记录：页面事件、10–30ms DOM 采样（节点身份 + contenteditable）、
 *   Mock 收到的写请求正文、服务器最终内容、刷新后内容；
 * - 组合仍然由 CDP `Input.imeSetComposition` / `Input.insertText` 驱动，
 *   是**浏览器层模拟**，不是真实中文输入法（报告中单独标注）。
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
const focused = () => session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`)
const editableAttr = () => session.eval(`document.querySelector('.s4-editor-content')?.getAttribute('contenteditable') ?? null`)
const editorMark = () => session.eval(`document.querySelector('.s4-editor-content')?.dataset.qaMark ?? null`)

const caretAtEnd = async () => {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await sleep(60)
}

/** 给当前编辑器节点打身份标记：节点被替换时会消失，用来区分「重渲染」与「实例重建」。 */
async function markEditor(label) {
  return await session.eval(`(() => {
    const el = document.querySelector('.s4-editor-content')
    if (!el) return false
    el.dataset.qaMark = ${JSON.stringify(label)}
    return true
  })()`)
}

async function startSampler(intervalMs = 25) {
  await session.eval(`(() => {
    window.__qaSamples = []
    clearInterval(window.__qaTimer)
    window.__qaTimer = setInterval(() => {
      const el = document.querySelector('.s4-editor-content')
      window.__qaSamples.push({
        t: Date.now(),
        mark: el?.dataset.qaMark ?? null,
        editable: el?.getAttribute('contenteditable') ?? null,
        active: document.activeElement === el,
      })
    }, ${intervalMs})
    return true
  })()`)
}

async function stopSampler() {
  const samples = await session.eval(`(() => { clearInterval(window.__qaTimer); return window.__qaSamples || [] })()`)
  if (!Array.isArray(samples) || samples.length === 0) return { count: 0 }
  const marks = [...new Set(samples.map((s) => s.mark))]
  return {
    count: samples.length,
    marks,
    rebuilt: marks.some((m) => m === null),
    editableValues: [...new Set(samples.map((s) => s.editable))],
    lostFocusSamples: samples.filter((s) => s.active === false).length,
    first: samples[0],
    last: samples[samples.length - 1],
  }
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
  const file = join(OUT, `r15-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

/**
 * 真实鼠标点击（mousedown → focus 变化 → mouseup → click）。
 *
 * 不能用 `el.click()` 代替：脚本 click 不产生 mousedown，也就不会让编辑区失焦，
 * 于是真实的「失焦 → compositionend → 导航」顺序测不出来（上一轮曾据此误判）。
 */
async function realClickText(label) {
  const box = await session.eval(`(() => {
    const el = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled }
  })()`)
  if (box === null) throw new Error(`找不到按钮：${label}`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(140)
  return { disabled: box.disabled }
}

async function openModule(label) {
  await session.goto(BASE + '/')
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}

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

/* V1：Set 组合跨过 900ms 自动保存窗口 —— 期望：组合期零写入、节点不换、焦点不丢 */
scenarios['V1 Set 组合保持 1.5s 不选词'] = async () => {
  const base = await seed('V1 已保存句。', 'set')
  await markEditor('A')
  await resumeAtEnd()
  await session.clearQaEvents()
  await startSampler(25)
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const during = {
    editor: await editorText(),
    focused: await focused(),
    editable: await editableAttr(),
    mark: await editorMark(),
    writes: await writesSince(t0),
    status: await textOf('.ritual-status'),
    events: (await eventsSince(t0)).map((e) => `${e.dt}ms ${e.type}${e.data ? `:"${e.data}"` : ''}`).slice(0, 10),
  }
  const sampling = await stopSampler()
  await shot('set-composition-held')
  await session.imeCommit('你好')
  await sleep(2600)
  const after = {
    editor: await editorText(),
    focused: await focused(),
    mark: await editorMark(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    status: await textOf('.ritual-status'),
  }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }
  return { base, during, sampling, after, reopened }
}

/* V2：End 页同场景 */
scenarios['V2 End 组合保持 1.5s 不选词'] = async () => {
  const base = await seed('V2 已保存句。', 'end')
  await markEditor('B')
  await resumeAtEnd()
  await startSampler(25)
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const during = {
    editor: await editorText(),
    focused: await focused(),
    mark: await editorMark(),
    writes: await writesSince(t0),
  }
  const sampling = await stopSampler()
  await session.imeCommit('你好')
  await sleep(2600)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('end'), mark: await editorMark() }
  await openModule('结束今天')
  const reopened = { editor: await editorText(), journal: await journalOf('end') }
  return { base, during, sampling, after, reopened }
}

/* V3：组合跨窗口后取消选词 —— 期望：零写入、正文回到原文 */
scenarios['V3 Set 组合 1.4s 后取消'] = async () => {
  const base = await seed('V3 已保存句。', 'set')
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('shijie')
  await sleep(1400)
  const duringWrites = await writesSince(t0)
  await session.imeCancel()
  await sleep(1800)
  const after = {
    editor: await editorText(),
    focused: await focused(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }
  return { base, duringWrites, after, reopened }
}

/* V4：普通保存（无组合）期间的节点身份、contenteditable 与焦点连续性 */
scenarios['V4 Set 保存期间节点与焦点连续'] = async () => {
  const base = await seed('V4 已保存句。', 'set')
  await markEditor('C')
  await resumeAtEnd()
  await startSampler(20)
  const t0 = Date.now()
  await session.send('Input.insertText', { text: ' 追加句。' })
  await sleep(2400)
  const sampling = await stopSampler()
  const afterSave = {
    focused: await focused(),
    mark: await editorMark(),
    editable: await editableAttr(),
    writes: await writesSince(t0),
    status: await textOf('.ritual-status'),
  }
  // 不点击、不重新聚焦，直接继续输入：验证「保存完还能接着打字」
  await session.send('Input.insertText', { text: '盲打续写' })
  await sleep(200)
  const typed = { editor: await editorText(), contains: (await editorText()).includes('盲打续写') }
  await sleep(2400)
  const saved = { journal: await journalOf('set'), writes: await writesSince(t0) }
  await shot('set-focus-after-save')
  return { base, sampling, afterSave, typed, saved }
}

/* V5：Set 清单条目 + 组合 —— 期望：拼音不落库、目标不被固化 */
scenarios['V5 Set 清单组合不固化目标'] = async () => {
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await resumeAtEnd()
  await session.send('Input.insertText', { text: '买' })
  await markEditor('G')
  const t0 = Date.now()
  await session.imeSet('ni')
  await sleep(1900)
  const mid = {
    editor: await editorText(),
    focused: await focused(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf('.ritual-goals'),
    mark: await editorMark(),
  }
  await shot('set-goal-during-composition')
  await session.imeCommit('牛奶')
  await sleep(3000)
  const after = {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf('.ritual-goals'),
  }
  await shot('set-goal-after-commit')
  await openModule('开始今天')
  const reopened = { goalsPanel: await textOf('.ritual-goals'), journal: await journalOf('set') }
  return { mid, after, reopened }
}

/* V6：目标自动转换回归（无组合） */
scenarios['V6 Set 清单正常自动转目标'] = async () => {
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await resumeAtEnd()
  const t0 = Date.now()
  await session.send('Input.insertText', { text: '买牛奶' })
  await sleep(3200)
  return {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf('.ritual-goals'),
  }
}

/* V7：组合期不写入 + 上屏后保存失败（503）—— 输入保留、可重试 */
scenarios['V7 Set 上屏后保存失败 503'] = async () => {
  const base = await seed('V7 已保存句。', 'set')
  await setFault({ patchStatus: 503 })
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('shibai')
  await sleep(1200)
  const duringWrites = await writesSince(t0)
  await session.imeCommit('失败')
  await sleep(2200)
  const failed = {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    alert: await textOf('.ritual-alert'),
    focused: await focused(),
  }
  await shot('set-503-after-commit')
  await setFault({ patchStatus: null })
  await session.clickText('重试保存')
  await sleep(2600)
  const retried = { editor: await editorText(), journal: await journalOf('set'), writes: await writesSince(t0) }
  return { base, duringWrites, failed, retried }
}

/* V8：组合上屏后 409 冲突 —— 输入保留、服务器原文未被覆盖 */
scenarios['V8 Set 上屏后冲突 409'] = async () => {
  const base = await seed('V8 已保存句。', 'set')
  await setFault({ patchStatus: 409 })
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('chongtu')
  await sleep(1200)
  const duringWrites = await writesSince(t0)
  await session.imeCommit('冲突')
  await sleep(2600)
  const conflicted = {
    editor: await editorText(),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    alert: await textOf('.ritual-alert'),
    conflictBox: await textOf('.ritual-conflict'),
    focused: await focused(),
  }
  await shot('set-409-after-commit')
  await setFault({ patchStatus: null })
  return { base, duringWrites, conflicted }
}

/* V9：Writing 对照（组合期零写入 + 节点不换） */
scenarios['V9 Writing 组合保持 1.5s（对照）'] = async () => {
  const base = await seed('V9 已保存句。', 'writing')
  await markEditor('D')
  await resumeAtEnd()
  await startSampler(25)
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const during = {
    editor: await editorText(),
    focused: await focused(),
    mark: await editorMark(),
    writes: await writesSince(t0),
    status: await textOf('.writing-status'),
  }
  const sampling = await stopSampler()
  await session.imeCommit('你好')
  await sleep(2600)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('writing'), mark: await editorMark() }
  return { base, during, sampling, after }
}

/* V10：Writing 显式「立即保存」不再重建编辑器，保存后仍可继续写 */
scenarios['V10 Writing 立即保存不重建编辑器'] = async () => {
  await openModule('写作')
  await resumeAtEnd()
  await session.send('Input.insertText', { text: 'V10 立即保存句。' })
  await sleep(200)
  await markEditor('E')
  await startSampler(20)
  const t0 = Date.now()
  await realClickText('立即保存')
  await sleep(1800)
  const sampling = await stopSampler()
  const after = { mark: await editorMark(), writes: await writesSince(t0), journal: await journalOf('writing') }
  // 保存后重新聚焦继续写：节点被换过的话这里最容易露馅（选区/焦点都在旧节点上）
  await resumeAtEnd()
  await session.send('Input.insertText', { text: '保存后继续写。' })
  await sleep(2200)
  const resumed = { text: await editorText(), mark: await editorMark(), writes: await writesSince(t0) }
  return { sampling, after, resumed }
}

/* V11：组合中真实点击切页 —— 真实顺序是 blur → compositionend → click；检查是否留 ime 残留 */
scenarios['V11 Set 组合中切页再回来'] = async () => {
  const base = await seed('V11 已保存句。', 'set')
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(400)
  const before = { editor: await editorText(), focused: await focused(), navWritable: await session.eval(`(() => { const b = [...document.querySelectorAll('nav button')].find((x) => x.textContent.trim() === '概览'); return b ? { disabled: b.disabled } : null })()`) }
  await realClickText('概览')
  await sleep(2200)
  const afterNav = {
    onDashboard: await session.eval(`document.querySelector('.ritual-page') === null`),
    leaveDialog: await session.eval(`(() => { const d = document.querySelector('dialog'); return d ? { open: d.open, title: d.querySelector('h2')?.textContent ?? '' } : null })()`),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  await shot('set-nav-real-click')
  await realClickText('开始今天')
  await sleep(1500)
  const back = { editor: await editorText(), onRitual: await session.eval(`document.querySelector('.ritual-page') !== null`) }
  // 关键：组合标记若残留，这里之后的保存会被永久拦下
  await resumeAtEnd()
  await session.send('Input.insertText', { text: ' 回来后继续写。' })
  await sleep(2600)
  const resumed = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set') }
  return { base, before, afterNav, back, resumed }
}

async function main() {
  const { child, wsUrl } = await launch({ port: 9248 })
  session = await openSession(wsUrl)
  try {
    await session.installRecorder()
    for (const [name, fn] of Object.entries(scenarios)) {
      await reset()
      try {
        const data = await fn()
        results.push({ scenario: name, ...data })
        console.log(`\n### ${name}`)
        console.log(JSON.stringify(data).slice(0, 900))
      } catch (error) {
        results.push({ scenario: name, error: String((error && error.stack) || error) })
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
  await writeFile(join(OUT, 'run15-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第十五轮完成：${results.length} 条`)
}

main().catch((error) => { console.error(error); process.exit(1) })
