/** IME 精确诊断：Set / End 在组合期与上屏后的服务器内容。 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const OUT = process.env.QA_OUT ?? '.'
const steps = []

async function mock(path, options) {
  const res = await fetch(`${BASE}${path}`, options)
  return await res.json()
}

async function snapshot(session, label) {
  const state = await mock('/__mock/state')
  const body = await session.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
  const status = await session.eval(`document.querySelector('.ritual-status')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
  const html = await session.eval(`document.querySelector('.s4-editor-content')?.innerHTML.slice(0, 400) ?? ''`)
  const value = {
    body: body.trim(),
    status,
    servers: state.journals.map((j) => ({ kind: j.journal_kind, id: j.id, rev: j.revision, content: j.content.trim() })),
    html,
  }
  steps.push({ label, ...value })
  console.log(`${label} → ${JSON.stringify(value)}`)
}

async function key(session, keyName, code, vk, modifiers = 0) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await sleep(120)
}

async function goRitual(session, label) {
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000)
  await sleep(700)
}

async function main() {
  await mock('/__mock/reset', { method: 'POST' })
  const { child, wsUrl } = await launch({ port: 9229 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')

    for (const label of ['开始今天', '结束今天']) {
      await goRitual(session, label)
      await session.eval(`document.querySelector('.s4-editor-content').focus()`)
      await session.send('Input.insertText', { text: '前缀。' })
      await sleep(1400)
      await snapshot(session, `${label} 初次保存后`)

      await session.eval(`document.querySelector('.s4-editor-content').focus()`)
      await key(session, 'End', 'End', 35, 2)
      await session.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
      await sleep(1500)
      await snapshot(session, `${label} 组合中（未上屏 nihao）`)

      await session.send('Input.insertText', { text: '你好' })
      await sleep(1500)
      await snapshot(session, `${label} 上屏后 1.5s`)

      await sleep(3000)
      await snapshot(session, `${label} 上屏后 4.5s`)
      await session.screenshot(join(OUT, `r7-ime-${label}.png`))
    }
  } catch (error) {
    steps.push({ label: '实验中断', error: String(error) })
  } finally {
    await session.close()
    child.kill()
  }
  await writeFile(join(OUT, 'run7-ime.json'), JSON.stringify(steps, null, 2))
}

main().catch((error) => { console.error(error); process.exit(1) })
