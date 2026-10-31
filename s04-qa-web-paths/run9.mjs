/** 第七轮：Set 页在保存进行中的导航表现，以及 Set 的 409 冲突处理。 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, openSession, sleep } from './cdp.mjs'

const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8039'
const OUT = process.env.QA_OUT ?? '.'
const results = []
const shots = []
let shotIndex = 0

function record(scenario, step, expected, actual) {
  results.push({ scenario, step, expected, actual })
  console.log(`[${scenario}] ${step} → ${JSON.stringify(actual)}`)
}

async function mock(path, options) {
  const res = await fetch(`${BASE}${path}`, options)
  return await res.json()
}
const state = () => mock('/__mock/state')
const reset = () => mock('/__mock/reset', { method: 'POST' })
const setFault = (patch) => mock('/__mock/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })

async function shot(session, name) {
  shotIndex += 1
  const file = join(OUT, `r9-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

const statusText = (session) => session.eval(`(() => {
  const el = document.querySelector('.ritual-status')
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
})()`)

const navState = (session) => session.eval(`[...document.querySelectorAll('nav button')].slice(0, 4).map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`)

async function goRitual(session, label) {
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000)
  await sleep(700)
}

async function typeEnd(session, text) {
  await session.eval(`document.querySelector('.s4-editor-content').focus()`)
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.insertText', { text })
  await sleep(150)
}

async function main() {
  await reset()
  const { child, wsUrl } = await launch({ port: 9231 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')
    await goRitual(session, '开始今天')
    await typeEnd(session, 'N0 已保存。')
    await sleep(2600)

    await setFault({ patchDelayMs: 3000 })
    await typeEnd(session, ' N1 慢保存。')
    await sleep(1200)
    const navDuring = await navState(session)
    const clicked = await session.eval(`(() => {
      const btn = [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === '写作')
      if (!btn) return null
      const disabled = btn.disabled
      btn.click()
      return { disabled }
    })()`)
    await sleep(800)
    const stillRitual = await session.eval(`document.querySelector('.ritual-page') !== null`)
    record('N Set 慢保存导航', '保存中点「写作」', '记录导航是否被禁用', { nav: navDuring, clicked, stillOnRitual: stillRitual })
    await shot(session, 'set-nav-during-save')
    await sleep(3500)
    const afterState = await state()
    record('N Set 慢保存导航', '保存完成后', '内容落库，导航恢复',
      { serverHas: afterState.journals.some((j) => j.content.includes('N1 慢保存')), nav: await navState(session), status: await statusText(session) })
    await setFault({ patchDelayMs: 0 })

    /* 409 冲突 */
    const s0 = await state()
    const set = s0.journals.find((j) => j.journal_kind === 'set')
    const external = await fetch(`${BASE}/api/journals/${set.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: set.revision, title: '外部标题' }),
    })
    record('O Set 冲突', '其他客户端先修改 Set', 'PATCH 200', { status: external.status })
    await typeEnd(session, ' O1 冲突文字。')
    await sleep(2800)
    record('O Set 冲突', '保存遇到 409', '输入保留并提示冲突',
      { body: (await session.bodyText()).trim(), status: await statusText(session), alert: await session.eval(`document.querySelector('.ritual-alert')?.innerText.replace(/\\s+/g, ' ').slice(0, 260) ?? ''`) })
    await shot(session, 'set-conflict')

    const hasReload = await session.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '读取服务器最新版本')`)
    if (hasReload) {
      await session.clickText('读取服务器最新版本')
      await sleep(1200)
      const keep = await session.eval(`[...document.querySelectorAll('button')].findIndex((b) => b.textContent.includes('保留本地草稿'))`)
      record('O Set 冲突', '读取服务器最新版本后', '出现双方选择', { keepButton: keep >= 0, notice: await session.eval(`document.querySelector('.ritual-notice')?.innerText ?? ''`) })
      if (keep >= 0) {
        await session.eval(`(() => { [...document.querySelectorAll('button')][${keep}].click(); return true })()`)
        await sleep(2600)
        const after = await state()
        record('O Set 冲突', '保留本地草稿并基于最新重写', '服务器保存 O1',
          { serverHas: after.journals.some((j) => j.journal_kind === 'set' && j.content.includes('O1 冲突文字')), status: await statusText(session) })
        await shot(session, 'set-conflict-resolved')
      }
    } else {
      record('O Set 冲突', '读取服务器最新版本', '未找到按钮（未验证）', {})
    }

    record('F 控制台', '整轮未捕获异常', '无', {
      errors: session.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 200)).slice(-5),
    })
  } catch (error) {
    record('RUNNER', '执行中断', '全流程完成', { error: String(error && error.stack || error) })
    await shot(session, 'runner-failure').catch(() => {})
  } finally {
    await session.close()
    child.kill()
  }

  await writeFile(join(OUT, 'run9-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第七轮完成：${results.length} 步`)
}

main().catch((error) => { console.error(error); process.exit(1) })
