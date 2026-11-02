/**
 * 独立复测：Insight / 独立日程 的修复（测试者未参与实现）。
 *
 * 全部请求由 mock-core 拦截：不连接真实后端、不写数据库、不调用模型。
 * 每个场景独立 browser / context / state；端口 4194 为本轮自建预览服务。
 *
 * 运行：
 *   node s04-sight-retest/retest-run.mjs
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4194/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-02/s04-sight-retest'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PREFIX = 'seekjournal.insight.draft.v1.'

const nav = (page, label) => page.getByRole('button', { name: label, exact: true }).first()
const insightPosts = (state) => state.requests.filter((r) => r.method === 'POST' && r.path === '/api/insights').length
const insightPatches = (state) => state.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/insights/')).length
const schedPosts = (state) => state.requests.filter((r) => r.method === 'POST' && r.path === '/api/schedules').length

async function draftKeys(page) {
  try {
    return await page.evaluate((prefix) => {
      const keys = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key !== null && key.startsWith(prefix)) keys.push(key)
      }
      return keys
    }, PREFIX)
  } catch {
    return ['<localStorage 不可访问>']
  }
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

const insightBanner = (page) => page.locator('section[aria-label="未提交的 Insight 草稿"]')

async function seedLocalRecord(page, record) {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [record.record_key, JSON.stringify(record)])
}

const scenarios = []
const scenario = (id, name, fn, init) => scenarios.push({ id, name, fn, init })

/* ================= 1. Insight 新建：自动保存窗口内刷新 ================= */

function windowScenario(id, waitMs) {
  return async ({ page, state }) => {
    await newInsightTyping(page, id)
    await page.waitForTimeout(waitMs)
    const postBeforeReload = insightPosts(state)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await nav(page, '洞察').click()
    await page.waitForTimeout(700)
    const banner = insightBanner(page)
    const bannerVisible = (await banner.count()) > 0
    const bannerText = bannerVisible ? (await banner.innerText()).replace(/\n+/g, ' | ') : ''
    const postBeforeRestore = insightPosts(state)
    // 未经用户选择不应恢复/提交
    if (!bannerVisible) {
      // 没有恢复入口：说明刷新前已保存（或草稿没写成），如实记录而不是当成编辑器打开
      return {
        waitMs,
        postBeforeReload,
        bannerVisible,
        bannerText,
        postBeforeRestore,
        savedBeforeReload: state.insights.some((item) => item.display_title.includes(id)),
        bodyText: (await page.locator('body').innerText()).slice(0, 200),
      }
    }
    await banner.getByRole('button', { name: '恢复', exact: true }).first().click()
    await page.locator('.journal-editor').waitFor({ timeout: 8000 })
    const title = await page.locator('.journal-editor input[type="text"]').first().inputValue()
    const body = await page.locator('.journal-editor .ProseMirror').last().innerText()
    await page.waitForTimeout(1500)
    const record = state.insights.find((item) => item.display_title.includes(id))
    return {
      waitMs,
      postBeforeReload,
      bannerVisible,
      bannerText: bannerText.slice(0, 140),
      postBeforeRestore,
      restoredTitle: title,
      titleOk: title.includes(id),
      bodyOk: body.includes(id),
      POST: insightPosts(state),
      createdOnServer: Boolean(record),
      serverHasBody: (record?.content ?? '').includes(id),
      draftKeysLeft: await draftKeys(page),
    }
  }
}

scenario('R1-WIN-100', '新建：输入后 100ms 刷新', windowScenario('R1', 100))
scenario('R2-WIN-450', '新建：输入后 450ms 刷新', windowScenario('R2', 450))
scenario('R3-WIN-750', '新建：输入后 750ms 刷新', windowScenario('R3', 750))

scenario('R4-SAVED-NO-BANNER', '新建：等过自动保存后刷新 → 无草稿、无提示', async ({ page, state, dialogs }) => {
  await newInsightTyping(page, 'R4')
  await page.waitForTimeout(1600)
  const postBefore = insightPosts(state)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '洞察').click()
  await page.waitForTimeout(700)
  const bannerVisible = (await insightBanner(page).count()) > 0
  const listed = await page.locator('body').innerText()
  return {
    dialogs: [...dialogs],
    postBefore,
    bannerVisible,
    listedOnList: listed.includes('标题-R4'),
    serverHasBody: (state.insights.find((i) => i.display_title.includes('R4'))?.content ?? '').includes('R4'),
    draftKeysLeft: await draftKeys(page),
  }
})

