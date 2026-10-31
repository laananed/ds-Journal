/** 第十二轮：补跑 Set 组合中切页，以及已保存目标是否受同类问题影响。 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const OUT = process.env.QA_OUT ?? '.'
const results = []
const shots = []
let shotIndex = 0

const api = async (p, o) => await (await fetch(BASE + p, o)).json()
const reset = () => api('/__mock/reset', { method: 'POST' })
const readLog = () => api('/__mock/log')
const readState = () => api('/__mock/state')

let session = null
const editorText = () => session.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
const textOf = (sel) => session.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
const has = (sel) => session.eval(`document.querySelector(${JSON.stringify(sel)}) !== null`)

function summarize(journal) {
  if (!journal) return null
  const goals = []
  const walk = (n) => {
    if (n === null || typeof n !== 'object') return
    if (n.type === 'goalItem') goals.push(n.attrs?.text ?? null)
    if (Array.isArray(n.content)) n.content.forEach(walk)
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
  return l.requests.filter((r) => r.iso >= iso).map((r) => ({ dt: r.iso - iso, method: r.method, path: r.path, text: r.text ?? null, result: r.result ?? 200 }))
}
async function shot(name) {
  shotIndex += 1
  const file = join(OUT, `r12-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}
async function openModule(label) {
  await session.goto(BASE + '/')
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 15000)
  await sleep(900)
}
async function resumeAtEnd() {
  await session.eval(`(() => { const el = document.querySelector('.s4-editor-content'); el.focus(); return true })()`)
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await sleep(80)
}
async function enter() {
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await session.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: type === 'char' ? '\r' : undefined,
    })
  }
  await sleep(150)
}

const scenarios = {}

scenarios['T1 Set 组合中切页（0.3s 时）'] = async () => {
  await openModule('开始今天')
  await resumeAtEnd()
  await session.send('Input.insertText', { text: 'T1 已保存句。' })
  await sleep(2600)
  const base = await journalOf('set')
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(300)
  const before = {
    editor: await editorText(),
    nav: await session.eval(`[...document.querySelectorAll('nav button')].slice(0, 4).map((b) => ({ label: b.textContent.trim(), disabled: b.disabled }))`),
  }
  await session.clickText('写作')
  await sleep(1800)
  const afterNav = {
    onWriting: await has('.writing-editor'),
    onRitual: await has('.ritual-page'),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  await shot('set-nav-during-composition')
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }
  return { base, before, afterNav, reopened }
}

scenarios['T2 Set 组合中切页（保存已完成后）'] = async () => {
  await openModule('开始今天')
  await resumeAtEnd()
  await session.send('Input.insertText', { text: 'T2 已保存句。' })
  await sleep(2600)
  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(1300)
  const before = { editor: await editorText(), writes: await writesSince(t0), focused: await session.eval(`document.activeElement === document.querySelector('.s4-editor-content')`) }
  await session.clickText('写作')
  await sleep(1500)
  const afterNav = { onWriting: await has('.writing-editor'), writes: await writesSince(t0), journal: await journalOf('set') }
  await openModule('开始今天')
  const reopened = { editor: await editorText() }
  return { before, afterNav, reopened }
}

scenarios['T3 已保存目标 + 其它段落组合跨窗口'] = async () => {
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await resumeAtEnd()
  await session.send('Input.insertText', { text: '买牛奶' })
  await sleep(2800)                      // 自动转目标
  const withGoal = { journal: await journalOf('set'), panel: await textOf('.ritual-goals') }

  // 在目标后面新增一段普通文字
  await resumeAtEnd()
  await enter()
  await session.send('Input.insertText', { text: '备注段。' })
  await sleep(2600)
  const withNote = { journal: await journalOf('set'), panel: await textOf('.ritual-goals') }

  await resumeAtEnd()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1500)
  const polluted = { editor: await editorText(), journal: await journalOf('set'), panel: await textOf('.ritual-goals'), writes: await writesSince(t0) }
  await openModule('开始今天')
  const reopened = { panel: await textOf('.ritual-goals'), journal: await journalOf('set') }
  return { withGoal, withNote, polluted, reopened }
}

async function main() {
  const { child, wsUrl } = await launch({ port: 9247 })
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
        results.push({ scenario: name, error: String(error && error.stack || error) })
        console.log(`\n### ${name} FAILED: ${error}`)
        await shot('failure').catch(() => {})
      }
    }
  } finally {
    await session.close()
    child.kill()
  }
  await writeFile(join(OUT, 'run12-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第十二轮完成：${results.length} 条`)
}

main().catch((error) => { console.error(error); process.exit(1) })
