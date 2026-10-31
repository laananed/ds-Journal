/**
 * 定向复现：Insight 输入后刷新/关闭、取消新建；日程刷新/关闭；创建成功但列表刷新失败。
 *
 * 全部请求由 `mock-core.mjs` 拦截，不连接真实后端、不写数据库、不调用模型。
 * 每个场景独立 browser + context + freshState，避免互相污染。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4193/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-03/s04-sight-check'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const nav = (page, label) => page.getByRole('button', { name: label, exact: true }).first()

async function localArtifacts(page) {
  return page.evaluate(async () => {
    const out = { localStorage: {}, idb: {} }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      out.localStorage[key] = String(localStorage.getItem(key)).slice(0, 160)
    }
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases()
      for (const info of dbs) {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(info.name)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const stores = {}
        for (const name of Array.from(db.objectStoreNames)) {
          stores[name] = await new Promise((resolve) => {
            const tx = db.transaction(name, 'readonly')
            const count = tx.objectStore(name).count()
            count.onsuccess = () => resolve(count.result)
            count.onerror = () => resolve(-1)
          })
        }
        out.idb[info.name] = stores
        db.close()
      }
    }
    return out
  })
}

async function newInsightTyping(page, marker) {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor({ timeout: 8000 })
  await page.locator('.journal-editor input[type="text"]').first().fill(`标题-${marker}`)
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type(`正文-${marker}`)
}

async function openExistingInsight(page) {
  await nav(page, '洞察').click()
  await page.locator('.file-card', { hasText: '已有洞察' }).click()
  await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 8000 })
}

async function editExistingInsightTyping(page, marker) {
  await openExistingInsight(page)
  await page.getByRole('button', { name: '修改', exact: true }).click()
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(`追加-${marker}`)
}

async function insightAfterReload(page, marker) {
  await nav(page, '洞察').click()
  await page.waitForTimeout(700)
  const body = await page.locator('body').innerText()
  const cards = await page.locator('.file-card').allInnerTexts()
  let detail = ''
  const target = page.locator('.file-card', { hasText: marker })
  if (await target.count()) {
    await target.first().click()
    await page.waitForTimeout(500)
    const pm = page.locator('.journal-editor .ProseMirror').last()
    detail = (await pm.count()) ? await pm.innerText() : await page.locator('.journal-editor').innerText()
  }
  return {
    pageShowsMarker: body.includes(marker),
    detailShowsMarker: detail.includes(marker),
    cards,
    detailSnippet: detail.slice(0, 80),
  }
}

function insightRequests(state) {
  const posts = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/insights')
  const patches = state.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/insights/'))
  return {
    POST: posts.length,
    PATCH: patches.length,
    postTitles: posts.map((p) => p.body?.title ?? null),
    postHasClientKey: posts.map((p) => Boolean(p.body?.client_create_id)),
    serverCount: state.insights.length,
    serverTitles: state.insights.map((i) => i.display_title),
    serverHasMarker: state.insights.some((i) => `${i.display_title} ${i.content}`.includes(arguments[1] ?? '')),
  }
}

async function openSchedules(page) {
  await nav(page, '日程').click()
  await page.locator('.sched-item, .sched-state').first().waitFor({ timeout: 8000 })
  await page.waitForTimeout(300)
}

async function scheduleEditTyping(page, marker) {
  await openSchedules(page)
  const item = page.locator('.sched-item', { hasText: '与导师讨论提纲' })
  await item.getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form').waitFor()
  await page.locator('.sched-form input[type="text"]').fill(marker)
}

async function scheduleCreateTyping(page, marker) {
  await openSchedules(page)
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form').waitFor()
  await page.locator('.sched-form input[type="text"]').fill(marker)
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-05T09:00')
}

function scheduleRequests(state) {
  const posts = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/schedules')
  const patches = state.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/schedules/'))
  return {
    POST: posts.length,
    PATCH: patches.length,
    postTitles: posts.map((p) => p.body?.title ?? null),
    postKeys: posts.map((p) => p.body?.client_create_id ?? null),
    serverCount: state.schedules.length,
    serverTitles: state.schedules.map((s) => s.title),
  }
}

const scenarios = []
const scenario = (id, name, fn) => scenarios.push({ id, name, fn })

/* ---------------- 1. Insight 输入后立即刷新 / 关闭 ---------------- */