/* ================= 2. Insight 已有记录：窗口内刷新 ================= */

scenario('R5-EDIT-DETAIL-RECOVER', '已有记录：追加后立即刷新 → 提示后由用户恢复', async ({ page, state }) => {
  await openExisting(page)
  await page.getByRole('button', { name: '修改', exact: true }).click()
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('追加-R5')
  await page.waitForTimeout(150)
  const patchBeforeReload = insightPatches(state)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openExisting(page)
  const prompt = page.locator('.detail-confirm')
  let promptVisible = false
  try {
    await prompt.waitFor({ timeout: 5000 })
    promptVisible = true
  } catch { promptVisible = false }
  const promptText = promptVisible ? (await prompt.innerText()).replace(/\n+/g, ' | ') : ''
  const patchBeforeChoice = insightPatches(state)
  const serverBeforeChoice = state.insights.find((i) => i.id === 100)?.content ?? ''
  let restored = false
  if (promptVisible) {
    const btn = page.getByRole('button', { name: '恢复草稿', exact: true })
    if (await btn.count()) { await btn.click(); restored = true }
  }
  const body = await page.locator('.journal-editor .ProseMirror').last().innerText().catch(() => '')
  await page.waitForTimeout(1500)
  return {
    patchBeforeReload,
    promptVisible,
    promptText: promptText.slice(0, 160),
    patchBeforeChoice,
    serverUntouchedBeforeChoice: !serverBeforeChoice.includes('追加-R5'),
    restored,
    editorHasMarker: body.includes('追加-R5'),
    PATCH: insightPatches(state),
    serverHasMarker: (state.insights.find((i) => i.id === 100)?.content ?? '').includes('追加-R5'),
    draftKeysLeft: await draftKeys(page),
  }
})

/* ================= 3. 版本冲突 ================= */

const CONFLICT_RECORD = {
  v: 1,
  record_key: `${PREFIX}file:100`,
  draft_id: 'insight:100',
  file_id: 100,
  base_revision: 1,
  title: '旧草稿标题',
  content_doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'OLD-DRAFT-CONTENT' }] }] },
  folder_id: null,
  saved_at: Date.now() - 60_000,
}

async function setupConflict(page, state) {
  state.insights[0].revision = 2
  state.insights[0].content = 'SERVER-V2-CONTENT 参见 [[目标条目]]'
  state.insights[0].content_doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'SERVER-V2-CONTENT 参见 [[目标条目]]' }] }] }
  await seedLocalRecord(page, CONFLICT_RECORD)
}

scenario('R6-CONFLICT-VISIBLE', '冲突：提示双方版本，选择前零 PATCH', async ({ page, state }) => {
  await setupConflict(page, state)
  await openExisting(page)
  const prompt = page.locator('.detail-confirm')
  await prompt.waitFor({ timeout: 8000 })
  const text = (await prompt.innerText()).replace(/\n+/g, ' | ')
  await page.waitForTimeout(1200)
  return {
    text: text.slice(0, 220),
    mentionsV1: text.includes('v1'),
    mentionsV2: text.includes('v2'),
    PATCHafter1200: insightPatches(state),
    serverStillV2: (state.insights[0]?.content ?? '').includes('SERVER-V2'),
    serverRevision: state.insights[0]?.revision,
  }
})

scenario('R7-CONFLICT-KEEP-SERVER', '冲突：选择服务器版本 → 草稿删除、零 PATCH', async ({ page, state }) => {
  await setupConflict(page, state)
  await openExisting(page)
  await page.locator('.detail-confirm').waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '使用服务器版本', exact: true }).click()
  await page.waitForTimeout(1200)
  const body = await page.locator('.detail-title').innerText().catch(() => '')
  return {
    PATCH: insightPatches(state),
    serverStillV2: (state.insights[0]?.content ?? '').includes('SERVER-V2'),
    draftKeysLeft: await draftKeys(page),
    title: body,
  }
})

