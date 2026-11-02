/** 探针：计划页「问题模板与目标」按需展开后，各区块是否都在、正文是否仍是主体。 */
import { connect, sleep } from './lib/cdp.mjs'
import { world, write, journal, BUSINESS_DATE } from './lib/mock-api.mjs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'
const OUT = 'C:/Programme/demo/SeekJournal/s04-ui-round2/shots'

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)
world.writing = []
world.set = journal(101, 'set', '', '今天是开学第九周的星期一。这一周的核心任务是本周六的培训项目。', BUSINESS_DATE, 3)
world.end = null
write.mode = 'ok'
await cdp.send('Page.navigate', { url: APP })
await cdp.waitFor(`document.querySelector('.dash-hero') !== null`)
await cdp.evaluate(`(() => {
  const node = [...document.querySelectorAll('.dash-action')].find((item) => item.textContent.trim() === '计划')
  if (node === undefined) return false
  node.click()
  return true
})()`)
await cdp.waitFor(`document.querySelector('.sj-ritual') !== null`)
await sleep(800)

const before = await cdp.evaluate(`document.querySelector('.sj-ritual__context') === null`)
await cdp.clickByLabel('.sj-ritual__ghost', '问题模板与目标')
await sleep(600)

const info = await cdp.evaluate(`(() => {
  const context = document.querySelector('.sj-ritual__context')
  const paper = document.querySelector('.sj-ritual__paper')
  const rect = (node) => node === null ? null : Math.round(node.getBoundingClientRect().width)
  return {
    contextPresent: context !== null,
    contextWidth: rect(context),
    paperWidth: rect(paper),
    sections: context === null ? [] : [...context.querySelectorAll('h3, h4')].map((n) => (n.textContent ?? '').trim()).slice(0, 8),
    contextText: context === null ? null : context.textContent.replace(/\\s+/g, ' ').slice(0, 160),
  }
})()`)
await cdp.shot(OUT, '15-plan-context-open.png')
console.log(JSON.stringify({ beforeContextMissing: before, ...info }, null, 2))
cdp.close()
