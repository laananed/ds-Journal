/**
 * 修复后验证：Insight 输入窗口/取消语义/恢复，日程离开提示与列表刷新失败。
 *
 * 全部请求由 mock-core 拦截；不连接真实后端、不写数据库、不调用模型。
 * 每个场景独立 browser/context/state。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4193/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-03/s04-sight-check'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PREFIX = 'seekjournal.insight.draft.v1.'

const nav = (page, label) => page.getByRole('button', { name: label, exact: true }).first()

async function draftKeys(page) {
  return page.evaluate((prefix) => {
    const keys = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key !== null && key.startsWith(prefix)) keys.push(key)
    }
    return keys
  }, PREFIX)
}

async function newInsightTyping(page, marker) {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor({ timeout: 8000 })
  await page.locator('.journal-editor input[type="text"]').first().fill(`标题-${marker}`)
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type(`正文-${marker}`)
}

async function openExisting(page) {
  await nav(page, '洞察').click()
  await page.locator('.file-card', { hasText: '已有洞察' }).click()
  await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 8000 })
}

async function insightBanner(page) {
  return page.locator('section[aria-label="未提交的 Insight 草稿"]')
}

const scenarios = []
const scenario = (id, name, fn) => scenarios.push({ id, name, fn })

/* ---------------- 1. Insight：窗口内刷新/关闭后可恢复 ---------------- */

scenario('F1-NEW-RECOVER', '新建：输入后立即刷新 → 本机草稿可恢复并最终创建', async ({ page, state, dialogs }) => {
  await newInsightTyping(page, 'FIXNEW')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '洞察').click()
  await page.waitForTimeout(600)
  const banner = await insightBanner(page)
  const bannerVisible = (await banner.count()) > 0
  const bannerText = bannerVisible ? (await banner.innerText()).replace(/\n+/g, ' | ') : ''
  if (bannerVisible) await banner.getByRole('button', { name: '恢复', exact: true }).first().click()
  await page.locator('.journal-editor').waitFor({ timeout: 8000 })
  const editorText = await page.locator('.journal-editor .ProseMirror').last().innerText()
  await page.waitForTimeout(1400)
  const record = state.insights.find((item) => item.display_title.includes('FIXNEW'))
  return {
    dialogs: [...dialogs],
    bannerVisible,
    bannerText: bannerText.slice(0, 160),
    editorShowsMarker: editorText.includes('FIXNEW'),
    POST: state.requests.filter((r) => r.method === 'POST' && r.path === '/api/insights').length,
    createdOnServer: Boolean(record),
    serverHasBody: (record?.content ?? '').includes('FIXNEW'),
    draftKeysLeft: await draftKeys(page),
  }
})

scenario('F2-EDIT-RECOVER', '已有记录：追加后立即刷新 → 恢复后保存到服务器', async ({ page, state, dialogs }) => {
  await openExisting(page)
  await page.getByRole('button', { name: '修改', exact: true }).click()
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('追加-FIXEDIT')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '洞察').click()
  await page.waitForTimeout(600)
  const banner = await insightBanner(page)
  const bannerVisible = (await banner.count()) > 0
  if (bannerVisible) await banner.getByRole('button', { name: '恢复', exact: true }).first().click()
  const restoreBtn = page.getByRole('button', { name: '恢复草稿', exact: true })
  await restoreBtn.waitFor({ timeout: 8000 })
  await restoreBtn.click()
  const editorText = await page.locator('.journal-editor .ProseMirror').last().innerText()
  await page.waitForTimeout(1400)
  const server = state.insights.find((item) => item.id === 100)
  return {
    dialogs: [...dialogs],
    bannerVisible,
    editorShowsMarker: editorText.includes('FIXEDIT'),
    PATCH: state.requests.filter((r) => r.method === 'PATCH' && r.path === '/api/insights/100').length,
    serverHasBody: (server?.content ?? '').includes('FIXEDIT'),
    draftKeysLeft: await draftKeys(page),
  }
})

scenario('F3-CONFLICT-GUARD', '已有记录：本机草稿基于旧版本 → 冲突提示，不自动覆盖', async ({ page, state }) => {
  const key = `${PREFIX}file:100`
  const record = {
    v: 1,
    draft_id: 'insight:100',
    file_id: 100,
    base_revision: 1,
    title: '旧草稿标题',
    content_doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OLD-DRAFT-CONTENT' }] }] },
    folder_id: null,
    saved_at: Date.now() - 60_000,
  }
  await page.evaluate(([k, value]) => localStorage.setItem(k, value), [key, JSON.stringify(record)])
  await openExisting(page)
  const prompt = page.locator('.detail-confirm')
  await prompt.waitFor({ timeout: 8000 })
  const promptText = (await prompt.innerText()).replace(/\n+/g, ' | ')
  const patchedBeforeChoice = state.requests.filter((r) => r.method === 'PATCH').length
  const serverBefore = state.insights.find((item) => item.id === 100)?.content ?? ''
  await page.getByRole('button', { name: '使用服务器版本', exact: true }).click()
  await page.waitForTimeout(800)
  const serverAfter = state.insights.find((item) => item.id === 100)?.content ?? ''
  return {
    promptText: promptText.slice(0, 220),
    mentionsVersions: promptText.includes('v1') && promptText.includes('v2'),
    patchedBeforeChoice,
    serverUnchanged: serverBefore === serverAfter,
    draftKeysLeft: await draftKeys(page),
  }
})