scenario('R8-CONFLICT-RESTORE-THEN-SAVE', '冲突：恢复本机草稿 → 用哪个版本基线、服务器较新正文是否保留', async ({ page, state }) => {
  await setupConflict(page, state)
  await openExisting(page)
  await page.locator('.detail-confirm').waitFor({ timeout: 8000 })
  await page.getByRole('button', { name: '恢复我的草稿', exact: true }).click()
  await page.waitForTimeout(1600)
  const patchRequests = state.requests.filter((r) => r.method === 'PATCH' && r.path === '/api/insights/100')
  const server = state.insights[0] ?? {}
  return {
    PATCH: patchRequests.length,
    patchExpectedRevision: patchRequests.map((r) => r.body?.expected_revision ?? null),
    serverRevision: server.revision,
    serverHasOldDraft: (server.content ?? '').includes('OLD-DRAFT-CONTENT'),
    serverStillHasV2: (server.content ?? '').includes('SERVER-V2'),
    // 供判断“是否保留双方内容”
    serverContent: (server.content ?? '').slice(0, 80),
  }
})

/* ================= 4. 取消新建 ================= */

scenario('R9-CANCEL-EMPTY', '空内容取消：直接关闭、零 POST、无对话', async ({ page, state }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor').getByRole('button', { name: '取消新建', exact: true }).click()
  await page.waitForTimeout(600)
  return {
    inPanelConfirm: (await page.locator('[role="alertdialog"]').count()) > 0,
    appLeaveDialog: (await page.locator('dialog.leave-dialog[open]').count()) > 0,
    panelClosed: (await page.locator('.journal-editor').count()) === 0,
    POST: insightPosts(state),
    serverCount: state.insights.length,
    textAfter: (await page.locator('body').innerText()).includes('保存失败'),
  }
})

function cancelWithWait(id, withBody, waitMs, thenContinue) {
  return async ({ page, state }) => {
    await nav(page, '洞察').click()
    await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
    await page.locator('.journal-editor').waitFor()
    await page.locator('.journal-editor input[type="text"]').first().fill(`要放弃-${id}`)
    if (withBody) {
      await page.locator('.journal-editor .ProseMirror').last().click()
      await page.keyboard.type(`要放弃的正文-${id}`)
    }
    await page.waitForTimeout(100)
    await page.locator('.journal-editor').getByRole('button', { name: '取消新建', exact: true }).click()
    await page.waitForTimeout(300)
    const confirm = page.locator('[role="alertdialog"]')
    const confirmVisible = (await confirm.count()) > 0
    const confirmText = confirmVisible ? (await confirm.innerText()).replace(/\n+/g, ' | ') : ''
    const postAtConfirm = insightPosts(state)
    await page.waitForTimeout(waitMs)
    const postWhileWaiting = insightPosts(state)
    if (thenContinue && confirmVisible) {
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      await page.waitForTimeout(1500)
      return {
        withBody,
        waitMs,
        confirmVisible,
        confirmText: confirmText.slice(0, 140),
        postAtConfirm,
        postWhileWaiting,
        afterContinue: {
          confirmGone: (await page.locator('[role="alertdialog"]').count()) === 0,
          editorStillOpen: (await page.locator('.journal-editor').count()) > 0,
          POST: insightPosts(state),
          serverHasBody: (state.insights.find((i) => i.display_title.includes(`要放弃-${id}`))?.content ?? '').includes(id),
        },
      }
    }
    if (confirmVisible) await page.getByRole('button', { name: '放弃并关闭', exact: true }).click()
    await page.waitForTimeout(700)
    return {
      withBody,
      waitMs,
      confirmVisible,
      confirmText: confirmText.slice(0, 140),
      postAtConfirm,
      postWhileWaiting,
      panelClosed: (await page.locator('.journal-editor').count()) === 0,
      POST: insightPosts(state),
      serverCount: state.insights.length,
      draftKeysLeft: await draftKeys(page),
    }
  }
}

scenario('R10-CANCEL-TITLE-WAIT', '仅标题取消：确认后等 2000ms 不得 POST', cancelWithWait('R10', false, 2000, false))
scenario('R11-CANCEL-BODY-WAIT', '有正文取消：等 2000ms 不得 POST，放弃后关闭', cancelWithWait('R11', true, 2000, false))
scenario('R11B-CANCEL-CONTINUE', '取消确认点“继续编辑”：自动保存应恢复工作', cancelWithWait('R11B', true, 900, true))

/* ================= 5. 日程：离开提示 ================= */

