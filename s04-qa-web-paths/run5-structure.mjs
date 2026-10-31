/** 结构隔离实验：Enter + 任务清单 的节点变化，用于区分合成按键与产品行为。 */
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const OUT = process.env.QA_OUT ?? '.'
const steps = []

async function mock(path, options) {
  const res = await fetch(`${BASE}${path}`, options)
  return await res.json()
}

async function html(session) {
  return await session.eval(`document.querySelector('.s4-editor-content')?.innerHTML ?? ''`)
}

async function body(session) {
  return await session.eval(`document.querySelector('.s4-editor-content')?.innerText ?? ''`)
}

function note(label, value) {
  steps.push({ label, value })
  console.log(`${label} → ${JSON.stringify(value)}`)
}

async function key(session, keyName, code, vk, modifiers = 0) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await sleep(150)
}

async function main() {
  await mock('/__mock/reset', { method: 'POST' })
  const { child, wsUrl } = await launch({ port: 9227 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')
    await session.clickText('开始今天')
    await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000)
    await sleep(800)

    await session.eval(`document.querySelector('.s4-editor-content').focus()`)
    await key(session, 'End', 'End', 35, 2)
    note('Ctrl+End 后 caret 是否在末尾（输入 AAA）', null)
    await session.send('Input.insertText', { text: 'AAA' })
    await sleep(300)
    note('输入 AAA 后 innerText', (await body(session)).trim())

    await key(session, 'Enter', 'Enter', 13)
    note('Enter 后 HTML', await html(session))

    await session.eval(`document.querySelector('button[aria-label="任务清单"]').click()`)
    await sleep(300)
    note('点击「任务清单」后 HTML', await html(session))

    await session.send('Input.insertText', { text: 'BBB' })
    await sleep(300)
    note('输入 BBB 后 HTML', await html(session))

    await key(session, 'Enter', 'Enter', 13)
    await session.send('Input.insertText', { text: 'CCC' })
    await sleep(300)
    note('Enter + CCC 后 HTML', await html(session))

    await sleep(2600)
    const state = await mock('/__mock/state')
    note('服务器 Set 文档', state.journals.find((j) => j.journal_kind === 'set')?.content_doc ?? null)
    await session.screenshot(join(OUT, 'r5-editor-structure.png'))
  } catch (error) {
    note('实验中断', String(error))
  } finally {
    await session.close()
    child.kill()
  }
  await writeFile(join(OUT, 'run5-structure.json'), JSON.stringify(steps, null, 2))
}

main().catch((error) => { console.error(error); process.exit(1) })
