/**
 * 第十轮：Set / End 输入法组合期间的自动保存行为，以及与 Writing 的对比。
 *
 * 重要边界：这里用 CDP 的 `Input.imeSetComposition` / `Input.insertText` 驱动，
 * 产生的是**浏览器层真实派发**的 compositionstart / compositionupdate /
 * beforeinput(insertCompositionText) / compositionend 事件，但**不是真实中文输入法**
 * （没有候选窗、没有真实按键到拼音的转换、没有输入法进程）。
 * 因此所有结论都只能是「模拟组合下的前端行为」，真实 IME 仍需人工复核。
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
  const res = await fetch(BASE + path, options)
  return await res.json()
}
const reset = () => api('/__mock/reset', { method: 'POST' })
const mark = (label) => api('/__mock/mark', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
})
const readLog = () => api('/__mock/log')
const readState = () => api('/__mock/state')
const setFault = (patch) => api('/__mock/fault', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
})

const editorText = (s) => s.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
const textOf = (s, selector) => s.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
const navState = (s) => s.eval(`[...document.querySelectorAll('nav button')].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.title || null }))`)
const has = (s, selector) => s.eval(`document.querySelector(${JSON.stringify(selector)}) !== null`)

function summarize(journal) {
  if (journal === null || journal === undefined) return null
  const goals = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'goalItem') goals.push({ text: node.attrs?.text ?? null, checked: node.attrs?.checked ?? null })
    if (Array.isArray(node.content)) node.content.forEach(walk)
  }
  walk(journal.content_doc)
  return {
    id: journal.id,
    kind: journal.journal_kind,
    revision: journal.revision,
    text: journal.content,
    goals,
  }
}

async function journalOf(kind) {
  const s = await readState()
  return summarize(s.journals.find((j) => j.journal_kind === kind && j.deleted_at === null) ?? null)
}

async function writesSince(iso) {
  const l = await readLog()
  return l.requests
    .filter((r) => r.iso >= iso)
    .map((r) => ({
      dt: r.iso - iso,
      method: r.method,
      path: r.path,
      text: r.text ?? null,
      expectedRevision: r.body?.expected_revision ?? null,
      result: r.result ?? 200,
    }))
}

async function eventsSince(iso) {
  const all = await session.qaEvents()
  return all
    .filter((e) => e.iso >= iso)
    .map((e) => ({ dt: e.iso - iso, type: e.type, data: e.data, inputType: e.inputType }))
}

async function shot(name) {
  shotIndex += 1
  const file = join(OUT, `r10-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

async function openModule(label) {
  await session.goto(BASE + '/')
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}

async function focusEditor() {
  await session.eval(`(() => { const el = document.querySelector('.s4-editor-content'); if (!el) return false; el.focus(); return true })()`)
}

async function typeRaw(text) {
  await session.send('Input.insertText', { text })
  await sleep(120)
}

/* ------------------------------------------------------------------ 场景 */

const scenarios = {}

scenarios['S1 Set 组合超过自动保存等待后正常上屏'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S1 基础句。')
  await sleep(2400)
  const base = await journalOf('set')

  const t0 = Date.now()
  await mark('S1 composition start')
  await session.imeSet('nihao')
  await sleep(1250)                      // 超过 900ms 自动保存窗口
  await session.imeSet('nihaoa')
  await sleep(500)
  const during = {
    editor: await editorText(session),
    writes: await writesSince(t0),
    status: await textOf(session, '.ritual-status'),
  }
  await mark('S1 composition commit')
  await session.imeCommit('你好')
  await sleep(2700)

  return {
    base,
    during,
    after: {
      editor: await editorText(session),
      writes: await writesSince(t0),
      journal: await journalOf('set'),
      status: await textOf(session, '.ritual-status'),
    },
    events: (await eventsSince(t0)).slice(0, 24),
  }
}

scenarios['S2 Set 组合短于等待即上屏'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S2 基础句。')
  await sleep(2400)
  const base = await journalOf('set')

  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(280)
  await session.imeCommit('你好')
  await sleep(2600)

  return {
    base,
    after: {
      editor: await editorText(session),
      writes: await writesSince(t0),
      journal: await journalOf('set'),
      status: await textOf(session, '.ritual-status'),
    },
    events: (await eventsSince(t0)).slice(0, 20),
  }
}

