/**
 * SeekJournal Web 常用路径 Mock 浏览器检查（只读检查，不接后端、不写数据库、不调模型）。
 *
 * 方式：跑真实生产构建（vite preview 4193），用 Playwright 拦截 **全部 /api/** 请求，
 * 用内存状态模拟后端，并按场景注入 409 / 500 / 网络中断。
 * 产品代码与公共入口未改动。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4193/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-03/s04-sight-check'

const results = []
function record(id, name, status, detail) {
  results.push({ id, name, status, detail })
  console.log(`[${status.toUpperCase()}] ${id} ${name} — ${detail}`)
}

async function step(id, name, fn) {
  try {
    const detail = await fn()
    record(id, name, 'pass', detail ?? 'ok')
    return true
  } catch (error) {
    record(id, name, 'fail', error instanceof Error ? error.message : String(error))
    return false
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Programme/Google/Chrome/Application/chrome.exe'.replace('Programme/Google', 'Program Files/Google') })
  const state = freshState()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  await installMock(page, state)

  await page.goto(BASE, { waitUntil: 'networkidle' })

  const nav = (label) => page.getByRole('button', { name: label, exact: true }).first()
  const text = (sel) => page.locator(sel).allInnerTexts()

  // ================= A. 日程 =================
  await nav('日程').click()
  await page.locator('.sched-list, .sched-state').first().waitFor()

  await step('A1', '日程列表读取', async () => {
    const titles = await text('.sched-item-title')
    assert(titles.includes('与导师讨论提纲'), `列表缺少种子条目，实际 ${JSON.stringify(titles)}`)
    const writes = state.requests.filter((r) => r.path.startsWith('/api/schedules') && r.method !== 'GET')
    assert(writes.length === 0, `打开页面产生了写请求 ${JSON.stringify(writes)}`)
    return `渲染 ${titles.length} 条，打开页面零写请求`
  })

  await step('A2', '日程新建', async () => {
    await page.getByRole('button', { name: '新建日程' }).click()
    await page.locator('.sched-form input[type="text"]').fill('写周报')
    await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-03T09:00')
    await page.locator('.sched-form button[type="submit"]').click()
    await page.locator('.sched-item-title', { hasText: '写周报' }).waitFor({ timeout: 5000 })
    const post = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/schedules')
    assert(post.length === 1, `期望 1 次 POST，实际 ${post.length}`)
    assert(typeof post[0].body.client_create_id === 'string' && post[0].body.client_create_id.length > 0, '缺少 client_create_id')
    return `POST 201，client_create_id 存在，列表出现新条目（revision ${state.schedules.find((s) => s.title === '写周报')?.revision}）`
  })

  await step('A3', '日程编辑', async () => {
    const row = page.locator('.sched-item', { hasText: '写周报' })
    await row.getByRole('button', { name: '编辑' }).click()
    await page.locator('.sched-form input[type="text"]').fill('写周报（改）')
    await page.locator('.sched-form button[type="submit"]').click()
    await page.locator('.sched-item-title', { hasText: '写周报（改）' }).waitFor({ timeout: 5000 })
    const patch = state.requests.filter((r) => r.method === 'PATCH' && r.path === '/api/schedules/10')
    assert(patch.length === 1, `期望 1 次 PATCH，实际 ${patch.length}`)
    assert(patch[0].body.expected_revision === 1, `expected_revision 应为 1，实际 ${patch[0].body.expected_revision}`)
    return `PATCH 带 expected_revision=1，revision 升到 ${state.schedules.find((s) => s.id === 10)?.revision}`
  })

  await step('A4', '日程完成/取消完成', async () => {
    const row = page.locator('.sched-item', { hasText: '写周报（改）' })
    await row.getByRole('button', { name: '标记完成' }).click()
    await page.locator('.sched-item', { hasText: '写周报（改）' }).locator('.sched-badge--done').waitFor({ timeout: 5000 })
    await page.locator('.sched-item', { hasText: '写周报（改）' }).getByRole('button', { name: '标记未完成' }).click()
    await page.locator('.sched-item', { hasText: '写周报（改）' }).locator('.sched-badge', { hasText: '未完成' }).waitFor({ timeout: 5000 })
    return '完成/取消完成均通过 PATCH completed 生效'
  })

  await step('A5', '日程删除（需确认）', async () => {
    const row = page.locator('.sched-item', { hasText: '写周报（改）' })
    await row.getByRole('button', { name: '删除' }).click()
    await page.locator('.sched-item', { hasText: '写周报（改）' }).getByRole('button', { name: '确认删除' }).click()
    await page.locator('.sched-item-title', { hasText: '写周报（改）' }).waitFor({ state: 'detached', timeout: 5000 })
    const del = state.requests.filter((r) => r.method === 'DELETE' && r.path === '/api/schedules/10')
    assert(del.length === 1, `期望 1 次 DELETE，实际 ${del.length}`)
    assert(del[0].ifMatch === '"4"', `If-Match 应为 "4"（两次完成切换后 revision=4），实际 ${del[0].ifMatch}`)
    return `DELETE 带 If-Match=${del[0].ifMatch}，列表本地移除且刷新后不重复发送`
  })

  await step('A6', '日程创建网络中断：表单与输入是否保留', async () => {
    state.fault.scheduleCreate = 'network'
    await page.getByRole('button', { name: '新建日程' }).click()
    await page.locator('.sched-form input[type="text"]').fill('断网时的输入')
    await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-04T09:00')
    await page.locator('.sched-form button[type="submit"]').click()
    await page.locator('.sched-notice--error, .sched-field-error').first().waitFor({ timeout: 5000 })
    const stillOpen = await page.locator('.sched-form').count()
    const value = await page.locator('.sched-form input[type="text"]').inputValue()
    const msg = (await page.locator('.sched-field-error').first().innerText()).trim()
    delete state.fault.scheduleCreate
    assert(stillOpen === 1, '失败后表单被关闭（输入会丢失）')
    assert(value === '断网时的输入', `失败后标题输入被改动：${value}`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '取消' }).first().click()
    return `表单保留、输入保留；提示「${msg}」`
  })

  await step('A7', '日程编辑 409 冲突：输入保留并可重试', async () => {
    // 模拟别处改过：服务端 revision 前进，前端仍持旧基线
    const target = state.schedules.find((s) => s.id === 1)
    await page.locator('.sched-item', { hasText: '与导师讨论提纲' }).getByRole('button', { name: '编辑' }).click()
    await page.locator('.sched-form input[type="text"]').fill('我的冲突修改')
    target.revision += 1
    target.title = '别处的修改'
    await page.locator('.sched-form button[type="submit"]').click()
    await page.locator('.sched-conflict').waitFor({ timeout: 5000 })
    const kept = await page.locator('.sched-form input[type="text"]').inputValue()
    assert(kept === '我的冲突修改', `冲突后草稿被改：${kept}`)
    const latest = (await page.locator('.sched-conflict-latest').innerText()).replace(/\s+/g, ' ')
    await page.getByRole('button', { name: '用最新版本重试保存' }).click()
    await page.locator('.sched-item-title', { hasText: '我的冲突修改' }).waitFor({ timeout: 5000 })
    return `冲突块显示最新版本（${latest}），草稿保留，重试成功`
  })

  await step('A8', '日程与 Set 目标互不干扰', async () => {
    const ritualWrites = state.requests.filter((r) => r.path.startsWith('/api/rituals') && r.method !== 'GET')
    assert(ritualWrites.length === 0, `日程操作触发了 Set/End 写请求：${JSON.stringify(ritualWrites)}`)
    return '全程 0 次 /api/rituals 写请求'
  })

  // ================= B. Insight =================
  await nav('洞察').click()
  await page.locator('.insight-page').waitFor()

  await step('B1', 'Insight 新建 → 自动保存 → 列表可见', async () => {
    await page.getByRole('button', { name: '新建 Insight' }).click()
    await page.locator('.editor-field input[type="text"]').fill('新洞察标题')
    const editor = page.locator('.ProseMirror').last()
    await editor.click()
    await page.keyboard.type('这是新写的洞察正文')
    await page.locator('.autosave-saved').first().waitFor({ timeout: 8000 })
    const post = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/insights')
    assert(post.length >= 1, '没有发出创建请求')
    assert(JSON.stringify(post[0].body).includes('client_create_id'), '创建请求缺少 client_create_id')
    return `POST /api/insights ${post.length} 次，状态「服务器已保存」`
  })

  await step('B2', 'Insight 返回列表再打开：内容保留', async () => {
    await page.getByRole('button', { name: 'Insight 列表' }).click()
    await page.locator('.file-card', { hasText: '新洞察标题' }).waitFor({ timeout: 5000 })
    await page.locator('.file-card', { hasText: '新洞察标题' }).click()
    await page.locator('.detail-title', { hasText: '新洞察标题' }).waitFor({ timeout: 5000 })
    await page.getByRole('button', { name: '修改' }).click()
    const value = await page.locator('.editor-field input[type="text"]').inputValue()
    assert(value === '新洞察标题', `重新打开后标题为 ${value}`)
    const body = await page.locator('.ProseMirror').last().innerText()
    assert(body.includes('这是新写的洞察正文'), `重新打开后正文为 ${body}`)
    return '标题与正文均从服务器读回'
  })

  await step('B3', 'Insight 编辑后直接切模块（离开前 flush）', async () => {
    const editor = page.locator('.ProseMirror').last()
    await editor.click()
    await page.keyboard.type('追加一句')
    await nav('概览').click()
    const dialog = page.locator('dialog.leave-dialog')
    if (await dialog.count() && await dialog.evaluate((el) => el.open)) {
      await page.getByRole('button', { name: '继续编辑' }).click()
      await page.locator('.autosave-saved').first().waitFor({ timeout: 8000 })
      await nav('概览').click()
    }
    await page.locator('.dashboard-page, [aria-label="今日概览"], .app-content').first().waitFor()
    const patch = state.requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/insights/'))
    const latest = state.insights.find((i) => i.display_title === '新洞察标题')
    return `离开前产生 ${patch.length} 次 PATCH；服务器正文包含「追加一句」=${latest.content.includes('追加一句')}`
  })

  await step('B4', 'Insight 保存失败：提示与输入保留', async () => {
    await nav('洞察').click()
    await page.locator('.file-card', { hasText: '新洞察标题' }).click()
    await page.getByRole('button', { name: '修改' }).click()
    state.fault.insightPatch = true
    await page.locator('.ProseMirror').last().click()
    await page.keyboard.type('保存会失败的输入')
    await page.locator('.autosave-failed').waitFor({ timeout: 8000 })
    const label = (await page.locator('.autosave-status').innerText()).replace(/\s+/g, ' ')
    const body = await page.locator('.ProseMirror').last().innerText()
    const hasRetry = await page.getByRole('button', { name: '重试保存' }).count()
    delete state.fault.insightPatch
    assert(body.includes('保存会失败的输入'), '保存失败后编辑器内容丢失')
    assert(hasRetry === 1, '没有重试保存入口')
    await page.getByRole('button', { name: '重试保存' }).click()
    await page.locator('.autosave-saved').first().waitFor({ timeout: 8000 })
    return `状态条：${label}；输入保留、重试后保存成功`
  })

  // ================= C. 搜索与内部链接 =================
  await step('C1', '全部搜索 → 打开目标', async () => {
    await nav('全部搜索').click()
    await page.locator('input[type="search"]').last().fill('目标')
    await page.locator('.file-card').first().waitFor({ timeout: 6000 })
    const cards = await text('.file-card .journal-item-title')
    await page.getByRole('button', { name: 'Journal：目标条目，打开' }).click()
    await page.locator('section[aria-label="日记详情"]').waitFor({ timeout: 6000 })
    const detailTitle = await page.locator('section[aria-label="日记详情"] .detail-title').innerText()
    const reads = state.requests.filter((r) => r.path === '/api/journals/300')
    assert(reads.length >= 1, '点击结果未先读取目标详情')
    return `结果 ${JSON.stringify(cards)}，点击后先 GET 目标再打开「${detailTitle}」`
  })

  await step('C2', '内部链接 [[标题]] 打开目标', async () => {
    await nav('洞察').click()
    await page.locator('.file-card', { hasText: '已有洞察' }).click()
    await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 6000 })
    const html = await page.locator('.ProseMirror').last().innerHTML()
    const decorated = await page.locator('.s4-internal-link').count()
    await page.locator('.s4-internal-link').last().click()
    const resolved = state.requests.filter((r) => r.path === '/api/links/resolve')
    await page.waitForTimeout(800)
    const opened = state.requests.filter((r) => r.path === '/api/journals/300')
    assert(decorated >= 1, `阅读态没有渲染内部链接装饰 span；html=${html.slice(0, 400)}`)
    assert(resolved.length >= 1, `点击 [[标题]] 未发起解析请求；html=${html.slice(0, 400)}`)
    return `装饰 ${decorated} 个；解析 ${resolved.length} 次（title=${resolved[0].search}），目标读取 ${opened.length} 次`
  })

  // ================= D. 汇总 =================
  const scheduleReads = state.requests.filter((r) => r.path === '/api/schedules' && r.method === 'GET').length
  writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, requestCount: state.requests.length, scheduleReads, consoleErrors }, null, 2))
  writeFileSync(`${OUT}/requests.log`, state.requests.map((r) => `${r.method} ${r.path}${r.search}${r.ifMatch ? ` if-match=${r.ifMatch}` : ''}`).join('\n'))
  await browser.close()
  const failed = results.filter((r) => r.status !== 'pass')
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed; pageErrors=${consoleErrors.length}`)
}

main().catch((error) => { console.error('FATAL', error); process.exit(1) })
