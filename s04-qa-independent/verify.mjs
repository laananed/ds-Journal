/**
 * 独立复测 v2：Set / End 输入法组合与保存焦点修复（不改产品代码）。
 *
 * 与 v1 的差别（v1 的失败已定位为夹具缺陷）：
 * - 种子文档的节点 id 必须是 UUID：`serverAttrs` 只保留 UUID 形态的 id，
 *   否则打开页面时会被投影清掉并触发一次多余 PATCH，导致版本号全部偏移；
 * - Writing 不预置记录：写作页默认新建草稿，预置记录不会被打开；
 * - 模板文本读 textarea.value（innerText 读不到受控值）；
 * - 失败提示按实际文案断言（状态行 / 告警行分工不同）。
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8041'
const OUT = process.env.QA_OUT ?? '.'
const DAY = '2026-10-31'
const ED = '.s4-editor-content'

const results = []
const shots = []
let shotIndex = 0
let session = null

/* ------------------------------------------------------------------ HTTP */
async function api(path, options) {
  const res = await fetch(BASE + path, options)
  return await res.json()
}
const reset = () => api('/__mock/reset', { method: 'POST' })
const readState = () => api('/__mock/state')
const readLog = () => api('/__mock/log')
const setFault = (patch) => api('/__mock/fault', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
})

/* ------------------------------------------------------------ 文档构造 */
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const text = (t) => ({ type: 'text', text: t })
const para = (t, id) => ({ type: 'paragraph', attrs: { id }, content: t === '' ? [] : [text(t)] })
function docPara(...paras) {
  return { type: 'doc', content: paras.map((p, i) => para(p, uuid(100 + i))) }
}

async function seedDoc(kind, doc, title = null, deleted = false) {
  const res = await fetch(BASE + '/api/journals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ journal_kind: kind, journal_date: DAY, content_doc: doc, title, deleted }),
  })
  return await res.json()
}

/* --------------------------------------------------------------- 页面读 */
const editorText = () => session.eval(`document.querySelector('${ED}')?.innerText ?? ''`)
const textOf = (sel) => session.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
const focused = () => session.eval(`document.activeElement === document.querySelector('${ED}')`)
const editableAttr = () => session.eval(`document.querySelector('${ED}')?.getAttribute('contenteditable') ?? null`)
const editorMark = () => session.eval(`document.querySelector('${ED}')?.dataset.qaMark ?? null`)
const has = (sel) => session.eval(`document.querySelector(${JSON.stringify(sel)}) !== null`)

async function markEditor(label) {
  return await session.eval(`(() => {
    const el = document.querySelector('${ED}')
    if (!el) return false
    el.dataset.qaMark = ${JSON.stringify(label)}
    return true
  })()`)
}

async function startSampler(intervalMs = 20) {
  await session.eval(`(() => {
    window.__samples = []
    clearInterval(window.__timer)
    window.__timer = setInterval(() => {
      const el = document.querySelector('${ED}')
      window.__samples.push({
        mark: el?.dataset.qaMark ?? null,
        editable: el?.getAttribute('contenteditable') ?? null,
        active: document.activeElement === el,
      })
    }, ${intervalMs})
    return true
  })()`)
}
async function stopSampler() {
  const samples = await session.eval(`(() => { clearInterval(window.__timer); return window.__samples || [] })()`)
  if (!Array.isArray(samples) || samples.length === 0) return { count: 0 }
  const marks = [...new Set(samples.map((s) => s.mark))]
  return {
    count: samples.length,
    marks,
    rebuilt: marks.some((m) => m === null),
    editableValues: [...new Set(samples.map((s) => s.editable))],
    lostFocusSamples: samples.filter((s) => s.active === false).length,
  }
}

function summarize(journal) {
  if (!journal) return null
  const goals = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'goalItem') goals.push({ text: node.attrs?.text ?? null, checked: node.attrs?.checked ?? null })
    if (Array.isArray(node.content)) node.content.forEach(walk)
  }
  walk(journal.content_doc)
  return { id: journal.id, revision: journal.revision, title: journal.title, text: journal.content, goals }
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
    .map((e) => ({ dt: e.iso - iso, type: e.type, data: e.data ?? null }))
}

async function shot(name) {
  shotIndex += 1
  const file = join(OUT, `iv-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

/* ------------------------------------------------------------- 操作原语 */
/** 光标放到正文末尾：直接设 DOM 选区（比 Ctrl+End 稳定，避免规范化事务重置选择）。 */
async function focusEnd() {
  const result = await session.eval(`(() => {
    const el = document.querySelector('${ED}')
    if (!el) return null
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return { collapsed: range.collapsed, textLength: el.innerText.length }
  })()`)
  await sleep(80)
  return result
}
async function typeText(t) {
  await session.send('Input.insertText', { text: t })
  await sleep(120)
}
async function pressEnter() {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(120)
}

async function realClickText(label) {
  const box = await session.eval(`(() => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')]
      .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled }
  })()`)
  if (box === null) throw new Error(`找不到按钮：${label}`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(160)
  return { disabled: box.disabled }
}

async function realClickSelector(sel) {
  const box = await session.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)})
    if (!el) return null
    el.scrollIntoView({ block: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: el.disabled }
  })()`)
  if (box === null) throw new Error(`找不到元素：${sel}`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await sleep(160)
  return { disabled: box.disabled }
}