scenarios['S3 Set 组合中取消选词'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S3 基础句。')
  await sleep(2400)
  const base = await journalOf('set')

  const t0 = Date.now()
  await mark('S3 composition start')
  await session.imeSet('shijie')
  await sleep(1600)                      // 自动保存已在组合中触发
  const mid = { editor: await editorText(session), writes: await writesSince(t0), journal: await journalOf('set') }
  await mark('S3 composition cancel')
  await session.imeCancel()
  await sleep(2700)
  const after = { editor: await editorText(session), writes: await writesSince(t0), journal: await journalOf('set') }

  // 刷新 + 重新进入，确认服务器最终内容
  await openModule('开始今天')
  const reopened = { editor: await editorText(session), journal: await journalOf('set') }

  return { base, mid, after, reopened, events: (await eventsSince(t0)).slice(0, 24) }
}

scenarios['S4 Set 组合中切页（自动保存尚未触发）'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S4 基础句。')
  await sleep(2400)
  const base = await journalOf('set')

  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(300)
  const beforeClick = { editor: await editorText(session), nav: await navState(session) }
  await session.clickText('写作')
  await sleep(2000)
  const afterNav = {
    onWriting: await has(session, '.writing-editor'),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  await shot('set-nav-during-composition')

  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000)
  await sleep(1400)
  const back = { editor: await editorText(session), journal: await journalOf('set') }

  return { base, beforeClick, afterNav, back }
}

scenarios['S5 Set 组合中切页（自动保存已触发）'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S5 基础句。')
  await sleep(2400)
  const base = await journalOf('set')

  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(1500)
  const beforeClick = { editor: await editorText(session), writes: await writesSince(t0) }
  await session.clickText('写作')
  await sleep(1800)
  const afterNav = { onWriting: await has(session, '.writing-editor'), writes: await writesSince(t0), journal: await journalOf('set') }

  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000)
  await sleep(1400)
  const back = { editor: await editorText(session) }
  return { base, beforeClick, afterNav, back }
}

scenarios['S6 Set 组合中保存失败'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S6 基础句。')
  await sleep(2400)
  const base = await journalOf('set')

  await setFault({ patchStatus: 503 })
  const t0 = Date.now()
  await session.imeSet('shibai')
  await sleep(1400)
  await session.imeCommit('失败')
  await sleep(2700)
  const after = {
    editor: await editorText(session),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    status: await textOf(session, '.ritual-status'),
    alert: await textOf(session, '.ritual-alert'),
  }
  await shot('set-fail-during-composition')
  await setFault({ patchStatus: null })
  return { base, after }
}

scenarios['S7 Set 组合中自动转目标'] = async () => {
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await focusEditor()
  await typeRaw('买')
  const t0 = Date.now()
  await session.imeSet('ni')
  await sleep(1700)                     // 自动保存 + 自动转目标都可能落在窗口内
  const mid = {
    editor: await editorText(session),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf(session, '.ritual-goals'),
  }
  await shot('set-goal-during-composition')
  await session.imeCommit('你好')
  await sleep(2800)
  const after = {
    editor: await editorText(session),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    goalsPanel: await textOf(session, '.ritual-goals'),
    status: await textOf(session, '.ritual-status'),
  }
  return { mid, after }
}

scenarios['S8 End 组合超过等待后取消'] = async () => {
  await openModule('结束今天')
  await focusEditor()
  await typeRaw('S8 基础句。')
  await sleep(2400)
  const base = await journalOf('end')

  const t0 = Date.now()
  await session.imeSet('shijie')
  await sleep(1600)
  const mid = { editor: await editorText(session), writes: await writesSince(t0), journal: await journalOf('end') }
  await session.imeCancel()
  await sleep(2600)
  const after = { editor: await editorText(session), writes: await writesSince(t0), journal: await journalOf('end') }

  await openModule('结束今天')
  const reopened = { editor: await editorText(session), journal: await journalOf('end') }
  return { base, mid, after, reopened }
}

scenarios['W1 Writing 组合超过等待后上屏（对照）'] = async () => {
  await openModule('写作')
  await focusEditor()
  await typeRaw('W1 基础句。')
  await sleep(2600)
  const base = await journalOf('writing')

  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  await session.imeSet('nihaoa')
  await sleep(400)
  const during = {
    editor: await editorText(session),
    writes: await writesSince(t0),
    status: await textOf(session, '.writing-status'),
  }
  await session.imeCommit('你好')
  await sleep(2600)
  return {
    base,
    during,
    after: {
      editor: await editorText(session),
      writes: await writesSince(t0),
      journal: await journalOf('writing'),
      status: await textOf(session, '.writing-status'),
    },
  }
}

