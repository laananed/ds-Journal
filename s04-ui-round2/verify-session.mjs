/**
 * 第二轮 UI · 会话与保存行为验证（合成数据、CDP 拦截，不连后端/数据库）。
 *
 * S1 空白速记不拦截导航、也不留本地草稿
 * S2 断网时保存失败可见（状态行 + 重试入口）
 * S3 保存中继续输入：释放后最终提交包含最后一次输入
 * S4 未提交内容刷新后仍能从「本地草稿」入口找到
 * S5 勾选清单后保存载荷是 taskList/taskItem（清单落库形态）
 */
import { connect, resetLog, writeRequests, sleep } from './lib/cdp.mjs'
import { world, write } from './lib/mock-api.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round2/shots'
mkdirSync(OUT, { recursive: true })

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)
const origin = new URL(APP).origin

const status = () => `(() => {
  const node = document.querySelector('.sj-write__status')
  return node === null ? null : node.textContent.replace(/\\s+/g, ' ').trim()
})()`

const draftsCount = () => `(() => {
  const button = [...document.querySelectorAll('.sj-write__ghost')]
    .find((item) => (item.textContent ?? '').includes('本地草稿'))
  return button === undefined ? null : button.textContent.trim()
})()`

async function gotoWriting(seed = []) {
  world.writing = seed
  world.set = null
  world.end = null
  write.mode = 'ok'
  resetLog()
  await cdp.clearLocalDrafts(origin)
  await cdp.send('Page.navigate', { url: APP })
  await cdp.waitFor(`document.querySelector('.sj-nav') !== null`)
  await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button, .sj-shortcuts a', '速记')
  await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
  await sleep(600)
}

const report = {}

/* ---------------------------------------------------- S1 空白速记不拦截 */
await gotoWriting()
report['S1-status-empty'] = await cdp.evaluate(status())
report['S1-drafts-empty'] = await cdp.evaluate(draftsCount())
await cdp.clickByLabel('.sj-nav button', '概览')
await sleep(700)
report['S1-navigated'] = await cdp.evaluate(`document.querySelector('.dash-hero') !== null`)
report['S1-writes'] = writeRequests().length
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button, .sj-shortcuts a', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(700)
report['S1-drafts-after-return'] = await cdp.evaluate(draftsCount())
report['S1-writes-after-return'] = writeRequests().length

/* ------------------------------------------- S2 断网：保存失败要能看见 */
await gotoWriting()
write.mode = 'abort'
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('断网时写的一句。')
await sleep(1800)
report['S2-status-offline'] = await cdp.evaluate(status())
report['S2-critical'] = await cdp.evaluate(`document.querySelector('.sj-write__status')?.classList.contains('is-critical') ?? null`)
await cdp.shot(OUT, '12-writing-offline.png')

/* -------------------------------------------- S3 恢复网络后重试能保存 */
write.mode = 'ok'
await cdp.evaluate(`(() => {
  const button = [...document.querySelectorAll('.sj-write__status button')].find((item) => item.textContent.includes('重试'))
  if (button === undefined) return false
  button.click()
  return true
})()`)
await sleep(1500)
report['S3-status-retried'] = await cdp.evaluate(status())
report['S3-writes'] = writeRequests().map((item) => `${item.method} ${item.path}`)

/* ------------------------------ S4 保存中继续输入：最终提交含最后输入 */
await gotoWriting()
write.mode = 'hold'
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('第一段。')
await sleep(1400)
report['S4-held'] = writeRequests().length
await cdp.type('第二段。')
await sleep(1200)
report['S4-held-while-typing'] = writeRequests().length
write.mode = 'ok'
const released = await cdp.releaseHeld(true)
await sleep(1600)
report['S4-released'] = released
report['S4-writes'] = writeRequests().map((item) => `${item.method} ${item.path}`)
report['S4-last-body-has-both'] = (() => {
  const writes = writeRequests()
  const last = writes[writes.length - 1]
  if (last === undefined || last.body === null) return null
  return last.body.includes('第一段') && last.body.includes('第二段')
})()
report['S4-status'] = await cdp.evaluate(status())

/* -------------------------------- S5 未提交内容刷新后仍能被找到（S4 已保存，改用断网制造未提交） */
write.mode = 'abort'
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('刷新前未提交的一句。')
await sleep(1600)
report['S5-status-before-reload'] = await cdp.evaluate(status())
await cdp.send('Page.navigate', { url: APP })
await cdp.waitFor(`document.querySelector('.sj-nav') !== null`)
write.mode = 'ok'
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button, .sj-shortcuts a', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(1200)
report['S5-drafts-after-reload'] = await cdp.evaluate(draftsCount())
report['S5-callout-visible'] = await cdp.evaluate(`document.querySelector('.writing-recovery-callout') !== null`)
await cdp.shot(OUT, '13-writing-after-reload.png')

/* ------------------------------------- S6 勾选清单后的保存载荷形态 */
await gotoWriting()
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('- [ ] 买牛奶')
await cdp.press('Enter')
await cdp.type('第二项')
await sleep(1600)
const writeBody = (() => {
  const writes = writeRequests()
  const last = writes[writes.length - 1]
  return last === undefined ? null : last.body
})()
report['S6-payload-types'] = writeBody === null ? null : (() => {
  try {
    let parsed = JSON.parse(writeBody)
    if (typeof parsed?.draft === 'string') parsed = { ...parsed, draft: JSON.parse(parsed.draft) }
    const doc = parsed?.draft?.content_doc ?? parsed?.content_doc
    const types = []
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (typeof node.type === 'string') types.push(node.type)
      for (const child of node.content ?? []) walk(child)
    }
    walk(doc)
    return types
  } catch { return 'parse-failed' }
})()
report['S6-checked-flag'] = writeBody === null ? null : writeBody.includes('"checked":false')
report['S6-body-head'] = writeBody === null ? null : writeBody.slice(0, 120)
await cdp.evaluate(`document.querySelector('.ProseMirror')?.blur()`)
await cdp.moveMouse(700, 240)
await sleep(400)
await cdp.shot(OUT, '14-writing-checklist.png')

writeFileSync('C:/Programme/demo/SeekJournal/s04-ui-round2/session-report.json', JSON.stringify({
  app: APP,
  states: report,
  consoleErrors: cdp.consoleErrors.filter((item) => !item.includes('404')).slice(0, 12),
}, null, 2))
console.log(JSON.stringify(report, null, 2))
cdp.close()
