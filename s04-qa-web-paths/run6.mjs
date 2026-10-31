/**
 * 第五轮：Set/End 草稿恢复，以及 IME 组合期是否会保存半个拼音。
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

async function shot(session, name) {
  shotIndex += 1
  const file = join(OUT, `r6-${String(shotIndex).padStart(2, '0')}-${name}.png`)
  await session.screenshot(file)
  shots.push(file)
}

const statusText = (session) => session.eval(`(() => {
  const el = document.querySelector('.writing-status, .ritual-status')
  return el ? el.innerText.replace(/\\s+/g, ' ').trim() : null
})()`)

async function goWriting(session) {
  await session.clickText('写作')
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

async function main() {
  await reset()
  const { child, wsUrl } = await launch({ port: 9228 })
  const session = await openSession(wsUrl)
  try {
    await session.goto(BASE + '/')

    /* ===================== IME：Writing */
    await goWriting(session)
    await typeEnd(session, '写作前缀。')
    await sleep(2400)
    await focusEnd(session)
    await session.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
    await sleep(1700)
    const writingDuringIme = await state()
    record('IME Writing', '组合中输入 nihao（未上屏）时是否已发保存', '服务器不应出现未上屏拼音',
      { serverHasPinyin: writingDuringIme.journals.some((j) => j.content.includes('nihao')), body: (await session.bodyText()).trim(), status: await statusText(session) })
    await session.send('Input.insertText', { text: '你好' })
    await sleep(2400)
    const writingCommitted = await state()
    record('IME Writing', '上屏后提交', '服务器含「你好」且不含 nihao',
      { hasCommitted: writingCommitted.journals.some((j) => j.content.includes('你好')), hasPinyin: writingCommitted.journals.some((j) => j.content.includes('nihao')) })
    await shot(session, 'ime-writing')

    /* ===================== IME：Set */
    await goRitual(session, '开始今天')
    await typeEnd(session, '开始今天前缀。')
    await sleep(2600)
    await focusEnd(session)
    await session.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 })
    await sleep(1700)
    const setDuringIme = await state()
    record('IME Set', '组合中未上屏时是否已发保存', '服务器不应出现未上屏拼音',
      { serverHasPinyin: setDuringIme.journals.some((j) => j.journal_kind === 'set' && j.content.includes('nihao')), status: await statusText(session) })
    await session.send('Input.insertText', { text: '你好' })
    await sleep(2600)
    const setCommitted = await state()
    record('IME Set', '上屏后提交', '服务器含「你好」',
      { hasCommitted: setCommitted.journals.some((j) => j.journal_kind === 'set' && j.content.includes('你好')), status: await statusText(session) })
    await shot(session, 'ime-set')

    /* ===================== Set 草稿恢复：已有文件 + 断网 */
    await session.setOffline(true)
    await typeEnd(session, ' S1 断网追加。')
    await sleep(2600)
    record('Set 草稿恢复', '断网追加后状态', '保存失败且有本地草稿入口',
      { status: await statusText(session), callout: (await session.eval(`document.querySelector('.ritual-recovery-callout')?.innerText ?? ''`)).trim().slice(0, 60) })
    await session.setOffline(false)
    await session.goto(BASE + '/')
    await goRitual(session, '开始今天')
    await sleep(2500)
    const setCallout = await session.eval(`document.querySelector('.ritual-recovery-callout')?.innerText ?? ''`)
    record('Set 草稿恢复', '刷新后本机草稿入口', '出现入口', { callout: setCallout.trim().slice(0, 70) })
    await shot(session, 'set-recovery-callout')

    if (setCallout.includes('本地')) {
      await session.clickContains('查看本地草稿')
      await sleep(1500)
      const panel = await session.eval(`document.querySelector('.writing-drafts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
      record('Set 草稿恢复', '面板内容与动作', '提示可恢复编辑', { panel: panel.slice(0, 300) })
      const idx = await session.eval(`[...document.querySelectorAll('.writing-drafts button')].findIndex((b) => b.textContent.trim() === '恢复')`)
      if (idx >= 0) {
        await session.eval(`(() => { [...document.querySelectorAll('.writing-drafts button')][${idx}].click(); return true })()`)
        await sleep(2600)
        record('Set 草稿恢复', '点「恢复」', '编辑器出现断网追加的文字',
          { body: (await session.bodyText()).trim(), status: await statusText(session), notice: await session.eval(`document.querySelector('.ritual-notice')?.innerText ?? ''`) })
        await shot(session, 'set-recovered')
      } else {
        record('Set 草稿恢复', '点「恢复」', '面板无「恢复」按钮（未验证）', { panel: panel.slice(0, 200) })
      }
    }

    /* ===================== Set 未落库草稿恢复 */
    await reset()
    await session.goto(BASE + '/')
    await goRitual(session, '开始今天')
    await session.setOffline(true)
    await typeEnd(session, 'S2 断网新 Set。')
    await sleep(2600)
    await session.setOffline(false)
    await session.goto(BASE + '/')
    await goRitual(session, '开始今天')
    await sleep(2500)
    const freshCallout = await session.eval(`document.querySelector('.ritual-recovery-callout')?.innerText ?? ''`)
    record('Set 未落库草稿', '刷新后入口', '出现入口', { callout: freshCallout.trim().slice(0, 60) })
    if (freshCallout.includes('本地')) {
      await session.clickContains('查看本地草稿')
      await sleep(1500)
      const panel = await session.eval(`document.querySelector('.writing-drafts')?.innerText.replace(/\\s+/g, ' ').trim() ?? ''`)
      record('Set 未落库草稿', '面板动作', '应提供「恢复原请求」', { panel: panel.slice(0, 260) })
      const idx = await session.eval(`[...document.querySelectorAll('.writing-drafts button')].findIndex((b) => b.textContent.includes('恢复原请求'))`)
      if (idx >= 0) {
        await session.eval(`(() => { [...document.querySelectorAll('.writing-drafts button')][${idx}].click(); return true })()`)
        await sleep(3200)
        const after = await state()
        record('Set 未落库草稿', '恢复原请求', '只创建 1 条 set 且含文字',
          { count: after.journals.length, contents: after.journals.map((j) => `${j.journal_kind}:${j.content.trim()}`), status: await statusText(session), body: (await session.bodyText()).trim() })
        await shot(session, 'set-fresh-replayed')
      } else {
        record('Set 未落库草稿', '恢复原请求', '面板无该动作（未验证）', { panel: panel.slice(0, 200) })
      }
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

  await writeFile(join(OUT, 'run6-results.json'), JSON.stringify({ at: new Date().toISOString(), results, shots }, null, 2))
  console.log(`\n第五轮完成：${results.length} 步`)
}

main().catch((error) => { console.error(error); process.exit(1) })
