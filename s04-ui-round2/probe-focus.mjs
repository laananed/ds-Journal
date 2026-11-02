/** 探针：找出正文区域那个紫色矩形到底由哪个元素画出来。 */
import { connect, sleep } from './lib/cdp.mjs'
import { world, write } from './lib/mock-api.mjs'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:5411/'
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9231'

const cdp = await connect(CDP)
await cdp.setViewport(1440, 900)
world.writing = []
world.set = null
world.end = null
write.mode = 'ok'
await cdp.send('Page.navigate', { url: APP })
await cdp.waitFor(`document.querySelector('.dash-hero') !== null`)
await cdp.clickByLabel('.sj-nav button, .sj-shortcuts button', '速记')
await cdp.waitFor(`document.querySelector('.ProseMirror') !== null`)
await sleep(500)
await cdp.evaluate(`document.querySelector('.ProseMirror').focus()`)
await cdp.type('探针一行字。')
await sleep(600)

const info = await cdp.evaluate(`(() => {
  const out = []
  for (const node of document.querySelectorAll('.sj-write *')) {
    const style = getComputedStyle(node)
    const noise = style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
      || style.boxShadow !== 'none'
      || style.borderTopWidth !== '0px' || style.borderLeftWidth !== '0px'
    if (!noise) continue
    out.push({
      tag: node.tagName,
      cls: node.className,
      outline: style.outline === undefined ? null : style.outline,
      boxShadow: style.boxShadow,
      border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].join('/'),
      borderColor: style.borderTopColor,
      bg: style.backgroundColor,
      focus: node === document.activeElement,
    })
  }
  return out
})()`)
console.log(JSON.stringify(info, null, 2))
cdp.close()
