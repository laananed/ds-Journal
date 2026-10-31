/**
 * 第三轮场景（修正 C）：保存进行中切到其他模块、失败后离开、未落库草稿恢复、Set/End 目标。
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
  const file = join(OUT, `r3-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

const statusText = (session) => session.eval(`(() => {
  const el = document.querySelector('.writing-status, .ritual-status')
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
})()`)

const buttons = (session) => session.eval(`[...document.querySelectorAll('nav button')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`)

async function clickNav(session, label) {
  const info = await session.eval(`(() => {
    const btn = [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
    if (!btn) return { found: false }
    const disabled = btn.disabled
    btn.click()
    return { found: true, disabled }
  })()`)
  await sleep(120)
  return info
}

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
  const { child, wsUrl } = await launch({ port: 9225 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')
    await goWriting(session)
    await typeEnd(session, 'C0 慢保存第一段。')
    await sleep(2400)

    /* ===================== C1 保存进行中切到「概览」 */
    await setFault({ patchDelayMs: 3000 })
    await typeEnd(session, ' C1 慢保存。')
    await sleep(1100) // 800ms 自动保存已触发，请求仍在途
    const beforeClick = await buttons(session)
    const clickInfo = await clickNav(session, '概览')
    await sleep(700)
    const dashboardShown = await session.eval(`document.querySelector('.writing-page') === null`)
    record('C1 慢保存导航', '保存进行中点「概览」', '记录导航按钮状态与是否立即离开',
      { buttons: beforeClick, clicked: clickInfo, leftWritingImmediately: dashboardShown })
    await shot(session, 'nav-slow-save-click')

    await sleep(3500)
    const landedLater = await session.eval(`document.querySelector('.writing-page') === null`)
    const c1State = await state()
    record('C1 慢保存导航', '等待保存完成后页面去向', '自动完成延迟导航且内容已落库',
      { leftAfterSave: landedLater, serverHasC1: c1State.journals.some((j) => j.content.includes('C1 慢保存')) })
    await shot(session, 'nav-slow-save-after')
    await setFault({ patchDelayMs: 0 })

    /* ===================== C2 保存失败时点击导航 */
    await goWriting(session)
    await sleep(800)
    await setFault({ patchStatus: 503 })
    await typeEnd(session, ' C2 失败后离开。')
    await sleep(2600)
    const c2Status = await statusText(session)
    const dialogShown = await clickNav(session, '概览').then(async () => {
      await sleep(900)
      return await session.eval(`(() => { const d = document.querySelector('dialog.leave-dialog'); return d && d.open ? d.innerText.replace(/\\s+/g, ' ').trim() : null })()`)
    })
    record('C2 失败后离开', '保存失败时点导航', '弹出未保存离开确认', { statusBefore: c2Status, dialog: dialogShown })
    await shot(session, 'leave-dialog')

    if (dialogShown !== null) {
      await session.clickText('继续编辑')
      await sleep(600)
      const stillBody = await session.bodyText()
      record('C2 失败后离开', '选择「继续编辑」', '留在页面且文字仍在',
        { onWriting: await session.eval(`document.querySelector('.writing-page') !== null`), body: stillBody.trim() })
      await shot(session, 'leave-cancelled')

      await clickNav(session, '概览')
      await sleep(900)
      await session.clickText('确认离开')
      await sleep(1200)
      const localCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
      record('C2 失败后离开', '确认离开后草稿是否保留', '本机草稿入口应可见（切回写作时）',
        { left: await session.eval(`document.querySelector('.writing-page') === null`), callout: localCallout })
      await goWriting(session)
      await sleep(1500)
      const backCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
      record('C2 失败后离开', '离开后返回写作页', '能看到未提交草稿入口', { callout: backCallout.trim().slice(0, 90) })
      await shot(session, 'after-leave-recovers')
    }
    await setFault({ patchStatus: null })

    /* ===================== D 未落库草稿：断网 → 刷新 → 恢复原请求 */
    await reset()
    await session.setOffline(true)
    await session.goto(BASE + '/')
    await goWriting(session)
    await typeEnd(session, 'D1 断网新草稿。')
    await sleep(2400)
    record('D 未落库草稿', '断网时新建草稿', '状态保存失败且有本地草稿入口',
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
    record('D 未落库草稿', '面板给出的动作', '应提示创建结果未确认', { panel: panel.slice(0, 320) })
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

    /* ===================== E Set / End 目标 */
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
    await sleep(2600)
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

  await writeFile(join(OUT, 'run3-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第三轮完成：${results.length} 步`)
}

main().catch((error) => { console.error(error); process.exit(1) })