scenario('F4-CLOSE-RECOVER', '新建：输入后关闭页面 → 有提示，重开仍能恢复', async ({ page, context, state, dialogs }) => {
  await newInsightTyping(page, 'FIXCLOSE')
  await page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 600))
  const dialogsAfterClose = [...dialogs]
  const page2 = await context.newPage()
  await installMock(page2, state)
  await page2.goto(BASE, { waitUntil: 'networkidle' })
  await nav(page2, '洞察').click()
  await page2.waitForTimeout(600)
  const banner = await insightBanner(page2)
  const bannerVisible = (await banner.count()) > 0
  const bannerText = bannerVisible ? (await banner.innerText()).replace(/\n+/g, ' | ') : ''
  if (bannerVisible) await banner.getByRole('button', { name: '恢复', exact: true }).first().click()
  await page2.locator('.journal-editor').waitFor({ timeout: 8000 })
  const text = await page2.locator('.journal-editor .ProseMirror').last().innerText()
  return {
    dialogsAfterClose,
    bannerVisible,
    bannerText: bannerText.slice(0, 120),
    editorShowsMarker: text.includes('FIXCLOSE'),
    POSTbeforeRestore: state.requests.filter((r) => r.method === 'POST').length,
  }
})

scenario('F12-BLANK-NAV', '空新建：返回列表/刷新都不弹假失败', async ({ page, state, dialogs }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor').getByRole('button', { name: '返回列表', exact: true }).click()
  await page.waitForTimeout(500)
  const appDialog = (await page.locator('dialog.leave-dialog[open]').count()) > 0
  const panelClosed = (await page.locator('.journal-editor').count()) === 0
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)
  return {
    appDialog,
    panelClosed,
    dialogs: [...dialogs],
    POST: state.requests.filter((r) => r.method === 'POST').length,
    draftKeysLeft: await draftKeys(page),
    serverCount: state.insights.length,
  }
})

/* ---------------- 2. 取消新建 ---------------- */

scenario('F5-CANCEL-EMPTY', '取消新建：空内容直接关闭，无“保存失败”误报、无 POST', async ({ page, state, dialogs }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建', exact: true }).click()
  await page.waitForTimeout(500)
  return {
    dialogs: [...dialogs],
    panelClosed: (await page.locator('.journal-editor').count()) === 0,
    appLeaveDialog: (await page.locator('dialog.leave-dialog[open]').count()) > 0,
    inPanelConfirm: (await page.locator('[role="alertdialog"]').count()) > 0,
    POST: state.requests.filter((r) => r.method === 'POST').length,
    serverCount: state.insights.length,
  }
})

scenario('F6-CANCEL-CONTENT', '取消新建：有正文先确认，确认后不创建、不留草稿', async ({ page, state }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor input[type="text"]').first().fill('要放弃的标题FIXC')
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type('要放弃的正文FIXC')
  await page.waitForTimeout(400)
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建', exact: true }).click()
  await page.waitForTimeout(400)
  const confirmVisible = (await page.locator('[role="alertdialog"]').count()) > 0
  const confirmText = confirmVisible ? (await page.locator('[role="alertdialog"]').innerText()).replace(/\n+/g, ' | ') : ''
  const postBeforeConfirm = state.requests.filter((r) => r.method === 'POST').length
  // 超过 800ms 自动保存窗口：确认框未决时也不能落库
  await page.waitForTimeout(1200)
  const postWhileWaiting = state.requests.filter((r) => r.method === 'POST').length
  if (confirmVisible) await page.getByRole('button', { name: '放弃并关闭', exact: true }).click()
  await page.waitForTimeout(600)
  return {
    confirmVisible,
    confirmText: confirmText.slice(0, 120),
    postBeforeConfirm,
    postWhileWaiting,
    panelClosed: (await page.locator('.journal-editor').count()) === 0,
    POST: state.requests.filter((r) => r.method === 'POST').length,
    serverCount: state.insights.length,
    draftKeysLeft: await draftKeys(page),
  }
})