scenario('R12-SCHED-DIRTY-UNLOAD', '日程改标题后刷新：有提示、零 PATCH', async ({ page, state, dialogs }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.locator('.sched-item').first().getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('改标题-R12')
  await page.waitForTimeout(200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  return {
    dialogs: [...dialogs],
    beforeUnloadFired: dialogs.includes('beforeunload'),
    PATCH: state.requests.filter((r) => r.method === 'PATCH').length,
    serverTitles: state.schedules.map((s) => s.title),
  }
})

scenario('R13-SCHED-CLEAN-NO-PROMPT', '干净表单刷新：无提示（新建空表 / 编辑未改动）', async ({ page, state, dialogs }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form').waitFor()
  await page.waitForTimeout(300)
  const dialogsBefore1 = [...dialogs]
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  const afterEmptyCreate = [...dialogs]
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.locator('.sched-item').first().getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form').waitFor()
  await page.waitForTimeout(300)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(500)
  return {
    dialogsBefore1,
    dialogsAfterEmptyCreateForm: afterEmptyCreate,
    emptyCreatePrompted: afterEmptyCreate.includes('beforeunload'),
    dialogsAfterEditUntouched: [...dialogs],
    editUntouchedPrompted: dialogs.slice(afterEmptyCreate.length).includes('beforeunload'),
    POST: schedPosts(state),
    PATCH: state.requests.filter((r) => r.method === 'PATCH').length,
  }
})

scenario('R14-SCHED-SAVED-NO-PROMPT', '已保存表单刷新：无提示、内容保留、不重复创建', async ({ page, state, dialogs }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('已保存-R14')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-10T09:00')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1200)
  const dialogsBefore = [...dialogs]
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor({ timeout: 8000 })
  await page.waitForTimeout(500)
  return {
    dialogsBefore,
    promptedOnReload: dialogs.slice(dialogsBefore.length).includes('beforeunload'),
    POST: schedPosts(state),
    serverTitles: state.schedules.map((s) => s.title),
    listTitles: await page.locator('.sched-item-title').allInnerTexts(),
  }
})

scenario('R15-SCHED-LISTFAIL', '创建成功 + 列表刷新失败：新条目/提示可见，重试不重复创建', async ({ page, state }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  await page.waitForTimeout(300)
  state.fault.scheduleList = true
  await page.getByRole('button', { name: '新建日程', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('刷新失败-R15')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-11T10:00')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1500)
  const banner = page.locator('.sched-state--error')
  const bannerText = (await banner.count()) ? (await banner.innerText()).replace(/\n+/g, ' | ') : ''
  const listTitles = await page.locator('.sched-item-title').allInnerTexts()
  const body = await page.locator('body').innerText()
  const notice = (body.match(/已创建[^\n]*/g) ?? [])[0] ?? ''
  const serverCount = state.schedules.length
  const postBeforeRetry = schedPosts(state)
  state.fault.scheduleList = false
  const retry = page.getByRole('button', { name: '重新读取', exact: true })
  if (await retry.count()) await retry.first().click()
  await page.waitForTimeout(1000)
  return {
    serverCount,
    listShowsCreated: listTitles.some((t) => t.includes('R15')),
    listTitles,
    notice: notice.slice(0, 80),
    bannerText: bannerText.slice(0, 220),
    bannerMentionsReload: bannerText.includes('重新读取'),
    bannerMentionsDuplicate: bannerText.includes('重复'),
    postBeforeRetry,
    POSTafterRetry: schedPosts(state),
    afterRetryTitles: await page.locator('.sched-item-title').allInnerTexts(),
    afterRetryBannerGone: !(await page.locator('body').innerText()).includes('重新读取'),
  }
})

/* ================= 6. 回归 ================= */

scenario('R16-REG-INSIGHT', '回归：创建→自动保存→列表→重开内容一致→编辑保存', async ({ page, state }) => {
  await newInsightTyping(page, 'R16')
  await page.waitForTimeout(1600)
  await page.locator('.journal-editor').getByRole('button', { name: '返回列表', exact: true }).click()
  await page.waitForTimeout(900)
  const listed = (await page.locator('body').innerText()).includes('标题-R16')
  await page.locator('.file-card', { hasText: '标题-R16' }).first().click()
  await page.locator('.detail-title', { hasText: '标题-R16' }).waitFor({ timeout: 8000 })
  const reopened = await page.locator('.detail-title').innerText()
  await page.getByRole('button', { name: '修改', exact: true }).click()
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('再编辑-R16')
  await page.waitForTimeout(1600)
  const server = state.insights.find((i) => i.display_title.includes('R16')) ?? {}
  return {
    listed,
    reopenedTitle: reopened,
    POST: insightPosts(state),
    PATCH: insightPatches(state),
    serverHasBoth: (server.content ?? '').includes('正文-R16') && (server.content ?? '').includes('再编辑-R16'),
    draftKeysLeft: await draftKeys(page),
  }
})

scenario('R17-REG-SCHEDULE', '回归：编辑/完成/删除/409 冲突保留输入', async ({ page, state }) => {
  await nav(page, '日程').click()
  await page.locator('.sched-item').first().waitFor()
  // 编辑
  await page.locator('.sched-item').first().getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('编辑后-R17')
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1200)
  const editedTitle = state.schedules[0]?.title
  // 完成
  await page.locator('.sched-item').nth(1).getByRole('button', { name: /标记/ }).click()
  await page.waitForTimeout(1000)
  const completed = state.schedules.find((s) => s.id === 2)?.completed
  // 删除
  await page.locator('.sched-item').nth(1).getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForTimeout(300)
  await page.locator('.sched-item').nth(1).getByRole('button', { name: '确认删除', exact: true }).click()
  await page.waitForTimeout(1100)
  const afterDelete = state.schedules.map((s) => s.id)
  // 409：编辑时别处先改版本
  await page.locator('.sched-item').first().getByRole('button', { name: '编辑', exact: true }).click()
  await page.locator('.sched-form input[type="text"]').fill('冲突-R17')
  state.schedules[0].revision += 5
  await page.locator('.sched-form').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(1200)
  const body = await page.locator('body').innerText()
  const formStill = (await page.locator('.sched-form').count()) > 0
  const inputValue = formStill ? await page.locator('.sched-form input[type="text"]').inputValue() : ''
  return {
    editedTitle,
    completedBefore: true,
    completedAfter: completed,
    patchCount: state.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/schedules/')).length,
    deleteCount: state.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith('/api/schedules/')).length,
    afterDelete,
    conflict: {
      formStill,
      inputValue,
      mentionsConflict: /冲突|改变|最新/.test(body),
    },
  }
})

/* ================= 7. 浏览器存储不可用 / 写入失败 ================= */

scenario('R18-STORAGE-BLOCKED', 'localStorage 不可访问：页面可用、不宣称草稿已保存', async ({ page, state, dialogs, pageErrors }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor input[type="text"]').first().fill('无存储-R18')
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type('正文-R18')
  await page.waitForTimeout(200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '洞察').click()
  await page.waitForTimeout(700)
  const text = await page.locator('body').innerText()
  return {
    dialogs: [...dialogs],
    pageErrors: [...pageErrors],
    bannerVisible: (await insightBanner(page).count()) > 0,
    claimsDraftSaved: /草稿已保存|已保存到本机/.test(text),
    claimsListed: text.includes('标题-R18'),
  }
}, () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('storage disabled', 'SecurityError') },
  })
})

