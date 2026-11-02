/**
 * 沉浸式编辑 · 三种页面的输入中 / 鼠标移动后截图（第二轮 UI）。
 *
 * 真实构建产物 + CDP 合成数据；不启动后端、不连数据库、不调用模型。
 */
import { connect, resetLog, writeRequests, sleep } from './lib/cdp.mjs'
import { world, write, journal, BUSINESS_DATE } from './lib/mock-api.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round2/shots'
mkdirSync(OUT, { recursive: true })

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)

const chromeState = () => `(() => {
  const page = document.querySelector('.sj-write, .sj-ritual')
  const bar = document.querySelector('.sj-write__bar, .sj-ritual__bar')
  const context = document.querySelector('.sj-ritual__context')
  const style = (node) => node === null ? null : getComputedStyle(node).opacity
  return {
    root: page?.className ?? null,
    immersed: page?.classList.contains('is-immersed') ?? null,
    barOpacity: style(bar),
    contextOpacity: style(context),
    date: document.querySelector('.sj-write__date, .sj-ritual__date')?.textContent ?? null,
    statusVisible: (() => {
      const status = document.querySelector('.sj-write__status, .sj-ritual__status')
      if (status === null) return null
      return style(status)
    })(),
    toolbarOpacity: style(document.querySelector('.s4-toolbar')),
    hasBack: document.querySelector('[aria-label="返回概览"]') !== null,
  }
})()`

async function load(seedSet = null, seedEnd = null, width = 1440, height = 900) {
  world.writing = []
  world.set = seedSet
  world.end = seedEnd
  write.mode = 'ok'
  resetLog()
  await cdp.clearLocalDrafts(new URL(APP).origin)
  await cdp.setViewport(width, height)
  await cdp.send('Page.navigate', { url: APP })
  await cdp.waitFor(`document.querySelector('.dash-hero') !== null`)
  await sleep(400)
}

const report = {}

/* ---------------------------------------------------------------- 速记 */
await load()
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(500)
report['writing-idle'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '01-writing-idle.png')

await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('今天是开学第九周的星期一，本周的核心任务是把周六的培训项目跑起来。')
await cdp.type('我需要先确认场地，再定下流程。')
await sleep(900)
report['writing-typing'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '02-writing-typing.png')

await cdp.moveMouse(720, 260)
await sleep(450)
report['writing-after-move'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '03-writing-after-move.png')

/* 键盘用户：输入后淡出，按方向键（无输入）必须重新显示 */
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('再写一句。')
await sleep(700)
report['writing-typing-again'] = await cdp.evaluate(chromeState())
await cdp.press('ArrowLeft')
await sleep(400)
report['writing-after-key'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '03b-writing-after-key.png')

/* 保存失败时的重要信息在沉浸态下仍可见 */
write.mode = 'fail500'
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('继续补充。')
await sleep(1600)
report['writing-save-failed'] = await cdp.evaluate(chromeState())
report['writing-failed-text'] = await cdp.evaluate(`document.querySelector('.sj-write__status')?.textContent ?? null`)
await cdp.shot(OUT, '04-writing-save-failed.png')

/* 版本冲突：状态行必须能在淡出状态下被看见（409 由 Mock 返回） */
await load()
world.writing = [journal(555, 'writing', '已存在的速记', '服务器上的原文。', BUSINESS_DATE, 3)]
await cdp.send('Page.navigate', { url: APP })
await cdp.waitFor(`document.querySelector('.sj-nav') !== null`)
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(500)
await cdp.clickByLabel('.sj-write__ghost', '今天 1 篇')
await sleep(300)
await cdp.clickBySelector('.writing-item')
await sleep(700)
write.mode = 'conflict409'
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('本地又改了一句。')
await sleep(1600)
report['writing-conflict'] = await cdp.evaluate(chromeState())
report['writing-conflict-text'] = await cdp.evaluate(`document.querySelector('.sj-write__status')?.textContent ?? null`)
await cdp.shot(OUT, '04b-writing-conflict.png')

/* ---------------------------------------------------------------- 计划 */
await load(journal(101, 'set', '', '今天是开学第九周的星期一。这一周的核心任务是本周六的培训项目。', BUSINESS_DATE, 3))
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
await sleep(200)
await load(journal(101, 'set', '', '今天是开学第九周的星期一。这一周的核心任务是本周六的培训项目。', BUSINESS_DATE, 3))
await cdp.evaluate(`(() => {
  const node = [...document.querySelectorAll('.dash-action')].find((item) => item.textContent.trim() === '计划')
  if (node === undefined) return false
  node.click()
  return true
})()`)
await cdp.waitFor(`document.querySelector('.sj-ritual') !== null`)
await sleep(800)
report['ritual-set-idle'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '05-plan-idle.png')

await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.press('Enter')
await cdp.type('今天先列出要做的事情，再决定优先级。')
await sleep(900)
report['ritual-set-typing'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '06-plan-typing.png')

await cdp.moveMouse(740, 300)
await sleep(450)
report['ritual-set-after-move'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '07-plan-after-move.png')

/* ---------------------------------------------------------------- 复盘 */
await load(null, journal(102, 'end', '', '今天完成了场地确认。', BUSINESS_DATE, 2))
await cdp.evaluate(`(() => {
  const node = [...document.querySelectorAll('.dash-action')].find((item) => item.textContent.trim() === '复盘')
  if (node === undefined) return false
  node.click()
  return true
})()`)
await cdp.waitFor(`document.querySelector('.sj-ritual') !== null`)
await sleep(800)
report['ritual-end-idle'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '08-review-idle.png')

await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.press('Enter')
await cdp.type('明天的第一步是把流程发给同事确认。')
await sleep(900)
report['ritual-end-typing'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '09-review-typing.png')

await cdp.moveMouse(740, 300)
await sleep(450)
report['ritual-end-after-move'] = await cdp.evaluate(chromeState())
await cdp.shot(OUT, '10-review-after-move.png')

/* ---------------------------------------------------------------- 窄屏 */
await load()
await cdp.setViewport(560, 900)
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(600)
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('窄屏也要能安静地写。')
await sleep(700)
await cdp.shot(OUT, '11-narrow-typing.png')
report['narrow'] = await cdp.evaluate(chromeState())

writeFileSync(`${OUT}/../immersive-report.json`, JSON.stringify({
  app: APP,
  states: report,
  writes: writeRequests().map((item) => `${item.method} ${item.path}`),
  consoleErrors: cdp.consoleErrors.filter((item) => !item.includes('404')),
}, null, 2))
console.log(JSON.stringify(report, null, 2))
cdp.close()
