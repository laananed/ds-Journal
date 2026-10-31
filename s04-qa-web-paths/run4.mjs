/**
 * 第四轮（修正离线顺序）：未落库草稿恢复、Set/End 目标、未保存就切页、多篇打开。
 */
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
  const file = join(OUT, `r4-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

const statusText = (session) => session.eval(`(() => {
  const el = document.querySelector('.writing-status, .ritual-status')
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
})()`)

const buttons = (session) => session.eval(`[...document.querySelectorAll('nav button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`)

async function goWriting(session) {
  await session.clickText('写作')
  await session.waitFor(`document.querySelector('.writing-page') !== null`, 12000, '写作页')
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000, '写作编辑器')
  await sleep(400)
}

async function goRitual(session, label) {
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000, `${label} 页面`)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000, `${label} 编辑器`)
  await sleep(600)
}

async function focusEnd(session) {
  await session.eval(`document.querySelector('.s4-editor-content').focus()`)
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35, modifiers: 2 })
  await sleep(80)
}

async function typeEnd(session, text) {
  await focusEnd(session)
  await session.send('Input.insertText', { text })
  await sleep(150)
}

async function pressEnter(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(150)
}

async function main() {
  await reset()
  const { child, wsUrl } = await launch({ port: 9226 })
  const session = await openSession(wsUrl)
  try {
    /* ============================ D 未落库草稿：断网 → 刷新 → 恢复原请求 */
    await session.goto(BASE + '/')
    await goWriting(session)
    await session.setOffline(true)
    await typeEnd(session, 'D1 断网新草稿。')
    await sleep(2600)
    record('D 未落库草稿', '断网时新建草稿（从未落库）', '状态保存失败且出现本地草稿入口',
      { status: await statusText(session), callout: (await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)).trim().slice(0, 60) })
    await shot(session, 'fresh-offline')

    await session.setOffline(false)
    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(2200)
    const callout2 = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('D 未落库草稿', '刷新后发现草稿', '出现未提交草稿入口', { callout: callout2.trim().slice(0, 60) })
    await session.clickContains('查看本地草稿')
    await sleep(1200)
    const panel = await session.eval(`document.querySelector('.writing-drafts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
    record('D 未落库草稿', '面板给出的动作', '应提示「创建结果未确认」并可恢复原请求', { panel: panel.slice(0, 340) })
    await shot(session, 'fresh-draft-panel')

    const replayIdx = await session.eval(`[...document.querySelectorAll('.writing-drafts button')].findIndex((b) => b.textContent.includes('恢复原请求'))`)
    if (replayIdx >= 0) {
      await session.eval(`(() => { [...document.querySelectorAll('.writing-drafts button')][${replayIdx}].click(); return true })()`)
      await sleep(3200)
      const dState = await state()
      record('D 未落库草稿', '点「恢复原请求」', '只创建 1 条含 D1 的记录',
        { count: dState.journals.length, contents: dState.journals.map((j) => j.content.trim()), status: await statusText(session), body: (await session.bodyText()).trim() })
      await shot(session, 'fresh-draft-replayed')
    } else {
      record('D 未落库草稿', '点「恢复原请求」', '面板无该动作（未验证）', { panel: panel.slice(0, 200) })
    }

    /* ============================ G 未保存就切页（400ms 内） */
    await reset()
    await session.goto(BASE + '/')
    await goWriting(session)
    await typeEnd(session, 'G1 立刻切页。')
    await sleep(200) // 800ms 自动保存尚未触发
    await session.clickText('概览')
    await sleep(1200)
    const gLeft = await session.eval(`document.querySelector('.writing-page') === null`)
    const gState = await state()
    record('G 立刻切页', '输入后 200ms 点「概览」', '先保存再离开，服务器含 G1',
      { left: gLeft, serverHas: gState.journals.some((j) => j.content.includes('G1 立刻切页')), status: await statusText(session) })
    await shot(session, 'quick-nav')

    await goWriting(session)
    await sleep(1500)
    record('G 立刻切页', '返回写作页', '正文仍在（含 G1）', { body: (await session.bodyText()).trim() })

    /* ============================ H 同一天多篇 + 刷新后列表打开 */
    await session.clickText('新建一篇')
    await sleep(300)
    await typeEnd(session, 'H2 第二篇。')
    await sleep(2600)
    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(1500)
    const listText = await session.eval(`document.querySelector('.writing-items')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    record('H 多篇列表', '刷新后侧栏列出当天写作', '列出 2 篇',
      { list: listText.trim().slice(0, 200), editorBody: (await session.bodyText()).trim() })
    await shot(session, 'writing-list-after-reload')

    const itemCount = await session.eval(`document.querySelectorAll('.writing-items li button').length`)
    if (itemCount > 0) {
      await session.eval(`document.querySelectorAll('.writing-items li button')[0].click()`)
      await sleep(2000)
      record('H 多篇列表', '点侧栏第一篇打开', '编辑器显示该篇正文',
        { count: itemCount, body: (await session.bodyText()).trim(), status: await statusText(session) })
      await shot(session, 'writing-open-item')
    }

    /* ============================ E Set / End 目标 */
    await reset()
    await session.goto(BASE + '/')
    await goRitual(session, '开始今天')
    await typeEnd(session, 'E1 今天先完成 QA。')
    await sleep(2600)
    const e1 = await state()
    record('E Set/End', '开始今天首次输入创建 Set', '1 条 set 记录',
      { sets: e1.journals.filter((j) => j.journal_kind === 'set').map((j) => ({ id: j.id, rev: j.revision })), status: await statusText(session) })

    await pressEnter(session)
    await session.eval(`document.querySelector('button[aria-label="任务清单"]').click()`)
    await sleep(250)
    await session.send('Input.insertText', { text: 'α 目标一' })
    await sleep(200)
    await pressEnter(session)
    await session.send('Input.insertText', { text: 'β 目标二' })
    await sleep(4200)
    const e2 = await state()
    const setDoc = e2.journals.find((j) => j.journal_kind === 'set')
    const goalCount = (setDoc?.content_doc?.content ?? []).filter((n) => n.type === 'goalItem').length
    const goalList = await session.eval(`document.querySelector('.ritual-goal-list')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    record('E Set/End', '两条普通清单自动成为目标', '文档 2 个 goalItem 且页面列出',
      { goalCount, goalList: goalList.trim(), status: await statusText(session), alert: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'set-goals')

    await session.eval(`(() => { const box = document.querySelector('.ritual-goal-list input[type="checkbox"]'); if (box) box.click(); return true })()`)
    await sleep(2800)
    const e3 = await state()
    const checked = (e3.journals.find((j) => j.journal_kind === 'set')?.content_doc?.content ?? [])
      .filter((n) => n.type === 'goalItem').map((n) => n.attrs.checked)
    record('E Set/End', '勾选目标', '服务器 checked=true',
      { checked, status: await statusText(session), goalError: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'set-goal-checked')

    await goRitual(session, '结束今天')
    await typeEnd(session, 'E2 今天完成了 QA。')
    await sleep(2600)
    const e4 = await state()
    record('E Set/End', '结束今天首次输入创建 End', '1 条 end 记录',
      { ends: e4.journals.filter((j) => j.journal_kind === 'end').map((j) => ({ id: j.id, rev: j.revision })), status: await statusText(session) })

    await goRitual(session, '开始今天')
    await sleep(1500)
    const addOk = await session.eval(`(() => {
      const btn = [...document.querySelectorAll('.ritual-goal-list button')].find((b) => b.textContent.includes('加入结束今天') && !b.disabled)
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(2800)
    const e5 = await state()
    record('E Set/End', '把目标加入结束今天', '生成关联并写回顾',
      { clicked: addOk, links: e5.links?.length ?? 0, notice: await session.eval(`document.querySelector('.ritual-notice')?.innerText ?? ''`), error: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'set-goal-linked')

    await goRitual(session, '结束今天')
    await sleep(1800)
    const reviews = await session.eval(`document.querySelector('.ritual-review-list')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    record('E Set/End', '结束今天查看目标回顾', '回顾列表显示目标与快照', { reviews: reviews.trim().slice(0, 240) })
    await shot(session, 'end-reviews')

    record('F 控制台', '整轮未捕获异常', '无', {
      errors: session.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 200)).slice(-5),
    })
  } catch (error) {
    record('RUNNER', '执行中断', '全流程完成', { error: String(error && error.stack || error), buttons: await buttons(session).catch(() => null) })
    await shot(session, 'runner-failure').catch(() => {})
  } finally {
    await session.close()
    child.kill()
  }

  await writeFile(join(OUT, 'run4-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第四轮完成：${results.length} 步`)
}

main().catch((error) => { console.error(error); process.exit(1) })
