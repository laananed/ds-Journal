/** 第六轮：本机草稿与服务器版本冲突时的恢复，以及只有标题的草稿是否保留。 */
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

async function shot(session, name) {
  shotIndex += 1
  const file = join(OUT, `r8-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

const statusText = (session) => session.eval(`(() => {
  const el = document.querySelector('.writing-status')
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
})()`)

async function goWriting(session) {
  await session.clickText('写作')
  await session.waitFor(`document.querySelector('.writing-page') !== null`, 12000)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000)
  await sleep(400)
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
  const { child, wsUrl } = await launch({ port: 9230 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')
    await goWriting(session)

    /* ============ 1 本机草稿 × 服务器已更新 → 恢复时应给冲突对照 */
    await typeEnd(session, 'R0 已保存正文。')
    await sleep(2500)
    await session.setOffline(true)
    await typeEnd(session, ' R1 断网追加。')
    await sleep(2600)
    await session.setOffline(false)

    const before = await state()
    const file = before.journals[0]
    const external = await fetch(`${BASE}/api/journals/${file.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: file.revision, title: '其他客户端改过' }),
    })
    record('R 恢复冲突', '其他客户端先修改服务器', 'PATCH 200',
      { status: external.status, serverRev: (await state()).journals[0].revision })

    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(2200)
    const callout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('R 恢复冲突', '刷新后发现本机草稿', '出现入口', { callout: callout.trim().slice(0, 60) })
    await session.clickContains('查看本地草稿')
    await sleep(1200)
    const panel = await session.eval(`document.querySelector('.writing-drafts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
    record('R 恢复冲突', '面板计划', '应提示与服务器版本不同', { panel: panel.slice(0, 260) })

    const idx = await session.eval(`[...document.querySelectorAll('.writing-drafts button')].findIndex((b) => b.textContent.trim() === '恢复')`)
    if (idx >= 0) {
      await session.eval(`(() => { [...document.querySelectorAll('.writing-drafts button')][${idx}].click(); return true })()`)
      await sleep(2200)
      const conflict = await session.eval(`document.querySelector('.writing-conflict')?.innerText.replace(/\\s+/g, ' ').slice(0, 400) ?? ''`)
      record('R 恢复冲突', '点「恢复」后的界面', '显示两侧对照而不是直接覆盖',
        { conflict: conflict, body: (await session.bodyText()).trim(), status: await statusText(session) })
      await shot(session, 'record-conflict')

      const keep = await session.eval(`[...document.querySelectorAll('.writing-conflict button')].findIndex((b) => b.textContent.includes('保留我的草稿'))`)
      if (keep >= 0) {
        await session.eval(`(() => { [...document.querySelectorAll('.writing-conflict button')][${keep}].click(); return true })()`)
        await sleep(2600)
        const after = await state()
        record('R 恢复冲突', '保留我的草稿（基于服务器版本）', '编辑器回到本机内容，可再次保存',
          { body: (await session.bodyText()).trim(), status: await statusText(session), server: after.journals[0].content.trim() })
        await shot(session, 'record-conflict-kept')
      }
    } else {
      record('R 恢复冲突', '点「恢复」后的界面', '面板无「恢复」按钮（未验证）', { panel: panel.slice(0, 200) })
    }

    /* ============ 2 只有标题的草稿 */
    await reset()
    await session.goto(BASE + '/')
    await goWriting(session)
    await session.setInput('.writing-field input[type="text"]', '只有标题')
    await sleep(2200)
    const titleState = await state()
    record('T 只有标题', '只填标题不写正文', '不创建服务器记录',
      { journals: titleState.journals.length, status: await statusText(session), hint: await session.eval(`[...document.querySelectorAll('.writing-hint')].map((n) => n.innerText).join(' | ')`) })

    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(2200)
    const titleCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('T 只有标题', '刷新后标题是否仍可找回', '出现本机草稿入口',
      { callout: titleCallout.trim().slice(0, 60), titleValue: await session.eval(`document.querySelector('.writing-field input[type="text"]')?.value ?? ''`) })
    await shot(session, 'title-only-draft')

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

  await writeFile(join(OUT, 'run8-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第六轮完成：${results.length} 步`)
}

main().catch((error) => { console.error(error); process.exit(1) })
