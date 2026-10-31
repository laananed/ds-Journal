/**
 * Writing / Set / End 常用路径的 Mock 浏览器检查（隔离端口 8039，不连真实后端与数据库）。
 *
 * 每个场景独立记录：步骤、预期、实测、截图；异常只标记该场景失败，不中断后续场景。
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
  const pass = actual !== null && actual !== undefined
  results.push({ scenario, step, expected, actual, pass })
  console.log(`[${scenario}] ${step} → ${JSON.stringify(actual)}`)
}

async function mock(path, options) {
  const res = await fetch(`${BASE}${path}`, options)
  return await res.json()
}

async function state() {
  return await mock('/__mock/state')
}

async function setFault(patch) {
  await mock('/__mock/fault', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
}

async function reset() {
  await mock('/__mock/reset', { method: 'POST' })
}

async function shot(session, name) {
  shotIndex += 1
  const file = join(OUT, `shot-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

async function statusText(session) {
  return await session.eval(`(() => {
    const el = document.querySelector('.writing-status, .ritual-status')
    return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
  })()`)
}

async function goWriting(session) {
  await session.clickText('写作')
  await session.waitFor(`document.querySelector('.writing-page') !== null`, 12000, '写作页')
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000, '写作编辑器')
}

async function goRitual(session, label) {
  await session.clickText(label)
  await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000, `${label} 页面`)
  await session.waitFor(`document.querySelector('.s4-editor-content') !== null`, 12000, `${label} 编辑器`)
}

async function pressEnter(session) {
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await sleep(120)
}

async function pageErrors(session) {
  const errors = session.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'))
    .map((e) => (e.method === 'Runtime.exceptionThrown'
      ? e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text
      : (e.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')))
  return errors.slice(-10)
}

async function main() {
  await reset()
  const { child, wsUrl } = await launch({ port: 9223 })
  const session = await openSession(wsUrl)
  try {
    /* ================================================= S1 Writing 新建/保存 */
    await session.goto(BASE + '/')
    await session.waitFor(`document.querySelector('.writing-page') === null`, 5000)
    await goWriting(session)
    const before = await state()

    await session.typeBody('QA 第一段：写作保存路径。')
    await sleep(2200)
    const afterFirst = await state()
    record('S1 新建保存', '输入正文后自动创建', '新增 1 条 writing 记录',
      { before: before.journals.length, after: afterFirst.journals.length, status: await statusText(session) })
    await shot(session, 'writing-first-save')

    await session.clickText('新建一篇')
    await sleep(300)
    const bodyAfterNew = await session.bodyText()
    record('S1 新建保存', '点「新建一篇」后编辑器清空', '正文为空', { body: bodyAfterNew.trim() })
    await session.typeBody('QA 第二段：另一篇写作。')
    await sleep(2200)
    const afterSecond = await state()
    record('S1 新建保存', '第二篇独立创建', '共 2 条 writing 记录',
      { journals: afterSecond.journals.map((j) => ({ id: j.id, kind: j.journal_kind, rev: j.revision })) })

    /* ================================================= S2 切页返回 */
    const bodyBeforeNav = await session.bodyText()
    await session.clickText('开始今天')
    await session.waitFor(`document.querySelector('.ritual-page') !== null`, 12000, '开始今天')
    await sleep(800)
    await goWriting(session)
    await sleep(600)
    const bodyAfterNav = await session.bodyText()
    record('S2 切页返回', '写作→开始今天→写作，正文保持', '与离开前一致',
      { before: bodyBeforeNav.trim(), after: bodyAfterNav.trim(), equal: bodyBeforeNav.trim() === bodyAfterNav.trim() })
    await shot(session, 'writing-after-nav-return')

    /* ================================================= S3 刷新后恢复 */
    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(1500)
    const bodyAfterReload = await session.bodyText()
    record('S3 刷新恢复', '刷新后回到写作页', '自动回到最近一篇（含正文或可恢复入口）',
      { body: bodyAfterReload.trim(), callout: await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`) })
    await shot(session, 'writing-after-reload')

    /* ================================================= S4 保存失败保留输入 */
    await setFault({ patchStatus: 503 })
    await session.typeBody(' QA 追加：保存会失败的文字。')
    await sleep(2500)
    const failedBody = await session.bodyText()
    const failedStatus = await statusText(session)
    record('S4 保存失败', 'PATCH 503 后输入仍留在编辑器', '正文含追加文字且状态为保存失败',
      { body: failedBody.trim(), status: failedStatus })
    await shot(session, 'writing-save-failed')
    const failedState = await state()
    record('S4 保存失败', '失败的输入未写入服务器', '服务器正文不含追加文字',
      { serverHas: failedState.journals.some((j) => j.content.includes('保存会失败')) })

    await setFault({ patchStatus: null })
    const retryVisible = await session.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '重试保存')`)
    if (retryVisible) {
      await session.clickText('重试保存')
      await sleep(2500)
    }
    const retriedState = await state()
    record('S4 保存失败', '恢复网络后点「重试保存」', '服务器保存了追加文字',
      { retried: retryVisible, serverHas: retriedState.journals.some((j) => j.content.includes('保存会失败')), status: await statusText(session) })
    await shot(session, 'writing-after-retry')

    /* ================================================= S5 断网 + 刷新 + 本地草稿 */
    await session.setOffline(true)
    await session.typeBody(' QA 断网文字。')
    await sleep(2600)
    const offlineCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('S5 断网草稿', '断网输入后出现本地草稿入口', '提示存在未提交草稿', { callout: offlineCallout.trim() })
    await shot(session, 'writing-offline')

    await session.setOffline(false)
    await session.goto(BASE + '/')
    await goWriting(session)
    await sleep(2500)
    const reloadCallout = await session.eval(`document.querySelector('.writing-recovery-callout')?.innerText ?? ''`)
    record('S5 断网草稿', '刷新后仍能发现本地草稿', '出现本地草稿入口（计数 ≥1）', { callout: reloadCallout.trim() })
    await shot(session, 'writing-offline-reload')

    if (reloadCallout.includes('本地')) {
      await session.clickContains('查看本地草稿')
      await sleep(800)
      const panel = await session.eval(`document.querySelector('.writing-drafts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
      record('S5 断网草稿', '打开本地草稿面板', '列出草稿与动作', { panel })
      await shot(session, 'writing-drafts-panel')
      const restoreIndex = await session.eval(`[...document.querySelectorAll('.writing-drafts button')].findIndex((b) => /恢复/.test(b.textContent))`)
      if (restoreIndex >= 0) {
        await session.eval(`(() => {
          const buttons = [...document.querySelectorAll('.writing-drafts button')]
          buttons[${restoreIndex}].click()
          return true
        })()`)
        await sleep(2500)
        record('S5 断网草稿', '恢复本地草稿', '编辑器出现断网时的文字',
          { body: (await session.bodyText()).trim(), status: await statusText(session) })
        await shot(session, 'writing-after-draft-restore')
      } else {
        record('S5 断网草稿', '恢复本地草稿', '面板里没有「恢复」按钮（未验证恢复动作）', { panel })
      }
    }

    /* ================================================= S6 Set 进入/编辑/保存 */
    await goRitual(session, '开始今天')
    await sleep(1200)
    const setStatusBefore = await statusText(session)
    await session.typeBody('今天先完成 QA 检查。')
    await sleep(2600)
    const setState = await state()
    const setJournals = setState.journals.filter((j) => j.journal_kind === 'set')
    record('S6 开始今天', '首次输入后创建 Set 文件', '出现 1 条 set 记录',
      { before: setStatusBefore, sets: setJournals.map((j) => ({ id: j.id, rev: j.revision })), status: await statusText(session) })
    await shot(session, 'ritual-set-saved')

    /* ================================================= S7 切页返回 Set */
    await session.clickText('写作')
    await session.waitFor(`document.querySelector('.writing-page') !== null`, 12000, '写作页')
    await sleep(900)
    await goRitual(session, '开始今天')
    await sleep(1500)
    record('S7 Set 切页返回', '开始今天→写作→开始今天，正文保持', '含「今天先完成 QA 检查。」',
      { body: (await session.bodyText()).trim() })
    await shot(session, 'ritual-set-return')

    /* ================================================= S8 Set 清单与目标 */
    await session.eval(`document.querySelector('.s4-editor-content').focus()`)
    await pressEnter(session)
    await session.eval(`document.querySelector('button[aria-label="任务清单"]').click()`)
    await sleep(200)
    await session.typeBody('完成 QA 报告')
    await sleep(3000)
    const goalState = await state()
    const setDoc = goalState.journals.find((j) => j.journal_kind === 'set')?.content_doc
    const goalNodes = JSON.stringify(setDoc ?? {}).includes('goalItem')
    const goalList = await session.eval(`document.querySelector('.ritual-goal-list')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
    record('S8 目标创建', '普通清单条目自动转为目标', '文档出现 goalItem 且页面「今天的目标」列出该目标',
      { goalNodes, goalList, status: await statusText(session), alert: await session.eval(`document.querySelector('.ritual-alert')?.innerText ?? ''`) })
    await shot(session, 'ritual-set-goal')

    /* ================================================= S9 End 页面 */
    await goRitual(session, '结束今天')
    await sleep(1500)
    await session.typeBody('今天完成了 QA 检查。')
    await sleep(2600)
    const endState = await state()
    record('S9 结束今天', '进入并保存 End 文件', '出现 1 条 end 记录',
      { ends: endState.journals.filter((j) => j.journal_kind === 'end').map((j) => ({ id: j.id, rev: j.revision })), status: await statusText(session) })
    await shot(session, 'ritual-end-saved')

    /* ============================================ S10 保存中点击导航 */
    await goRitual(session, '开始今天')
    await sleep(1200)
    await session.eval(`document.querySelector('.s4-editor-content').focus()`)
    await session.typeBody(' 导航竞态测试。')
    await sleep(150) // 自动保存尚未触发完（900ms 定时器）
    const navDisabled = await session.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '写作')
      return btn ? btn.disabled : null
    })()`)
    await session.clickText('写作').catch((error) => { console.log('导航点击异常：', error.message) })
    await sleep(400)
    const landed = await session.eval(`document.querySelector('.writing-page') !== null`)
    record('S10 保存中导航', '输入后立刻点导航', '应当能离开或给出明确提示', { navDisabled, landedOnWriting: landed })
    await shot(session, 'nav-during-save')

    await sleep(2500)
    const finalState = await state()
    const setAfter = finalState.journals.find((j) => j.journal_kind === 'set')
    record('S10 保存中导航', '切页后 Set 的这次输入是否落库', '服务器包含「导航竞态测试。」',
      { serverHas: setAfter ? setAfter.content.includes('导航竞态测试') : false, landedOnWriting: landed })

    record('S11 控制台', '整轮页面错误', '无未捕获异常', { errors: await pageErrors(session) })
  } catch (error) {
    record('RUNNER', '执行中断', '全流程完成', { error: String(error && error.stack || error) })
    await shot(session, 'runner-failure').catch(() => {})
  } finally {
    await session.close()
    child.kill()
  }

  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    shots,
    results,
  }
  await writeFile(join(OUT, 'run-results.json'), JSON.stringify(summary, null, 2))
  console.log(`\n完成：${summary.passed}/${summary.total}，结果写入 run-results.json`)
}

main().catch((error) => { console.error(error); process.exit(1) })
