/**
 * 清单（Checklist）行为验证 · 第二轮 UI。
 *
 * 真实构建产物 + 真实 Tiptap 输入规则 + CDP 合成数据。
 * 覆盖：`- [ ] ` / `[ ] ` / `1. [ ] ` / `[x] `、回车、勾选、撤销、
 * 普通列表不被批量改写、粘贴不转换、已有字面文本不被改写、IME（模拟）。
 */
import { connect, resetLog, writeRequests, sleep } from './lib/cdp.mjs'
import { world, write, journal } from './lib/mock-api.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round2/checklist'
mkdirSync(`${OUT}/shots`, { recursive: true })

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)

const structure = () => `(() => {
  const root = document.querySelector('.ProseMirror')
  if (root === null) return null
  const top = [...root.children].map((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute('data-type'),
    items: [...node.children].map((item) => item.getAttribute('data-type')),
    text: (node.textContent ?? '').replace(/Task item checkbox for /g, '').slice(0, 80),
    checked: [...node.querySelectorAll('input[type=checkbox]')].map((box) => box.checked),
  }))
  return {
    top,
    taskLists: root.querySelectorAll('ul[data-type=taskList]').length,
    taskItems: root.querySelectorAll('ul[data-type=taskList] > li').length,
    bulletLists: [...root.querySelectorAll('ul')].filter((ul) => ul.getAttribute('data-type') !== 'taskList').length,
    orderedLists: root.querySelectorAll('ol').length,
    checkboxes: root.querySelectorAll('input[type=checkbox]').length,
  }
})()`

/** 最后一次写请求里的 content_doc：这是「保存/刷新后」看到的真实形状。 */
function savedDocument() {
  const writes = writeRequests()
  for (let i = writes.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(writes[i].body ?? '{}')
      const doc = parsed?.draft?.content_doc ?? parsed?.content_doc ?? null
      if (doc !== null) return doc
    } catch { /* 忽略非 JSON */ }
  }
  return null
}

function flatTypes(document) {
  const out = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type) out.push(node.type + (node.type === 'text' ? `(${node.text})` : ''))
    for (const child of node.content ?? []) walk(child)
  }
  walk(document)
  return out
}

const results = {}

async function openWriting(seed = []) {
  world.writing = seed
  world.set = null
  world.end = null
  write.mode = 'ok'
  resetLog()
  await cdp.clearLocalDrafts(new URL(APP).origin)
  await cdp.send('Page.navigate', { url: APP })
  await cdp.waitFor(`document.querySelector('.dash-hero') !== null`)
  await sleep(350)
  await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
  await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
  await sleep(400)
  await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
  await sleep(120)
}

async function openTodayList() {
  // 第二轮把「今天」列表收进了按需抽屉：先点顶栏的「今天 N 篇」再点条目。
  const ok = await cdp.evaluate(`(() => {
    const node = [...document.querySelectorAll('.sj-write__ghost')]
      .find((item) => (item.textContent ?? '').includes('今天'))
    if (node === undefined) return false
    node.click()
    return true
  })()`)
  await sleep(450)
  return ok
}

async function record(name, extra = {}) {
  await sleep(200)
  const dom = await cdp.evaluate(structure())
  results[name] = { dom, saved: savedDocument(), ...extra }
  return results[name]
}

/* ---------------------------------------------- S1 `- [ ] ` */
await openWriting()
await cdp.type('- [ ] 买牛奶')
await sleep(1400)
await record('S1-bullet-marker')
await cdp.shot(`${OUT}/shots`, '01-checkbox-from-dash.png')

/* ---------------------------------------------- S2 段落直接 `[ ] ` */
await openWriting()
await cdp.type('[ ] 独立清单')
await sleep(1400)
await record('S2-plain-marker')

/* ---------------------------------------------- S3 有序列表 `1. [ ] ` */
await openWriting()
await cdp.type('1. [ ] 有序清单')
await sleep(1400)
await record('S3-ordered-marker')

/* ---------------------------------------------- S4 `- [x] ` */
await openWriting()
await cdp.type('- [x] 已完成')
await sleep(1400)
await record('S4-checked-marker')
await cdp.shot(`${OUT}/shots`, '02-checked-item.png')

/* ---------------------------------------------- S5 回车继续 */
await openWriting()
await cdp.type('- [ ] 第一件')
await cdp.press('Enter')
await cdp.type('第二件')
await sleep(1400)
await record('S5-enter-splits')
await cdp.shot(`${OUT}/shots`, '03-enter-second-item.png')

/* ---------------------------------------------- S6 勾选 / 取消 / 撤销 / 重做 */
await openWriting()
await cdp.type('- [ ] 待勾选')
await sleep(1200)
const beforeToggle = await cdp.evaluate(`[...document.querySelectorAll('.ProseMirror input[type=checkbox]')].map((b) => b.checked)`)
await cdp.evaluate(`document.querySelector('.ProseMirror input[type=checkbox]').click()`)
await sleep(500)
const afterCheck = await cdp.evaluate(`[...document.querySelectorAll('.ProseMirror input[type=checkbox]')].map((b) => b.checked)`)
await cdp.evaluate(`document.querySelector('.ProseMirror input[type=checkbox]').click()`)
await sleep(400)
const afterUncheck = await cdp.evaluate(`[...document.querySelectorAll('.ProseMirror input[type=checkbox]')].map((b) => b.checked)`)
await cdp.evaluate(`document.querySelector('.ProseMirror input[type=checkbox]').click()`)
await sleep(300)
for (let i = 0; i < 2; i += 1) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await sleep(250)
}
const afterUndo = await cdp.evaluate(`[...document.querySelectorAll('.ProseMirror input[type=checkbox]')].map((b) => b.checked)`)
for (let i = 0; i < 2; i += 1) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'y', code: 'KeyY', modifiers: 2, windowsVirtualKeyCode: 89 })
  await sleep(250)
}
const afterRedo = await cdp.evaluate(`[...document.querySelectorAll('.ProseMirror input[type=checkbox]')].map((b) => b.checked)`)
await sleep(1200)
await record('S6-toggle-undo-redo', { beforeToggle, afterCheck, afterUncheck, afterUndo, afterRedo })
await cdp.shot(`${OUT}/shots`, '04-toggle.png')

