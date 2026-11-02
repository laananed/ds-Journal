/**
 * 复现：正文里输入 `- [ ] ` 后出现「普通圆点 + 字面 [ ]」。
 *
 * 真实构建产物 + 真实 Tiptap 输入规则；不预设根因，只记录事实：
 * 逐个按键发送真实 keyDown，观察编辑器 DOM 结构与随后的保存载荷。
 */
import { connect, resetLog, writeRequests, sleep } from './lib/cdp.mjs'
import { world, write } from './lib/mock-api.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round2/repro'
mkdirSync(OUT, { recursive: true })
const SHOTS = `${OUT}/shots`

const dom = () => `(() => {
  const root = document.querySelector('.ProseMirror')
  if (root === null) return null
  const top = [...root.children].map((node) => ({
    tag: node.tagName.toLowerCase(),
    type: node.getAttribute('data-type'),
    className: node.className,
    hasCheckbox: node.querySelector('input[type=checkbox]') !== null,
    text: (node.textContent ?? '').slice(0, 120),
  }))
  return {
    top,
    taskLists: root.querySelectorAll('ul[data-type=taskList]').length,
    taskItems: root.querySelectorAll('li[data-type=taskItem]').length,
    checkboxes: root.querySelectorAll('input[type=checkbox]').length,
    bulletLists: [...root.querySelectorAll('ul')].filter((ul) => ul.getAttribute('data-type') !== 'taskList').length,
    html: root.innerHTML.slice(0, 1200),
  }
})()`

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)
await cdp.clearLocalDrafts(new URL(APP).origin)
world.writing = []
world.set = null
world.end = null
write.mode = 'ok'
resetLog()

await cdp.send('Page.navigate', { url: APP })
await cdp.waitFor(`document.querySelector('.dash-hero') !== null`)
await sleep(400)
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(500)

await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await sleep(150)

const steps = []
async function record(label) {
  steps.push({ label, ...(await cdp.evaluate(dom())) })
}

await cdp.type('-')
await cdp.type(' ')
await record('输入 "- " 之后')
await cdp.shot(SHOTS, '02-after-bullet-marker.png')

await cdp.type('[')
await cdp.type(' ')
await record('输入 "[ " 之后')
await cdp.type(']')
await cdp.type(' ')
await record('输入 "- [ ] " 之后')
await cdp.shot(SHOTS, '03-after-task-marker.png')

await cdp.type('买牛奶')
await sleep(1500)
await record('输入正文并等待自动保存之后')
await cdp.shot(SHOTS, '04-after-text.png')

const posts = writeRequests().map((item) => ({
  method: item.method,
  path: item.path,
  rawKeys: (() => {
    try { return Object.keys(JSON.parse(item.body ?? '{}')) } catch { return [] }
  })(),
  contentDoc: (() => {
    try {
      const parsed = JSON.parse(item.body ?? '{}')
      return parsed?.draft?.content_doc ?? parsed?.content_doc ?? null
    } catch { return null }
  })(),
}))

const report = {
  app: APP,
  builtFrom: process.env.BUILD_LABEL ?? 'current wb/ui-2 build',
  steps,
  writes: posts.map((item) => ({ method: item.method, path: item.path })),
  savedDocument: posts.at(-1)?.contentDoc ?? null,
  consoleErrors: cdp.consoleErrors,
}
writeFileSync(`${OUT}/repro-checklist.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify({
  steps: steps.map((s) => ({
    label: s.label,
    taskLists: s.taskLists, taskItems: s.taskItems, checkboxes: s.checkboxes, bulletLists: s.bulletLists,
    top: s.top.map((n) => `${n.tag}${n.type ? `[${n.type}]` : ''}:${n.text}`),
  })),
  writes: report.writes,
  saved: report.savedDocument === null ? null : JSON.stringify(report.savedDocument).slice(0, 600),
  consoleErrors: cdp.consoleErrors.slice(0, 5),
}, null, 2))

cdp.close()