scenario('I-NEW-0', '新建 Insight：标题+正文后立即刷新（<800ms）', async ({ page, state, dialogs }) => {
  await newInsightTyping(page, 'MNEW0')
  const local = await localArtifacts(page)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  const after = await insightAfterReload(page, 'MNEW0')
  return { elapsedMs: elapsed, local, dialogs: [...dialogs], ...insightRequests(state, 'MNEW0'), after }
})

scenario('I-NEW-400', '新建 Insight：输入后等 400ms 刷新', async ({ page, state, dialogs }) => {
  await newInsightTyping(page, 'MNEW4')
  const local = await localArtifacts(page)
  await page.waitForTimeout(400)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  const after = await insightAfterReload(page, 'MNEW4')
  return { elapsedMs: elapsed + 400, local, dialogs: [...dialogs], ...insightRequests(state, 'MNEW4'), after }
})

scenario('I-NEW-1200', '新建 Insight：输入后等 1200ms（超过 800ms 防抖）刷新', async ({ page, state, dialogs }) => {
  await newInsightTyping(page, 'MNEW12')
  const local = await localArtifacts(page)
  await page.waitForTimeout(1200)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  const after = await insightAfterReload(page, 'MNEW12')
  return { elapsedMs: elapsed + 1200, local, dialogs: [...dialogs], ...insightRequests(state, 'MNEW12'), after }
})

scenario('I-NEW-CLOSE', '新建 Insight：输入后立即关闭页面', async ({ page, state, dialogs }) => {
  await newInsightTyping(page, 'MNEWC')
  const local = await localArtifacts(page)
  await page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 700))
  return { local, dialogs: [...dialogs], ...insightRequests(state, 'MNEWC') }
})

scenario('I-EDIT-0', '已有 Insight：追加正文后立即刷新（<800ms）', async ({ page, state, dialogs }) => {
  await editExistingInsightTyping(page, 'MEDT0')
  const local = await localArtifacts(page)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  const after = await insightAfterReload(page, 'MEDT0')
  return { elapsedMs: elapsed, local, dialogs: [...dialogs], ...insightRequests(state, 'MEDT0'), after }
})

scenario('I-EDIT-400', '已有 Insight：追加正文后等 400ms 刷新', async ({ page, state, dialogs }) => {
  await editExistingInsightTyping(page, 'MEDT4')
  const local = await localArtifacts(page)
  await page.waitForTimeout(400)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  const after = await insightAfterReload(page, 'MEDT4')
  return { elapsedMs: elapsed + 400, local, dialogs: [...dialogs], ...insightRequests(state, 'MEDT4'), after }
})

scenario('I-EDIT-1200', '已有 Insight：追加正文后等 1200ms 刷新', async ({ page, state, dialogs }) => {
  await editExistingInsightTyping(page, 'MEDT12')
  const local = await localArtifacts(page)
  await page.waitForTimeout(1200)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  const after = await insightAfterReload(page, 'MEDT12')
  return { elapsedMs: elapsed + 1200, local, dialogs: [...dialogs], ...insightRequests(state, 'MEDT12'), after }
})

scenario('I-EDIT-CLOSE', '已有 Insight：追加正文后立即关闭页面', async ({ page, state, dialogs }) => {
  await editExistingInsightTyping(page, 'MEDTC')
  const local = await localArtifacts(page)
  await page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 700))
  return { local, dialogs: [...dialogs], ...insightRequests(state, 'MEDTC') }
})

/* ---------------- 2. Insight「取消新建」 ---------------- */

scenario('I-CANCEL-EMPTY', '取消新建：空内容（点新建后立即取消）', async ({ page, state }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  const buttonText = await page.locator('.journal-editor').getByRole('button', { name: '取消新建' }).innerText()
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建' }).click()
  await page.waitForTimeout(700)
  const body = await page.locator('body').innerText()
  return {
    buttonText,
    panelStillOpen: (await page.locator('.journal-editor').count()) > 0,
    leaveDialogVisible: body.includes('尚未保存，确定离开'),
    ...insightRequests(state),
    cards: await page.locator('.file-card').allInnerTexts(),
  }
})