scenario('R19-STORAGE-WRITE-FAIL', 'localStorage 写入抛配额错误：编辑与服务器保存不受影响、不宣称草稿已保存', async ({ page, state, pageErrors }) => {
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor()
  await page.locator('.journal-editor input[type="text"]').first().fill('写失败-R19')
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type('正文-R19')
  await page.waitForTimeout(1600)
  const body = await page.locator('body').innerText()
  return {
    pageErrors: [...pageErrors],
    POST: insightPosts(state),
    serverHasBody: (state.insights.find((i) => i.display_title.includes('R19'))?.content ?? '').includes('R19'),
    claimsDraftSaved: /草稿已保存|已保存到本机/.test(body),
    claimsSaveFailed: /保存失败/.test(body),
  }
}, () => {
  const original = Storage.prototype.setItem
  Storage.prototype.setItem = function patched(key, value) {
    if (String(key).startsWith('seekjournal.insight.draft.')) {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    }
    return original.call(this, key, value)
  }
})

/* ================= 8. 关页重开 / 连续刷新 ================= */

scenario('R20-CLOSE-REOPEN', '新建：输入后直接关闭标签页，重开仍可恢复', async ({ page, context, state, dialogs }) => {
  await newInsightTyping(page, 'R20')
  await page.waitForTimeout(200)
  await page.close({ runBeforeUnload: true })
  await new Promise((resolve) => setTimeout(resolve, 700))
  const dialogsOnClose = [...dialogs]
  const page2 = await context.newPage()
  await installMock(page2, state)
  await page2.goto(BASE, { waitUntil: 'networkidle' })
  await nav(page2, '洞察').click()
  await page2.waitForTimeout(800)
  const banner = insightBanner(page2)
  const bannerVisible = (await banner.count()) > 0
  const postBefore = insightPosts(state)
  if (bannerVisible) await banner.getByRole('button', { name: '恢复', exact: true }).first().click()
  await page2.locator('.journal-editor').waitFor({ timeout: 8000 })
  const body = await page2.locator('.journal-editor .ProseMirror').last().innerText()
  await page2.waitForTimeout(1500)
  return {
    dialogsOnClose,
    bannerVisible,
    postBefore,
    bodyOk: body.includes('R20'),
    POST: insightPosts(state),
    serverHasBody: (state.insights.find((i) => i.display_title.includes('R20'))?.content ?? '').includes('R20'),
    draftKeysLeft: await draftKeys(page2),
  }
})

