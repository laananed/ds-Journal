/** 探针：量计划页的可用宽度，判断正文列为什么只有 ~460px。 */
import { connect, sleep } from './lib/cdp.mjs'
import { world, write, journal, BUSINESS_DATE } from './lib/mock-api.mjs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)
world.writing = []
world.set = journal(101, 'set', '', '今天是开学第九周的星期一。', BUSINESS_DATE, 3)
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
await sleep(900)

const rects = await cdp.evaluate(`(() => {
  const box = (selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const r = node.getBoundingClientRect()
    return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }
  }
  const stage = document.querySelector('.sj-ritual__stage')
  return {
    viewport: window.innerWidth,
    main: box('.sj-shell__main'),
    inner: box('.sj-shell__main-inner'),
    aside: box('.sj-shell__aside'),
    stage: box('.sj-ritual__stage'),
    stageCols: stage === null ? null : getComputedStyle(stage).gridTemplateColumns,
    context: box('.sj-ritual__context'),
    paper: box('.sj-ritual__paper'),
    editorContent: box('.sj-ritual .s4-editor-content'),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }
})()`)
console.log(JSON.stringify(rects, null, 2))
cdp.close()