scenario('I-CANCEL-TITLE', '取消新建：仅输入标题（无正文）', async ({ page, state }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor input[type="text"]').first().fill('只写了标题MCT')
  await page.waitForTimeout(300)
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建' }).click()
  await page.waitForTimeout(700)
  const body = await page.locator('body').innerText()
  return {
    panelStillOpen: (await page.locator('.journal-editor').count()) > 0,
    leaveDialogVisible: body.includes('尚未保存，确定离开'),
    dialogText: body.includes('尚未保存，确定离开') ? body.match(/最新改动还没保存成功，确定离开？|当前内容尚未保存，确定离开？/)?.[0] ?? null : null,
    ...insightRequests(state),
    cards: await page.locator('.file-card').allInnerTexts(),
  }
})

scenario('I-CANCEL-BODY', '取消新建：已输入正文', async ({ page, state }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor input[type="text"]').first().fill('打算取消的标题MCB')
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type('打算取消的正文MCB')
  await page.waitForTimeout(150)
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建' }).click()
  await page.waitForTimeout(900)
  const body = await page.locator('body').innerText()
  return {
    panelStillOpen: (await page.locator('.journal-editor').count()) > 0,
    leaveDialogVisible: body.includes('尚未保存，确定离开'),
    ...insightRequests(state, 'MCB'),
    cards: await page.locator('.file-card').allInnerTexts(),
    notice: body.includes('已保存') ? '含“已保存”字样' : '无保存提示',
  }
})

/* ---------------- 3. 日程编辑时刷新 / 关闭 ---------------- */

scenario('S-EDIT-RELOAD', '日程编辑：改标题后立即刷新', async ({ page, state, dialogs }) => {
  await scheduleEditTyping(page, '日程改标题MSE')
  const local = await localArtifacts(page)
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded' })
  const elapsed = Date.now() - t0
  await openSchedules(page)
  const body = await page.locator('body').innerText()
  return {
    elapsedMs: elapsed,
    local,
    dialogs: [...dialogs],
    ...scheduleRequests(state),
    formReopened: (await page.locator('.sched-form').count()) > 0,
    pageShowsMarker: body.includes('日程改标题MSE'),
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
  }
})

scenario('S-EDIT-SAVED-RELOAD', '日程编辑：点保存成功后再刷新（对照）', async ({ page, state, dialogs }) => {
  await scheduleEditTyping(page, '日程已保存MSS')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(600)
  const beforeReload = {
    formOpen: (await page.locator('.sched-form').count()) > 0,
    notice: (await page.locator('body').innerText()).includes('已保存修改'),
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openSchedules(page)
  const body = await page.locator('body').innerText()
  return {
    beforeReload,
    dialogs: [...dialogs],
    ...scheduleRequests(state),
    pageShowsMarker: body.includes('日程已保存MSS'),
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
  }
})

scenario('S-EDIT-CLOSE', '日程编辑：改标题后立即关闭页面', async ({ page, state, dialogs }) => {
  await scheduleEditTyping(page, '日程关闭MSC')
  const local = await localArtifacts(page)
  await page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 700))
  return { local, dialogs: [...dialogs], ...scheduleRequests(state) }
})

