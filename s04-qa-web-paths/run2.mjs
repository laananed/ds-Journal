/**
 * 第二轮场景：保存失败、版本冲突、保存中导航、未落库草稿恢复、Set/End 目标。
 * 仍然只连本地 Mock（8039），不写数据库、不调模型。
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
  const file = join(OUT, `r2-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

const statusText = (session) => session.eval(`(() => {
  const el = document.querySelector('.writing-status, .ritual-status')
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
})()`)

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
  const { child, wsUrl } = await launch({ port: 9224 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')
    await goWriting(session)

    /* ============================== A 已有文件保存失败 */
    await typeEnd(session, 'A1 第一段。')
    await sleep(2400)
    const a1 = await state()
    record('A 保存失败', '首次输入创建文件', '1 条 writing 记录',
      { journals: a1.journals.map((j) => ({ id: j.id, rev: j.revision })), status: await statusText(session) })

    await setFault({ patchStatus: 503 })
    await typeEnd(session, ' A2 保存会失败的文字。')
    await sleep(2600)
    const a2State = await state()
    const a2Body = await session.bodyText()
    record('A 保存失败', 'PATCH 503 后输入保留在编辑器', '正文含 A2 且状态为保存失败',
      { body: a2Body.trim(), status: await statusText(session) })
    record('A 保存失败', '失败的输入没有写入服务器', '服务器正文不含 A2',
      { serverHas: a2State.journals.some((j) => j.content.includes('A2 保存会失败')) })
    await shot(session, 'patch-503')

    await setFault({ patchStatus: null })
    const retry = await session.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '重试保存')`)
    if (retry) { await session.clickText('重试保存'); await sleep(2600) }
    const a2Retry = await state()
    record('A 保存失败', '恢复后点「重试保存」', '服务器保存 A2',
      { retryVisible: retry, serverHas: a2Retry.journals.some((j) => j.content.includes('A2 保存会失败')), status: await statusText(session) })
    await shot(session, 'after-retry')

    /* ============================== B 409 版本冲突 */
    const b0 = await state()
    const target = b0.journals[0]
    const external = await fetch(`${BASE}/api/journals/${target.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected_revision: target.revision, title: '外部客户端的标题' }),
    })
    record('B 版本冲突', '模拟其他客户端先改服务器', 'PATCH 200 且版本 +1', { status: external.status })
    await typeEnd(session, ' B1 本地冲突文字。')
    await sleep(2600)
    const bBody = await session.bodyText()
    record('B 版本冲突', '保存遇到 409 后本地输入保留', '正文含 B1，状态显示版本冲突',
      { body: bBody.trim(), status: await statusText(session) })
    await shot(session, 'conflict-status')

    const hasCompare = await session.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '对照服务器版本')`)
    if (hasCompare) {
      await session.clickText('对照服务器版本')
      await session.waitFor(`document.querySelector('.writing-conflict') !== null`, 6000, '冲突对照')
      const conflictText = await session.eval(`document.querySelector('.writing-conflict').innerText.replace(/\\s+/g, ' ').slice(0, 400)`)
      record('B 版本冲突', '打开两侧对照', '同时显示本地与服务器内容', { conflictText })
      await shot(session, 'conflict-compare')
      await session.clickText('保留我的草稿并提交')
      await sleep(3000)
      const bAfter = await state()
      record('B 版本冲突', '选择「保留我的草稿并提交」', '服务器保存本地内容（含 B1/A2）',
        { serverHasB1: bAfter.journals.some((j) => j.content.includes('B1')), status: await statusText(session) })
      await shot(session, 'conflict-resolved')
    } else {
      record('B 版本冲突', '打开两侧对照', '未找到「对照服务器版本」按钮（未验证）', { status: await statusText(session) })
    }

    /* ============================== C 保存中点击导航 */
    await setFault({ patchDelayMs: 2500 })
    await typeEnd(session, ' C1 慢保存。')
    await sleep(1200)
    const navState = await session.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '写作')
      if (!btn) return null
      const disabled = btn.disabled
      btn.click()
      return { disabled }
    })()`)
    await sleep(600)
    const landedDuring = await session.eval(`document.querySelector('.writing-page') !== null`)
    const notice = await session.eval(`document.querySelector('.writing-notice, .detail-success, [role="status"]')?.innerText ?? ''`)
    record('C 保存中导航', '保存进行中点击「写作」', '记录按钮是否禁用与是否离开',
      { navDisabledAtClick: navState?.disabled ?? null, stillOnWriting: landedDuring, visibleNotice: notice.trim().slice(0, 120) })
    await shot(session, 'nav-during-inflight')

    await sleep(4000)
    await goWriting(session)
    await sleep(1200)
    const cBody = await session.bodyText()
    const cState = await state()
    record('C 保存中导航', '等待保存完成后再次导航', '能离开且 C1 落库',
      { body: cBody.trim(), serverHasC1: cState.journals.some((j) => j.content.includes('C1 慢保存')) })
    await setFault({ patchDelayMs: 0 })

    /* ============================== D 未落库草稿：断网 → 刷新 → 恢复原请求 */
    await reset()
    await session.setOffline(true)
    await session.goto(BASE + '/')
    await goWriting(session)
    await typeEnd(session, 'D1 断网新草稿。')
    await sleep(2400)
    const dStatus = await statusText(session)
    const dCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('D 未落库草稿', '断网时新建草稿', '状态为保存失败且出现本地草稿入口',
      { status: dStatus, callout: dCallout.trim().slice(0, 80) })
    await shot(session, 'fresh-offline')

    await session.setOffline(false)
    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(2200)
    const dReloadCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('D 未落库草稿', '刷新后发现草稿', '出现未提交草稿入口', { callout: dReloadCallout.trim().slice(0, 80) })
    await session.clickContains('查看本地草稿')
    await sleep(1000)
    const dPanel = await session.eval(`document.querySelector('.writing-drafts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
    record('D 未落库草稿', '面板针对未落库草稿给出的动作', '应提示创建结果未确认', { panel: dPanel.slice(0, 300) })
    await shot(session, 'fresh-draft-panel')

    const replayBtn = await session.eval(`[...document.querySelectorAll('.writing-drafts button')].findIndex((b) => b.textContent.includes('恢复原请求'))`)
    if (replayBtn >= 0) {
      await session.eval(`(() => { [...document.querySelectorAll('.writing-drafts button')][${replayBtn}].click(); return true })()`)
      await sleep(3200)
      const dAfter = await state()
      record('D 未落库草稿', '点「恢复原请求」', '只创建 1 条记录且含 D1',
        { count: dAfter.journals.length, contents: dAfter.journals.map((j) => j.content.trim()), status: await statusText(session), body: (await session.bodyText()).trim() })
      await shot(session, 'fresh-draft-replayed')
    } else {
      record('D 未落库草稿', '点「恢复原请求」', '面板没有该动作（未验证）', { panel: dPanel.slice(0, 200) })
    }

    /* ============================== E Set / End 目标 */
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
    await sleep(4000)
    const e2 = await state()
    const setDoc = e2.journals.find((j) => j.journal_kind === 'set')
    const goalCount = (setDoc?.content_doc?.content ?? []).filter((n) => n.type === 'goalItem').length
    const goalList = await session.eval(`document.querySelector('.ritual-goal-list')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    record('E Set/End', '两条普通清单自动成为目标', '文档 2 个 goalItem 且页面列出',
      { goalCount, goalList: goalList.trim(), status: await statusText(session), alert: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'set-goals')

    const checkbox = await session.eval(`(() => {
      const box = document.querySelector('.ritual-goal-list input[type="checkbox"]')
      if (!box) return false
      box.click()
      return true
    })()`)
    await sleep(2600)
    const e3 = await state()
    const checkedNow = (e3.journals.find((j) => j.journal_kind === 'set')?.content_doc?.content ?? [])
      .filter((n) => n.type === 'goalItem').map((n) => n.attrs.checked)
    record('E Set/End', '勾选目标', '服务器 goalItem.checked 变为 true',
      { clicked: checkbox, checked: checkedNow, status: await statusText(session), goalError: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'set-goal-checked')

    await goRitual(session, '结束今天')
    await typeEnd(session, 'E2 今天完成了 QA。')
    await sleep(2600)
    const e4 = await state()
    record('E Set/End', '结束今天首次输入创建 End', '1 条 end 记录',
      { ends: e4.journals.filter((j) => j.journal_kind === 'end').map((j) => ({ id: j.id, rev: j.revision })), status: await statusText(session) })

    await goRitual(session, '开始今天')
    await sleep(1200)
    const addBtn = await session.eval(`(() => {
      const btn = [...document.querySelectorAll('.ritual-goal-list button')].find((b) => b.textContent.includes('加入结束今天') && !b.disabled)
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(2600)
    const e5 = await state()
    record('E Set/End', '把目标加入结束今天', '生成关联并写入 End 回顾',
      { clicked: addBtn, links: e5.links?.length ?? 0, notice: await session.eval(`document.querySelector('.ritual-notice')?.innerText ?? ''`), error: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'set-goal-linked')

    await goRitual(session, '结束今天')
    await sleep(1800)
    const reviews = await session.eval(`document.querySelector('.ritual-review-list')?.innerText.replace(/\\s+/g, ' ') ?? ''`)
    record('E Set/End', '结束今天查看目标回顾', '回顾列表显示目标与快照', { reviews: reviews.trim().slice(0, 240) })
    await shot(session, 'end-reviews')

    record('F 控制台', '整轮未捕获异常', '无', {
      errors: session.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails?.exception?.description?.slice(0, 160)).slice(-5),
    })
  } catch (error) {
    record('RUNNER', '执行中断', '全流程完成', { error: String(error && error.stack || error) })
    await shot(session, 'runner-failure').catch(() => {})
  } finally {
    await session.close()
    child.kill()
  }

  await writeFile(join(OUT, 'run2-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第二轮完成：${results.length} 步`)
}

main().catch((error) => { console.error(error); process.exit(1) })