scenarios['W2 Writing 组合中切页'] = async () => {
  await openModule('写作')
  await focusEditor()
  await typeRaw('W2 基础句。')
  await sleep(2600)
  const base = await journalOf('writing')

  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(300)
  const beforeClick = { editor: await editorText(session), nav: await navState(session) }
  await session.clickText('概览')
  await sleep(2200)
  const afterNav = { onDashboard: await has(session, '.dashboard'), writes: await writesSince(t0), journal: await journalOf('writing') }
  return { base, beforeClick, afterNav }
}

scenarios['W3 Writing 保存中点导航'] = async () => {
  await openModule('写作')
  await focusEditor()
  await typeRaw('W3 慢保存句。')
  await sleep(2600)
  await setFault({ patchDelayMs: 3000 })
  await focusEditor()
  await typeRaw(' 追加。')
  await sleep(1150)                       // 自动保存已发出，正卡在 3s 延迟里
  const navBefore = await navState(session)
  const clickedAt = Date.now()
  await session.clickText('概览')
  let changedAt = null
  for (let i = 0; i < 25; i += 1) {
    if (await has(session, '.dashboard')) { changedAt = Date.now(); break }
    await sleep(100)
  }
  const during = {
    changedWithin1500ms: changedAt !== null,
    msToChange: changedAt === null ? null : changedAt - clickedAt,
    notice: await textOf(session, '.app-notice'),
    writingStatus: await textOf(session, '.writing-status'),
  }
  await shot('writing-nav-during-save')
  await sleep(2600)
  await setFault({ patchDelayMs: 0 })
  const after = {
    onDashboard: await has(session, '.dashboard'),
    msToChange: Date.now() - clickedAt,
    journal: await journalOf('writing'),
  }
  return { navBefore, during, after }
}

scenarios['S9 Set 保存中点导航'] = async () => {
  await openModule('开始今天')
  await focusEditor()
  await typeRaw('S9 慢保存句。')
  await sleep(2400)
  await setFault({ patchDelayMs: 3000 })
  await focusEditor()
  await typeRaw(' 追加。')
  await sleep(1150)
  const navBefore = await navState(session)
  const statusDuring = await textOf(session, '.ritual-status')
  const clicked = await session.eval(`(() => {
    const btn = [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === '写作')
    if (!btn) return { found: false }
    btn.click()
    return { found: true, disabled: btn.disabled, title: btn.title || null }
  })()`)
  await sleep(900)
  const during = {
    clicked,
    stillOnRitual: await has(session, '.ritual-page'),
    status: statusDuring,
    hint: await session.eval(`document.body.innerText.includes('保存中') || document.body.innerText.includes('正在保存')`),
  }
  await shot('set-nav-disabled-during-save')
  await sleep(3000)
  await setFault({ patchDelayMs: 0 })
  const after = {
    nav: await navState(session),
    journal: await journalOf('set'),
    stillOnRitual: await has(session, '.ritual-page'),
  }
  return { navBefore, during, after }
}

// 场景函数共享同一个会话（单页顺序执行，避免并发干扰）
let session = null

async function main() {
  const { child, wsUrl } = await launch({ port: 9242 })
  const s = await openSession(wsUrl)
  session = s
  globalThis.session = s
  const run = async (name, fn) => {
    await reset()
    try {
      const data = await fn()
      results.push({ scenario: name, ...data })
      console.log(`\n### ${name}`)
      console.log(JSON.stringify(data).slice(0, 900))
    } catch (error) {
      results.push({ scenario: name, error: String(error && error.stack || error) })
      console.log(`\n### ${name} FAILED: ${error}`)
      await shot('failure').catch(() => {})
    }
  }
  try {
    await s.installRecorder()
    for (const [name, fn] of Object.entries(scenarios)) {
      await run(name, fn)
    }
    const errors = s.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 200))
    results.push({ scenario: '控制台', exceptions: errors.slice(-5) })
  } finally {
    await s.close()
    child.kill()
  }
  await writeFile(join(OUT, 'run10-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第十轮完成：${results.length} 条`)
}

main().catch((error) => { console.error(error); process.exit(1) })