scenario('S-CREATE-RELOAD', '日程新建：填表单后立即刷新', async ({ page, state, dialogs }) => {
  await scheduleCreateTyping(page, '日程新建MSN')
  const local = await localArtifacts(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openSchedules(page)
  const body = await page.locator('body').innerText()
  return {
    local,
    dialogs: [...dialogs],
    ...scheduleRequests(state),
    formReopened: (await page.locator('.sched-form').count()) > 0,
    pageShowsMarker: body.includes('日程新建MSN'),
  }
})

scenario('S-EDIT-NAV', '日程编辑：站内切换模块（对照，验证离开确认）', async ({ page, state }) => {
  await scheduleEditTyping(page, '日程切页MSV')
  await nav(page, '洞察').click()
  await page.waitForTimeout(600)
  const body = await page.locator('body').innerText()
  const dialogOpen = (await page.locator('dialog.leave-dialog[open]').count()) > 0
  const text = dialogOpen ? await page.locator('dialog.leave-dialog').innerText() : ''
  if (dialogOpen) await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  return {
    dialogOpen,
    dialogText: text.slice(0, 120),
    stillOnSchedule: (await page.locator('.sched-form').count()) > 0,
    ...scheduleRequests(state),
  }
})

/* ---------------- 4. 日程创建成功 + 列表刷新失败 ---------------- */

scenario('S-LISTFAIL', '日程创建成功但列表刷新失败：计数/提示/列表/重试', async ({ page, state }) => {
  await openSchedules(page)
  const beforeCount = state.schedules.length
  const beforeTitles = await page.locator('.sched-item-title').allInnerTexts()
  state.fault.scheduleList = true
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form').waitFor()
  await page.locator('.sched-form input[type="text"]').fill('刷新失败MSF')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-06T10:00')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1200)
  const bodyAfter = await page.locator('body').innerText()
  const stateAfterFirst = {
    beforeCount,
    beforeTitles,
    serverCount: state.schedules.length,
    serverTitles: state.schedules.map((s) => s.title),
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
    successNoticeShown: bodyAfter.includes('已创建日程'),
    bannerShown: bodyAfter.includes('读取') && (bodyAfter.includes('失败') || bodyAfter.includes('刷新')),
    bannerText: (bodyAfter.match(/[^\n]*(读取失败|刷新失败|重新读取)[^\n]*/g) ?? []).slice(0, 4),
    formOpen: (await page.locator('.sched-form').count()) > 0,
    POST: scheduleRequests(state).POST,
  }
  // 第二次创建：表单已关闭，用户重新输入同名日程
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form').waitFor()
  await page.locator('.sched-form input[type="text"]').fill('刷新失败MSF')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-06T10:00')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1200)
  const afterSecond = {
    serverCount: state.schedules.length,
    serverTitles: state.schedules.map((s) => s.title),
    postKeys: scheduleRequests(state).postKeys,
    duplicateCount: state.schedules.filter((s) => s.title === '刷新失败MSF').length,
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
  }
  // 恢复网络后重新读取
  state.fault.scheduleList = false
  const retry = page.getByRole('button', { name: '重新读取', exact: true })
  if (await retry.count()) { await retry.first().click(); await page.waitForTimeout(900) }
  const afterRetry = {
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
    bannerGone: !(await page.locator('body').innerText()).includes('重新读取'),
  }
  return { first: stateAfterFirst, second: afterSecond, retry: afterRetry }
})

scenario('CTRL-DIALOG', '方法学对照：手工注册 beforeunload 后刷新，确认检查能捕获提示', async ({ page, dialogs }) => {
  await page.evaluate(() => {
    window.addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = '' })
  })
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  await page.waitForTimeout(400)
  return { dialogs: [...dialogs] }
})

async function main() {
  const allRequests = []
  const results = []
  for (const spec of scenarios) {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME })
    const state = freshState()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const dialogs = []
    const pageErrors = []
    page.on('dialog', (dialog) => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}) })
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await installMock(page, state)
    await page.goto(BASE, { waitUntil: 'networkidle' })
    let record
    try {
      const data = await spec.fn({ page, state, dialogs })
      record = { id: spec.id, name: spec.name, status: 'ok', data, pageErrors }
    } catch (error) {
      record = { id: spec.id, name: spec.name, status: 'error', error: String(error?.message ?? error), pageErrors }
    }
    allRequests.push(...state.requests.map((r) => ({ scenario: spec.id, ...r })))
    results.push(record)
    console.log(`${record.status === 'ok' ? 'OK  ' : 'ERR '} ${spec.id} ${spec.name}`)
    if (record.status === 'error') console.log('     ', record.error)
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
  writeFileSync(`${OUT}/focused-results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
  writeFileSync(`${OUT}/focused-requests.log`, allRequests.map((r) => `${r.scenario} ${r.method} ${r.path}${r.search}`).join('\n'))
  console.log('\nDONE', results.length)
}

main().catch((error) => { console.error('FATAL', error); process.exit(1) })