async function openModule(label) {
  await session.goto(BASE + '/')
  await session.eval(`(() => { localStorage.clear(); sessionStorage.clear(); return true })()`)
  await session.goto(BASE + '/')
  await session.clickText(label)
  await session.waitFor(`document.querySelector('${ED}') !== null`, 15000)
  await sleep(900)
}

function check(list, name, ok, detail) {
  list.push({ name, ok: Boolean(ok), detail: detail ?? null })
}

/* --------------------------------------------------------------- 场景 */
const scenarios = {}

/* I1 Set：组合 1.6s 不落库、不丢焦点；上屏后正确保存 */
scenarios['I1 Set 组合保持 1.6s'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I1 已保存句。'))
  await openModule('开始今天')
  const baseline = await journalOf('set')
  await markEditor('A')
  await focusEnd()
  await session.clearQaEvents()
  await startSampler(25)
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1600)
  const during = {
    editable: await editableAttr(), focused: await focused(), mark: await editorMark(),
    writes: await writesSince(t0), status: await textOf('.ritual-status'),
  }
  const sampling = await stopSampler()
  await shot('set-composition-held')
  await session.imeCommit('你好')
  await sleep(2800)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set'), status: await textOf('.ritual-status') }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }

  check(checks, '打开页面不产生额外写请求', baseline?.revision === 1, baseline)
  check(checks, '组合期零写请求', during.writes.length === 0, during.writes)
  check(checks, '组合期编辑器仍可编辑且焦点未丢', during.editable === 'true' && during.focused === true, during)
  check(checks, '组合期节点未被替换', during.mark === 'A', during.mark)
  check(checks, '采样无重建且零失焦', sampling.rebuilt === false && sampling.lostFocusSamples === 0, sampling)
  check(checks, '上屏后只提交已确认文本', after.writes.length === 1 && after.writes[0].text === 'I1 已保存句。你好', after.writes)
  check(checks, '服务器文档正确且版本 +1', after.journal?.text === 'I1 已保存句。你好' && after.journal?.revision === 2, after.journal)
  check(checks, '刷新后一致且无拼音残留', reopened.editor === 'I1 已保存句。你好' && !reopened.editor.includes('nihao'), reopened)
  return { checks, baseline, during, sampling, after, reopened }
}

/* I2 End */
scenarios['I2 End 组合保持 1.6s'] = async () => {
  const checks = []
  await seedDoc('end', docPara('I2 已保存句。'))
  await openModule('结束今天')
  await markEditor('B')
  await focusEnd()
  await startSampler(25)
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1600)
  const during = { editable: await editableAttr(), focused: await focused(), mark: await editorMark(), writes: await writesSince(t0) }
  const sampling = await stopSampler()
  await session.imeCommit('你好')
  await sleep(2800)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('end') }
  await openModule('结束今天')
  const reopened = { editor: await editorText(), journal: await journalOf('end') }

  check(checks, '组合期零写请求', during.writes.length === 0, during.writes)
  check(checks, '组合期可编辑且焦点未丢', during.editable === 'true' && during.focused === true, during)
  check(checks, '采样无重建且零失焦', sampling.rebuilt === false && sampling.lostFocusSamples === 0, sampling)
  check(checks, '上屏后仅一次 PATCH 且文本正确', after.writes.length === 1 && after.writes[0].text === 'I2 已保存句。你好', after.writes)
  check(checks, '刷新后一致', reopened.editor === 'I2 已保存句。你好' && !reopened.editor.includes('nihao'), reopened)
  return { checks, during, sampling, after, reopened }
}

/* I3 Set 清单：组合 2s 不转目标；上屏后目标 = 买牛奶 且只有一个 */
scenarios['I3 Set 清单组合不转目标'] = async () => {
  const checks = []
  await seedDoc('set', docPara(''))
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await focusEnd()
  await typeText('买')
  await markEditor('G')
  const t0 = Date.now()
  await session.imeSet('ni')
  await sleep(2000)
  const during = { writes: await writesSince(t0), journal: await journalOf('set'), mark: await editorMark(), editable: await editableAttr() }
  await shot('set-goal-during-composition')
  await session.imeCommit('牛奶')
  await sleep(3400)
  const after = { writes: await writesSince(t0), journal: await journalOf('set'), panel: await textOf('.ritual-goals'), editor: await editorText() }
  await shot('set-goal-after-commit')
  await openModule('开始今天')
  const reopened = { journal: await journalOf('set'), panel: await textOf('.ritual-goals') }

  check(checks, '组合期零写请求（含转目标）', during.writes.length === 0, during.writes)
  check(checks, '组合期服务器无 goalItem', (during.journal?.goals ?? []).length === 0, during.journal?.goals)
  check(checks, '组合期节点未被替换', during.mark === 'G' && during.editable === 'true', during)
  check(checks, '上屏后目标文本为「买牛奶」',
    (after.journal?.goals ?? []).length === 1 && after.journal.goals[0].text === '买牛奶', after.journal?.goals)
  check(checks, '无拼音进入正文或目标',
    !(after.journal?.text ?? '').includes('ni') && !(after.journal?.goals ?? []).some((g) => String(g.text).includes('ni')), after.journal)
  check(checks, '刷新后目标仍为 1 个', (reopened.journal?.goals ?? []).length === 1, reopened)
  return { checks, during, after, reopened }
}