/* ---------------------------------------------- S7 普通列表不被批量改写 */
await openWriting()
await cdp.type('- 第一项')
await cdp.press('Enter')
await cdp.type('第二项')
await cdp.press('Enter')
await cdp.type('[ ] 第三项')
await sleep(1500)
await record('S7-bullets-preserved')
await cdp.shot(`${OUT}/shots`, '05-bullets-preserved.png')

/* ---------------------------------------------- S8 粘贴不触发转换 */
await openWriting()
await cdp.evaluate(`(() => {
  const dom = document.querySelector('.ProseMirror')
  const data = new DataTransfer()
  data.setData('text/plain', '- [ ] 粘贴进来的内容')
  dom.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  return true
})()`)
await sleep(1500)
await record('S8-paste-not-converted')

/* ---------------------------------------------- S9 已有字面文本不被改写 */
await openWriting([{
  ...journal(601, 'writing', '既有字面清单', '- [ ] 老数据里的字面文本', '2026-11-02', 2),
  content_doc: {
    type: 'doc',
    content: [{
      type: 'paragraph',
      attrs: { id: '33333333-3333-4333-8333-333333333333' },
      content: [{ type: 'text', text: '- [ ] 老数据里的字面文本' }],
    }],
  },
}])
await openTodayList()
await cdp.evaluate(`(() => {
  const node = [...document.querySelectorAll('.writing-item, .sj-write__item')]
    .find((item) => (item.textContent ?? '').includes('既有字面清单'))
  if (node === undefined) return false
  node.click()
  return true
})()`)
await sleep(1200)
await record('S9-literal-preserved')

/* ---------------------------------------------- S10 IME（CDP 模拟，非真实输入法） */
await openWriting()
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.send('Input.imeSetComposition', { text: 'pinyin', selectionStart: 6, selectionEnd: 6 })
await sleep(900)
const duringComposition = {
  writes: writeRequests().length,
  text: await cdp.evaluate(`document.querySelector('.ProseMirror').textContent`),
}
await cdp.send('Input.insertText', { text: '中文' })
await sleep(1500)
const afterCommit = {
  writes: writeRequests().length,
  text: await cdp.evaluate(`document.querySelector('.ProseMirror').textContent`),
  saved: savedDocument(),
}
results['S10-ime-simulated'] = { duringComposition, afterCommit, note: 'CDP imeSetComposition 模拟，非真实 Windows 输入法' }

/* ---------------------------------------------- S11 保存后刷新（重新加载页面） */
await openWriting([{
  ...journal(602, 'writing', '已保存的清单', '- [x] 已完成的项', '2026-11-02', 4),
  content_doc: {
    type: 'doc',
    content: [{
      type: 'taskList',
      attrs: { id: '44444444-4444-4444-8444-444444444444' },
      content: [{
        type: 'taskItem',
        attrs: { id: '55555555-5555-4555-8555-555555555555', checked: true },
        content: [{
          type: 'paragraph',
          attrs: { id: '66666666-6666-4666-8666-666666666666' },
          content: [{ type: 'text', text: '已完成的项' }],
        }],
      }],
    }],
  },
}])
await openTodayList()
await cdp.evaluate(`(() => {
  const node = [...document.querySelectorAll('.writing-item, .sj-write__item')]
    .find((item) => (item.textContent ?? '').includes('已保存的清单'))
  if (node === undefined) return false
  node.click()
  return true
})()`)
await sleep(1200)
await record('S11-reload-persist')
await cdp.shot(`${OUT}/shots`, '06-reload-persist.png')

/* ---------------------------------------------- 汇总 */
const summary = {}
for (const [name, value] of Object.entries(results)) {
  if (value.dom !== undefined) {
    summary[name] = {
      taskLists: value.dom?.taskLists,
      taskItems: value.dom?.taskItems,
      bulletLists: value.dom?.bulletLists,
      orderedLists: value.dom?.orderedLists,
      checkboxes: value.dom?.checkboxes,
      checked: value.dom?.top?.flatMap((item) => item.checked ?? []),
      text: value.dom?.top?.map((item) => item.text),
      savedTypes: value.saved === null ? null : flatTypes(value.saved),
    }
  } else {
    summary[name] = value
  }
}

writeFileSync(`${OUT}/checklist-report.json`, JSON.stringify({ app: APP, summary, raw: results, consoleErrors: cdp.consoleErrors }, null, 2))
console.log(JSON.stringify(summary, null, 2))
console.log('CONSOLE', JSON.stringify(cdp.consoleErrors.slice(0, 8)))
cdp.close()