scenario('F7-CANCEL-TITLE', '取消新建：仅标题 → 面板内确认，不是“保存失败”', async ({ page, state }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor input[type="text"]').first().fill('只有标题FIXT')
  await page.waitForTimeout(300)
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建', exact: true }).click()
  await page.waitForTimeout(400)
  const confirmText = (await page.locator('[role="alertdialog"]').innerText().catch(() => '')).replace(/\n+/g, ' | ')
  const appDialogText = await page.locator('dialog.leave-dialog[open]').innerText().catch(() => '')
  if (await page.getByRole('button', { name: '放弃并关闭', exact: true }).count()) {
    await page.getByRole('button', { name: '放弃并关闭', exact: true }).click()
  }
  await page.waitForTimeout(500)
  return {
    confirmText: confirmText.slice(0, 120),
    appDialogText: appDialogText.slice(0, 80),
    POST: state.requests.filter((r) => r.method === 'POST').length,
    serverCount: state.insights.length,
    panelClosed: (await page.locator('.journal-editor').count()) === 0,
  }
})

/* ---------------- 3. 日程离开提示 ---------------- */

scenario('F8-SCHED-RELOAD', '日程编辑：改标题后刷新 → 浏览器离开提示', async ({ page, state, dialogs }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.locator('.sched-item', { hasText: '与导师讨论提纲' }).getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('改标题FIXS')
  await page.waitForTimeout(200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  return {
    dialogs: [...dialogs],
    formReopened: (await page.locator('.sched-form').count()) > 0,
    PATCH: state.requests.filter((r) => r.method === 'PATCH').length,
    serverTitles: state.schedules.map((s) => s.title),
  }
})

scenario('F9-SCHED-SAVED', '日程编辑：保存成功后刷新 → 不再提示、内容保留', async ({ page, state, dialogs }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.locator('.sched-item', { hasText: '与导师讨论提纲' }).getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('已保存FIXSAVE')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(700)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  return {
    dialogs: [...dialogs],
    PATCH: state.requests.filter((r) => r.method === 'PATCH').length,
    serverTitles: state.schedules.map((s) => s.title),
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
  }
})

scenario('F10-SCHED-CREATE-RELOAD', '日程新建：填表后刷新 → 浏览器离开提示', async ({ page, state, dialogs }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('新建FIXNEWS')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-08T09:00')
  await page.waitForTimeout(200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  return {
    dialogs: [...dialogs],
    formReopened: (await page.locator('.sched-form').count()) > 0,
    POST: state.requests.filter((r) => r.method === 'POST').length,
    serverCount: state.schedules.length,
  }
})

/* ---------------- 4. 创建成功但列表刷新失败 ---------------- */

scenario('F11-LISTFAIL-VISIBLE', '列表刷新失败：新条目可见、提示明确、重试可恢复', async ({ page, state }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.waitForTimeout(300)
  state.fault.scheduleList = true
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('刷新失败FIXF')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-09T10:00')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1300)
  const body = await page.locator('body').innerText()
  const banner = page.locator('.sched-state--error')
  const bannerText = (await banner.count()) ? (await banner.innerText()).replace(/\n+/g, ' | ') : ''
  const listTitles = await page.locator('.sched-item-title').allInnerTexts()
  const notice = (body.match(/已创建[^\n]*/g) ?? [])[0] ?? ''
  const serverCount = state.schedules.length
  state.fault.scheduleList = false
  const retry = page.getByRole('button', { name: '重新读取', exact: true })
  if (await retry.count()) await retry.first().click()
  await page.waitForTimeout(900)
  return {
    serverCount,
    listShowsCreated: listTitles.some((title) => title.includes('FIXF')),
    listTitles,
    notice: notice.slice(0, 80),
    bannerText: bannerText.slice(0, 200),
    bannerMentionsReload: bannerText.includes('重新读取'),
    afterRetryTitles: await page.locator('.sched-item-title').allInnerTexts(),
    afterRetryBannerGone: !(await page.locator('body').innerText()).includes('重新读取'),
  }
})

async function main() {
  const results = []
  for (const spec of scenarios) {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME })
    const state = freshState()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const dialogs = []
    const pageErrors = []
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type())
      // beforeunload 只有 accept 才会真正离开；dismiss 会停在原页导致 reload 超时。
      if (dialog.type() === 'beforeunload') await dialog.accept().catch(() => {})
      else await dialog.dismiss().catch(() => {})
    })
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await installMock(page, state)
    await page.goto(BASE, { waitUntil: 'networkidle' })
    let record
    try {
      const data = await spec.fn({ page, context, state, dialogs })
      record = { id: spec.id, name: spec.name, status: 'ok', data, pageErrors }
    } catch (error) {
      record = { id: spec.id, name: spec.name, status: 'error', error: String(error?.message ?? error), pageErrors }
    }
    results.push(record)
    console.log(`${record.status === 'ok' ? 'OK  ' : 'ERR '} ${spec.id} ${spec.name}`)
    if (record.status === 'error') console.log('     ', record.error)
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
  writeFileSync(`${OUT}/fix-verify-results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2))
  console.log('\nDONE', results.length)
}

main().catch((error) => { console.error('FATAL', error); process.exit(1) })