/* I4 组合 1.4s 后取消 */
scenarios['I4 Set 组合后取消'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I4 已保存句。'))
  await openModule('开始今天')
  await focusEnd()
  const t0 = Date.now()
  await session.imeSet('shijie')
  await sleep(1400)
  const duringWrites = await writesSince(t0)
  await session.imeCancel()
  await sleep(1900)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set') }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }

  check(checks, '组合期与取消后均零写请求', duringWrites.length === 0 && after.writes.length === 0, { duringWrites, after: after.writes })
  check(checks, '取消后正文回到原文', after.editor === 'I4 已保存句。' && after.journal?.text === 'I4 已保存句。', after)
  check(checks, '刷新后无残留', reopened.editor === 'I4 已保存句。' && !reopened.editor.includes('shijie'), reopened)
  return { checks, duringWrites, after, reopened }
}

/* I5 组合 300ms 内上屏 */
scenarios['I5 Set 组合窗口内上屏'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I5 已保存句。'))
  await openModule('开始今天')
  await focusEnd()
  const t0 = Date.now()
  await session.imeSet('kuai')
  await sleep(300)
  await session.imeCommit('快')
  await sleep(2800)
  const after = { editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set') }
  check(checks, '仅一次保存且内容正确', after.writes.length === 1 && after.writes[0].text === 'I5 已保存句。快', after.writes)
  check(checks, '服务器文本正确', after.journal?.text === 'I5 已保存句。快', after.journal)
  check(checks, '版本只 +1', after.journal?.revision === 2, after.journal?.revision)
  return { checks, after }
}

/* I6 标题组合 */
scenarios['I6 标题组合 1.5s'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I6 正文。'))
  await openModule('开始今天')
  const titleSel = '.ritual-title-field input'
  await session.eval(`(() => { document.querySelector(${JSON.stringify(titleSel)}).focus(); return true })()`)
  const t0 = Date.now()
  await typeText('标')
  await session.imeSet('ti')
  await sleep(1500)
  const during = { writes: await writesSince(t0), journal: await journalOf('set'), value: await session.eval(`document.querySelector(${JSON.stringify(titleSel)})?.value ?? null`) }
  await session.imeCommit('题目')
  await sleep(2800)
  const after = { writes: await writesSince(t0), journal: await journalOf('set') }
  check(checks, '组合期标题未落库', during.writes.length === 0 && during.journal?.title === null, during)
  check(checks, '上屏后标题为「标题目」', after.journal?.title === '标题目', after.journal?.title)
  check(checks, '正文未被标题输入污染', after.journal?.text === 'I6 正文。', after.journal?.text)
  return { checks, during, after }
}

/* I7 组合中失焦到标题框 */
scenarios['I7 组合中失焦到标题框'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I7 已保存句。'))
  await openModule('开始今天')
  await focusEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('shiqu')
  await sleep(400)
  await realClickSelector('.ritual-title-field input')
  await sleep(900)
  const mid = {
    events: (await eventsSince(t0)).map((e) => `${e.dt}ms ${e.type}${e.data ? `:"${e.data}"` : ''}`),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
    editor: await editorText(),
  }
  await focusEnd()
  await typeText(' 继续写。')
  await sleep(2800)
  const after = { writes: await writesSince(t0), journal: await journalOf('set'), editor: await editorText() }
  check(checks, '失焦时浏览器派发 compositionend', mid.events.some((e) => e.includes('compositionend')), mid.events)
  check(checks, '失焦提交的文本与页面一致（浏览器行为，非应用打断）',
    (mid.journal?.text ?? '') === mid.editor || mid.writes.length === 0, { server: mid.journal?.text, editor: mid.editor })
  check(checks, '之后仍可保存（ime 标记未卡死）',
    after.writes.some((w) => w.method === 'PATCH' && w.result === 200) && (after.journal?.text ?? '').includes('继续写'), after)
  return { checks, mid, after }
}

/* I8 上屏后 503 */
scenarios['I8 Set 上屏后 503 重试'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I8 已保存句。'))
  await openModule('开始今天')
  await setFault({ patchStatus: 503 })
  await focusEnd()
  const t0 = Date.now()
  await session.imeSet('shibai')
  await sleep(1200)
  const duringWrites = await writesSince(t0)
  await session.imeCommit('失败')
  await sleep(2400)
  const failed = {
    editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set'),
    alert: await textOf('.ritual-alert'), status: await textOf('.ritual-status'), focused: await focused(),
  }
  await shot('set-503')
  await setFault({ patchStatus: null })
  await session.clickText('重试保存')
  await sleep(2800)
  const retried = { editor: await editorText(), journal: await journalOf('set'), writes: await writesSince(t0) }

  check(checks, '组合期零请求', duringWrites.length === 0, duringWrites)
  check(checks, '失败后输入完整保留', failed.editor === 'I8 已保存句。失败', failed.editor)
  check(checks, '失败后服务器未变', failed.journal?.text === 'I8 已保存句。' && failed.journal?.revision === 1, failed.journal)
  check(checks, '状态行说明保存失败且本地草稿已保存',
    /保存失败/.test(failed.status) && /本地草稿已保存/.test(failed.status), failed.status)
  check(checks, '重试成功后内容落库且版本 2',
    retried.journal?.text === 'I8 已保存句。失败' && retried.journal?.revision === 2, retried.journal)
  return { checks, duringWrites, failed, retried }
}

/* I9 真实 409 */
scenarios['I9 Set 真实 409 冲突恢复'] = async () => {
  const checks = []
  const seeded = await seedDoc('set', docPara('I9 服务端原文。'))
  await openModule('开始今天')
  const external = await fetch(`${BASE}/api/journals/${seeded.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_revision: 1, content_doc: docPara('I9 外部新版本。'), title: null }),
  })
  await focusEnd()
  const t0 = Date.now()
  await typeText(' 本地新增。')
  await sleep(2400)
  const conflicted = {
    editor: await editorText(), writes: await writesSince(t0), journal: await journalOf('set'),
    alert: await textOf('.ritual-alert'), status: await textOf('.ritual-status'),
  }
  await shot('set-409')
  await session.clickText('读取服务器最新版本')
  await sleep(1200)
  const snapshot = { text: await textOf('.ritual-conflict') }
  await session.clickText('保留本地草稿并基于最新重写')
  await sleep(3200)
  const resolved = { journal: await journalOf('set'), writes: await writesSince(t0), editor: await editorText() }
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }

  check(checks, '外部版本确实推进到 2', external.status === 200, external.status)
  check(checks, '冲突前服务器为新版本', conflicted.journal?.revision === 2 && conflicted.journal?.text === 'I9 外部新版本。', conflicted.journal)
  check(checks, '本地输入未被覆盖', conflicted.editor.includes('本地新增'), conflicted.editor)
  check(checks, '冲突提示可见', /版本冲突/.test(conflicted.alert) || /冲突/.test(conflicted.status), { alert: conflicted.alert, status: conflicted.status })
  check(checks, '服务器快照可读', /revision 2/.test(snapshot.text), snapshot.text)
  check(checks, '恢复后本地文本落库且无重复',
    (resolved.journal?.text ?? '').includes('本地新增') && (resolved.journal?.text ?? '').split('本地新增').length === 2, resolved.journal)
  check(checks, '刷新后一致', (reopened.journal?.text ?? '').includes('本地新增'), reopened)
  return { checks, conflicted, snapshot, resolved, reopened }
}

/* I10 目标转换失败（500） */
scenarios['I10 目标转换失败后手动重试'] = async () => {
  const checks = []
  await seedDoc('set', docPara(''))
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await setFault({ goalsStatus: 500 })
  await focusEnd()
  await typeText('买咖啡')
  await sleep(3400)
  const failed = { journal: await journalOf('set'), goalsPanel: await textOf('.ritual-goals'), alert: await textOf('.ritual-alert'), editor: await editorText() }
  await setFault({ goalsStatus: null })
  let retried = null
  if (failed.goalsPanel.includes('转为目标')) {
    await session.clickText('转为目标')
    await sleep(3200)
    retried = { journal: await journalOf('set'), panel: await textOf('.ritual-goals') }
  }
  await openModule('开始今天')
  const reopened = { journal: await journalOf('set'), panel: await textOf('.ritual-goals') }

  check(checks, '转换失败时未产生 goalItem', (failed.journal?.goals ?? []).length === 0, failed.journal?.goals)
  check(checks, '清单文本完整保留', failed.journal?.text?.includes('买咖啡') === true, failed.journal?.text)
  check(checks, '失败提示可见', failed.alert.length > 0, failed.alert)
  check(checks, '提供手动重试入口', failed.goalsPanel.includes('转为目标'), failed.goalsPanel)
  check(checks, '重试后恰好 1 个目标且文本正确',
    (retried?.journal?.goals ?? []).length === 1 && retried.journal.goals[0].text === '买咖啡', retried?.journal?.goals)
  check(checks, '刷新后无重复目标', (reopened.journal?.goals ?? []).length === 1, reopened.journal?.goals)
  return { checks, failed, retried, reopened }
}

/* I11 普通自动保存：节点 / 焦点 / 光标连续 */
scenarios['I11 Set 普通保存焦点稳定'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I11 已保存句。'))
  await openModule('开始今天')
  await markEditor('C')
  const caret = await focusEnd()
  await startSampler(20)
  const t0 = Date.now()
  await typeText(' 追加句。')
  await sleep(2600)
  const sampling = await stopSampler()
  const afterSave = { focused: await focused(), mark: await editorMark(), editable: await editableAttr(), writes: await writesSince(t0), status: await textOf('.ritual-status') }
  await typeText('盲打续写')
  await sleep(200)
  const typed = await editorText()
  await sleep(2600)
  const saved = { journal: await journalOf('set'), writes: await writesSince(t0), mark: await editorMark() }
  await shot('set-focus-after-save')

  check(checks, '输入落在末尾', typed.includes('已保存句。 追加句。'), { caret, typed })
  check(checks, '保存期间无重建', sampling.rebuilt === false && sampling.marks.join(',') === 'C', sampling)
  check(checks, '保存期间 contenteditable 恒为 true', sampling.editableValues.join(',') === 'true', sampling.editableValues)
  check(checks, '保存期间零失焦采样', sampling.lostFocusSamples === 0, sampling.lostFocusSamples)
  check(checks, '保存后仍聚焦且可盲打续写', afterSave.focused === true && typed.includes('盲打续写'), { afterSave, typed })
  check(checks, '两次保存都落库', saved.writes.filter((w) => w.method === 'PATCH' && w.result === 200).length === 2
    && (saved.journal?.text ?? '').includes('盲打续写'), saved)
  return { checks, caret, sampling, afterSave, typed, saved }
}

/* I12 Writing 自动保存 + 立即保存 */
scenarios['I12 Writing 保存与立即保存'] = async () => {
  const checks = []
  await openModule('写作')
  await markEditor('D')
  await focusEnd()
  await startSampler(20)
  const t0 = Date.now()
  await typeText('I12 首段。')
  await sleep(3000)
  const sampling = await stopSampler()
  await typeText('续写')
  const typedAfter = await editorText()
  await markEditor('D2')
  await startSampler(20)
  const t1 = Date.now()
  await realClickText('立即保存')
  await sleep(2200)
  const sampling2 = await stopSampler()
  const after = { mark: await editorMark(), editable: await editableAttr(), writes: await writesSince(t1), journal: await journalOf('writing') }

  check(checks, '自动保存期间无重建、零失焦',
    sampling.rebuilt === false && sampling.marks.join(',') === 'D' && sampling.lostFocusSamples === 0, sampling)
  check(checks, '保存后可继续输入', typedAfter.includes('续写'), typedAfter)
  check(checks, '立即保存不重建编辑器', sampling2.rebuilt === false && after.mark === 'D2', { sampling2, mark: after.mark })
  check(checks, '内容落库', (after.journal?.text ?? '').includes('续写'), after.journal)
  return { checks, sampling, typedAfter, sampling2, after }
}

/* I13 Writing 组合（回归对照） */
scenarios['I13 Writing 组合对照'] = async () => {
  const checks = []
  await openModule('写作')
  await focusEnd()
  await typeText('I13 已保存句。')
  await sleep(3000)
  await markEditor('E')
  await focusEnd()
  const t0 = Date.now()
  await session.imeSet('nihao')
  await sleep(1600)
  const during = { writes: await writesSince(t0), mark: await editorMark(), focused: await focused(), editable: await editableAttr() }
  await session.imeCommit('你好')
  await sleep(3000)
  const after = { writes: await writesSince(t0), journal: await journalOf('writing'), mark: await editorMark() }
  check(checks, '组合期零请求', during.writes.length === 0, during.writes)
  check(checks, '组合期不重建不丢焦点', during.mark === 'E' && during.focused === true, during)
  check(checks, '上屏后正确保存',
    after.journal?.text === 'I13 已保存句。你好' && after.writes.length === 1, after)
  return { checks, during, after }
}

/* I14 在途继续输入：不丢字、不 409、版本正确 */
scenarios['I14 在途继续输入'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I14 第一段。'))
  await openModule('开始今天')
  await setFault({ patchDelayMs: 3000 })
  await markEditor('F')
  await focusEnd()
  const t0 = Date.now()
  await typeText('在途一。')
  await sleep(1200)
  const inFlightWrites = await writesSince(t0)
  await typeText('在途二。')
  await sleep(300)
  const during = { editor: await editorText(), editable: await editableAttr(), focused: await focused(), mark: await editorMark() }
  await sleep(3200)
  const midStatus = { status: await textOf('.ritual-status'), journal: await journalOf('set') }
  await sleep(5000)
  const after = { journal: await journalOf('set'), writes: await writesSince(t0), editor: await editorText() }
  await setFault({ patchDelayMs: 0 })
  await openModule('开始今天')
  const reopened = { editor: await editorText(), journal: await journalOf('set') }

  check(checks, '第一次保存确实在途', inFlightWrites.length === 1, inFlightWrites)
  check(checks, '在途期间可继续输入且落在末尾',
    during.editor.includes('在途二') && during.editable === 'true' && during.editor.indexOf('在途二') > during.editor.indexOf('在途一'), during)
  check(checks, '在途期间节点未替换且保持焦点', during.mark === 'F' && during.focused === true, during)
  check(checks, '在途响应未把草稿标记为已保存', /未提交|正在保存|还有改动/.test(midStatus.status), midStatus)
  check(checks, '无 409 且第二次请求版本正确',
    after.writes.filter((w) => w.result === 409).length === 0
    && after.writes.filter((w) => w.method === 'PATCH').map((w) => w.expectedRevision).join(',') === '1,2', after.writes)
  check(checks, '两段输入都落库且无重复',
    after.journal?.text === 'I14 第一段。在途一。在途二。' && after.journal?.revision === 3, after.journal)
  check(checks, '刷新后一致', reopened.editor === after.journal?.text, reopened)
  return { checks, during, midStatus, after, reopened }
}

/* I15 在途时开始组合 */
scenarios['I15 在途时开始组合'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I15 已保存句。'))
  await openModule('开始今天')
  await setFault({ patchDelayMs: 3000 })
  await focusEnd()
  const t0 = Date.now()
  await typeText('先保存。')
  await sleep(1300)
  await session.imeSet('nihao')
  await sleep(1600)
  const duringComposition = { writes: await writesSince(t0), journal: await journalOf('set') }
  await sleep(1600)
  const afterSettle = { status: await textOf('.ritual-status'), journal: await journalOf('set'), editor: await editorText() }
  await session.imeCommit('你好')
  await sleep(5200)
  const after = { journal: await journalOf('set'), writes: await writesSince(t0) }
  await setFault({ patchDelayMs: 0 })
  await openModule('开始今天')
  const reopened = { editor: await editorText() }

  check(checks, '组合期没有新的写请求', duringComposition.writes.length === 1, duringComposition.writes)
  check(checks, '在途响应落地时未把拼音写进服务器', !(afterSettle.journal?.text ?? '').includes('nihao'), afterSettle.journal?.text)
  check(checks, 'settle 后草稿仍未标记已保存', /未提交|还有改动/.test(afterSettle.status), afterSettle.status)
  check(checks, '任何请求正文都不含未确认拼音', after.writes.every((w) => !(w.text ?? '').includes('nihao')), after.writes)
  check(checks, '上屏后最终文本正确',
    after.journal?.text === 'I15 已保存句。先保存。你好' && reopened.editor === after.journal?.text, after)
  return { checks, duringComposition, afterSettle, after, reopened }
}

/* I16 目标命令（勾选）与脏草稿并发 */
scenarios['I16 目标勾选与脏草稿并发'] = async () => {
  const checks = []
  await seedDoc('set', docPara(''))
  await openModule('开始今天')
  await session.clickText('☑ 清单')
  await sleep(300)
  await focusEnd()
  await typeText('写周报')
  await sleep(3400)
  const created = await journalOf('set')
  await focusEnd()
  await pressEnter()
  await typeText('补充说明')
  await setFault({ goalPatchDelayMs: 3000 })
  await session.eval(`(() => {
    window.__curve = []
    clearInterval(window.__curveTimer)
    window.__curveTimer = setInterval(() => {
      const el = document.querySelector('${ED}')
      window.__curve.push({ editable: el?.getAttribute('contenteditable') ?? null, active: document.activeElement === el })
    }, 100)
    return true
  })()`)
  const t0 = Date.now()
  await realClickSelector('.ritual-goals input[type="checkbox"]')
  await sleep(1200)
  const curve = await session.eval(`(() => { clearInterval(window.__curveTimer); return window.__curve })()`)
  await sleep(4500)
  const after = { journal: await journalOf('set'), writes: await writesSince(t0), editor: await editorText() }
  await setFault({ goalPatchDelayMs: 0 })
  await openModule('开始今天')
  const reopened = { journal: await journalOf('set'), panel: await textOf('.ritual-goals') }

  const editableDuring = [...new Set((curve ?? []).map((c) => c.editable))]
  const journalWriteIdx = after.writes.findIndex((w) => w.path.startsWith('/api/journals/'))
  const goalWriteIdx = after.writes.findIndex((w) => w.path.startsWith('/api/ritual-goals'))
  check(checks, '命令前先落库脏草稿', (after.journal?.text ?? '').includes('补充说明'), after.journal?.text)
  check(checks, '命令期间编辑器被锁（contenteditable=false）', editableDuring.includes('false'), editableDuring)
  check(checks, '保存先于目标命令', journalWriteIdx >= 0 && goalWriteIdx > journalWriteIdx, after.writes)
  check(checks, '目标命令实际发出', goalWriteIdx >= 0, after.writes)
  check(checks, '勾选状态已提交', (after.journal?.goals ?? [])[0]?.checked === true, after.journal?.goals)
  check(checks, '目标仍是 1 个（无重复）', (after.journal?.goals ?? []).length === 1, after.journal?.goals)
  check(checks, '刷新后文本与勾选一致',
    (reopened.journal?.text ?? '').includes('补充说明') && (reopened.journal?.goals ?? [])[0]?.checked === true, reopened)
  return { checks, created, curve: editableDuring, after, reopened }
}

/* I17 模板保存 */
scenarios['I17 模板保存期间锁定'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I17 正文。'))
  await openModule('开始今天')
  await focusEnd()
  await typeText('已保存追加。')
  await sleep(2600)
  await markEditor('H')
  const t0 = Date.now()
  await realClickSelector('.ritual-questions-input')
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 })
  await typeText('今天最重要的一件事是什么？（改）')
  let templateDirty = false
  for (let attempt = 0; attempt < 3 && !templateDirty; attempt += 1) {
    for (let i = 0; i < 10; i += 1) {
      templateDirty = await session.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存模板')`)
      if (templateDirty) break
      await sleep(200)
    }
    if (!templateDirty) {
      await realClickSelector('.ritual-questions-input')
      await typeText('改')
    }
  }
  await setFault({ templateDelayMs: 1500 })
  await session.clickText('保存模板')
  await sleep(500)
  const during = { editable: await editableAttr(), mark: await editorMark() }
  await sleep(1800)
  const after = { editable: await editableAttr(), mark: await editorMark(), journal: await journalOf('set'), notice: await textOf('.ritual-notice'), writes: await writesSince(t0) }
  await setFault({ templateDelayMs: 0 })
  await openModule('开始今天')
  const reopened = {
    editor: await editorText(),
    journal: await journalOf('set'),
    template: await session.eval(`document.querySelector('.ritual-questions-input')?.value ?? ''`),
  }

  check(checks, '模板修改后出现保存按钮', templateDirty === true, templateDirty)
  check(checks, '模板保存期间编辑器锁定', during.editable === 'false', during.editable)
  check(checks, '锁定期节点未替换', during.mark === 'H' && after.mark === 'H', { during, after })
  check(checks, '解锁后恢复可编辑', after.editable === 'true', after.editable)
  check(checks, '正文未丢失', (after.journal?.text ?? '').includes('已保存追加'), after.journal?.text)
  check(checks, '模板已更新', reopened.template.includes('（改）'), reopened.template)
  check(checks, '模板保存未触发正文写请求', after.writes.every((w) => !w.path.startsWith('/api/journals')), after.writes)
  return { checks, during, after, reopened }
}