scenario('R22-DOUBLE-RELOAD', '恢复后再刷新（保存前）：草稿不能提前丢失', async ({ page, state }) => {
  await newInsightTyping(page, 'R22')
  await page.waitForTimeout(300)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '洞察').click()
  await page.waitForTimeout(700)
  const first = insightBanner(page)
  const firstVisible = (await first.count()) > 0
  if (firstVisible) await first.getByRole('button', { name: '恢复', exact: true }).first().click()
  await page.locator('.journal-editor').waitFor({ timeout: 8000 })
  // 恢复后 300ms 内再刷新：此时还没到 800ms 自动保存
  await page.waitForTimeout(300)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await nav(page, '洞察').click()
  await page.waitForTimeout(700)
  const second = insightBanner(page)
  const stillVisible = (await second.count()) > 0
  if (stillVisible) await second.getByRole('button', { name: '恢复', exact: true }).first().click()
  await page.locator('.journal-editor').waitFor({ timeout: 8000 })
  const body = await page.locator('.journal-editor .ProseMirror').last().innerText()
  await page.waitForTimeout(1600)
  return {
    firstVisible,
    stillVisible,
    bodyOk: body.includes('R22'),
    POST: insightPosts(state),
    serverHasBody: (state.insights.find((i) => i.display_title.includes('R22'))?.content ?? '').includes('R22'),
    draftKeysLeft: await draftKeys(page),
  }
})

/* ================= 运行 ================= */

async function main() {
  const only = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
  const selected = only.length === 0 ? scenarios : scenarios.filter((s) => only.some((p) => s.id.startsWith(p)))
  const results = []
  for (const spec of selected) {
    const browser = await chromium.launch({ headless: true, executablePath: CHROME })
    const state = freshState()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    if (spec.init) await context.addInitScript(spec.init)
    const page = await context.newPage()
    const dialogs = []
    const pageErrors = []
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.type())
      if (dialog.type() === 'beforeunload') await dialog.accept().catch(() => {})
      else await dialog.dismiss().catch(() => {})
    })
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await installMock(page, state)
    await page.goto(BASE, { waitUntil: 'networkidle' })
    let record
    try {
      const data = await spec.fn({ page, context, state, dialogs, pageErrors })
      record = { id: spec.id, name: spec.name, status: 'ok', data, pageErrors }
    } catch (error) {
      record = { id: spec.id, name: spec.name, status: 'error', error: String(error?.message ?? error), pageErrors }
    }
    results.push(record)
    console.log(`${record.status === 'ok' ? 'OK  ' : 'ERR '} ${spec.id} ${spec.name}`)
    if (record.status === 'error') console.log('      ', record.error)
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
  const outFile = only.length === 0 ? `${OUT}/retest-results.json` : `${OUT}/retest-partial.json`
  writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, results }, null, 2))
  const failed = results.filter((r) => r.status !== 'ok')
  console.log(`\nDONE total=${results.length} ok=${results.length - failed.length} failed=${failed.length}`)
}

main().catch((error) => { console.error('FATAL', error); process.exit(1) })