/* I18 组合中真实切页 */
scenarios['I18 组合中真实切页'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I18 已保存句。'))
  await openModule('开始今天')
  await focusEnd()
  await session.clearQaEvents()
  const t0 = Date.now()
  await session.imeSet('qiehuan')
  await sleep(400)
  const before = {
    editor: await editorText(), focused: await focused(),
    navDisabled: await session.eval(`(() => { const b = [...document.querySelectorAll('nav button')].find((x) => x.textContent.trim() === '概览'); return b ? b.disabled : null })()`),
  }
  await realClickText('概览')
  await sleep(2200)
  const afterNav = {
    leftPage: await session.eval(`document.querySelector('.ritual-page') === null`),
    dialog: await session.eval(`(() => { const d = document.querySelector('dialog'); return d ? { open: d.open, title: d.querySelector('h2')?.textContent ?? '' } : null })()`),
    events: (await eventsSince(t0)).map((e) => `${e.dt}ms ${e.type}${e.data ? `:"${e.data}"` : ''}`),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  await shot('set-nav-during-composition')
  await realClickText('开始今天')
  await session.waitFor(`document.querySelector('${ED}') !== null`, 12000)
  await sleep(1200)
  const back = { editor: await editorText() }
  await focusEnd()
  await typeText('回来后。')
  await sleep(3000)
  const resumed = { writes: await writesSince(t0), journal: await journalOf('set'), editor: await editorText() }

  check(checks, '切页真实顺序为 blur→compositionend→click', afterNav.events.some((e) => e.includes('compositionend')), afterNav.events.slice(0, 8))
  check(checks, '未出现「未保存」拦停对话框', afterNav.dialog === null || afterNav.dialog.open === false, afterNav.dialog)
  check(checks, '已离开页面', afterNav.leftPage === true, afterNav.leftPage)
  check(checks, '预编辑串由浏览器在失焦时提交（可观测，非应用打断）', (afterNav.journal?.text ?? '').includes('qiehuan'), afterNav.journal?.text)
  check(checks, '回切后组合标记已清、可继续保存',
    resumed.writes.some((w) => w.method === 'PATCH' && w.result === 200) && (resumed.journal?.text ?? '').includes('回来后'), resumed)
  return { checks, before, afterNav, back, resumed }
}

/* I19 Insight 回归 */
scenarios['I19 Insight 编辑器回归'] = async () => {
  const checks = []
  await session.goto(BASE + '/')
  await session.clickText('洞察')
  await sleep(2200)
  const page = {
    root: await has('.insight-page'),
    editors: await session.eval(`document.querySelectorAll('${ED}').length`),
    text: (await textOf('.insight-page')).slice(0, 160),
  }
  let typing = null
  if (page.editors > 0) {
    await focusEnd()
    await typeText('Insight 输入检查。')
    typing = { editor: await editorText(), editable: await editableAttr() }
  }
  check(checks, '洞察页可打开', page.root === true, page)
  check(checks, '编辑入口存在且可输入', page.editors > 0 && typing?.editable === 'true' && (typing?.editor ?? '').includes('Insight 输入检查'), { page, typing })
  return { checks, page, typing }
}

/* I20 对照视图右侧编辑器：保存期间是否被锁 / 丢焦点 */
scenarios['I20 对照视图右侧编辑器'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I20 当前版本。'))
  await seedDoc('set', docPara('I20 旧版本。'), null, true)
  await openModule('开始今天')
  const section = await has('.ritual-restore')
  await session.clickText('打开对照')
  await session.waitFor(`document.querySelector('.ritual-editor--compare') !== null`, 12000)
  await sleep(700)
  const scope = '.ritual-editor--compare .s4-editor-content'
  const opened = {
    editors: await session.eval(`document.querySelectorAll('.s4-editor-content').length`),
    rightText: await session.eval(`document.querySelector('${scope}')?.innerText ?? ''`),
  }
  await session.eval(`(() => {
    const el = document.querySelector('${scope}')
    el.dataset.qaMark = 'CMP'
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    return true
  })()`)
  await sleep(100)
  await session.eval(`(() => {
    window.__cmp = []
    clearInterval(window.__cmpTimer)
    window.__cmpTimer = setInterval(() => {
      const el = document.querySelector('${scope}')
      window.__cmp.push({
        mark: el?.dataset.qaMark ?? null,
        editable: el?.getAttribute('contenteditable') ?? null,
        active: document.activeElement === el,
      })
    }, 25)
    return true
  })()`)
  await setFault({ patchDelayMs: 2500 })
  const t0 = Date.now()
  await typeText('对照追加。')
  await sleep(5200)
  await setFault({ patchDelayMs: 0 })
  const samples = await session.eval(`(() => { clearInterval(window.__cmpTimer); return window.__cmp || [] })()`)
  const after = { journal: await journalOf('set'), writes: await writesSince(t0) }
  const marks = [...new Set(samples.map((x) => x.mark))]
  check(checks, '对照入口可用且右侧可编辑', section && opened.editors === 2, opened)
  check(checks, '对照中的输入已落库', (after.journal?.text ?? '').includes('对照追加'), after.journal?.text)
  check(checks, '对照右侧编辑器未被重建', marks.length === 1 && marks[0] === 'CMP', marks)
  check(checks, '【残留】保存期间对照右侧是否被锁定/丢焦点',
    [...new Set(samples.map((x) => x.editable))].join(',') === 'true' && samples.every((x) => x.active),
    { editable: [...new Set(samples.map((x) => x.editable))], lostFocus: samples.filter((x) => !x.active).length, count: samples.length })
  return { checks, opened, after, marks, editableValues: [...new Set(samples.map((x) => x.editable))], lostFocusSamples: samples.filter((x) => !x.active).length }
}

/* I21 组合中程序化离开（不失焦）：拦停提示 + 卸载后标记清理 */
scenarios['I21 组合中程序化切页'] = async () => {
  const checks = []
  await seedDoc('set', docPara('I21 已保存句。'))
  await openModule('开始今天')
  await focusEnd()
  const t0 = Date.now()
  await session.imeSet('chengxu')
  await sleep(400)
  await session.eval(`(() => { const b = [...document.querySelectorAll('nav button')].find((x) => x.textContent.trim() === '概览'); b.click(); return true })()`)
  await sleep(1500)
  const mid = {
    dialog: await session.eval(`(() => { const d = document.querySelector('dialog'); return d ? { open: d.open, title: d.querySelector('h2')?.textContent ?? '' } : null })()`),
    writes: await writesSince(t0),
    journal: await journalOf('set'),
  }
  if (mid.dialog?.open === true) await session.clickText('确认离开')
  await sleep(1600)
  const left = { leftPage: await session.eval(`document.querySelector('.ritual-page') === null`), writes: await writesSince(t0) }
  await session.clickText('开始今天')
  await session.waitFor(`document.querySelector('${ED}') !== null`, 12000)
  await sleep(1200)
  await focusEnd()
  await typeText('回切。')
  await sleep(3000)
  const resumed = { journal: await journalOf('set'), writes: await writesSince(t0), editor: await editorText() }

  check(checks, '组合中离开会先拦停并说明', mid.dialog?.open === true && /还没保存|没有保存|未保存/.test(mid.dialog?.title ?? ''), mid.dialog)
  check(checks, '【残留】拦停弹窗打开后仍发生保存（弹窗抢焦点导致预编辑被提交）',
    mid.writes.length === 0, mid.writes)
  check(checks, '确认后可以离开', left.leftPage === true, left)
  check(checks, '回切后组合标记已清、可继续保存',
    resumed.writes.some((w) => w.method === 'PATCH' && w.result === 200) && (resumed.journal?.text ?? '').includes('回切'), resumed)
  check(checks, '【残留】未确认拼音最终未被写入正文', !(resumed.journal?.text ?? '').includes('chengxu'), resumed.journal?.text)
  return { checks, mid, left, resumed }
}

/* ------------------------------------------------------------ 执行框架 */
async function main() {
  const { child, wsUrl } = await launch({ port: 9262 })
  session = await openSession(wsUrl)
  try {
    await session.installRecorder()
    const only = (process.env.ONLY ?? '').split(',').filter((v) => v !== '')
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only.length > 0 && !only.some((key) => name.startsWith(key))) continue
      await reset()
      try {
        const data = await fn()
        const failed = data.checks.filter((c) => c.ok === false)
        results.push({ scenario: name, ...data })
        console.log(`\n### ${name}  通过 ${data.checks.length - failed.length}/${data.checks.length}`)
        failed.forEach((c) => console.log(`   FAIL ${c.name} :: ${JSON.stringify(c.detail).slice(0, 240)}`))
      } catch (error) {
        results.push({ scenario: name, error: String((error && error.stack) || error) })
        console.log(`\n### ${name} ERROR: ${error}`)
        await shot('failure').catch(() => {})
      }
    }
    const exceptions = session.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 200))
    results.push({ scenario: '会话汇总', exceptions })
    console.log(`\n控制台异常：${exceptions.length}`)
  } finally {
    await session.close()
    child.kill()
  }
  await writeFile(join(OUT, 'verify-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  const total = results.reduce((n, r) => n + (r.checks?.length ?? 0), 0)
  const passed = results.reduce((n, r) => n + (r.checks?.filter((c) => c.ok).length ?? 0), 0)
  console.log(`\n独立复测完成：断言 ${passed}/${total} 通过`)
}

main().catch((error) => { console.error(error); process.exit(1) })
