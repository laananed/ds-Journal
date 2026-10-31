/**
 * SeekJournal Web 边界/故障路径 Mock 浏览器检查。
 *
 * 目的：找**日常使用会遇到的阻塞或输入丢失**，而不是只走通主流程。
 * 全部走真实生产构建 + Playwright 拦截 /api/**，不接后端、不写数据库、不调模型。
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
  try { record(id, name, 'pass', await fn()) } catch (error) {
    record(id, name, 'fail', error instanceof Error ? error.message : String(error))
  }
}
function assert(condition, message) { if (!condition) throw new Error(message) }

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' })
  const state = freshState()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const pageErrors = []
  const dialogs = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('dialog', async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss() })
  await installMock(page, state)
  await page.goto(BASE, { waitUntil: 'networkidle' })

  const nav = (label) => page.getByRole('button', { name: label, exact: true }).first()
  const dialogOpen = async () => {
    const dialog = page.locator('dialog.leave-dialog')
    return (await dialog.count()) ? await dialog.evaluate((el) => el.open) : false
  }
  const dismissByKeep = async () => {
    if (await dialogOpen()) await page.getByRole('button', { name: '继续编辑' }).click()
  }

  // ---------- E1: 日程表单 + 浏览器刷新 ----------
  await nav('日程').click()
  await page.locator('.sched-list').waitFor()
  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('.sched-form input[type="text"]').fill('刷新前的日程输入')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-05T09:00')
  await step('E1', '日程表单未保存时浏览器刷新', async () => {
    const guarded = await page.evaluate(() => {
      const event = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    await page.reload({ waitUntil: 'networkidle' })
    await nav('日程').click()
    await page.locator('.sched-state, .sched-list').first().waitFor()
    const formOpen = await page.locator('.sched-form').count()
    const restored = (await page.locator('body').innerText()).includes('刷新前的日程输入')
    return JSON.stringify({
      beforeunload被拦截: guarded,
      原生对话框: dialogs,
      刷新后表单仍打开: formOpen === 1,
      刷新后输入恢复: restored,
      结论: guarded || restored ? '有保护' : '无保护，输入随刷新静默丢失',
    })
  })

  // ---------- E2: 日程编辑中切换模块 ----------
  await step('E2', '日程编辑中切换模块是否提示未保存', async () => {
    await page.locator('.sched-item', { hasText: '与导师讨论提纲' }).getByRole('button', { name: '编辑' }).click()
    await page.locator('.sched-form input[type="text"]').fill('切换模块前的内容')
    await nav('概览').click()
    if (!(await dialogOpen())) {
      const gone = (await page.locator('.sched-form').count()) === 0
      return JSON.stringify({ 出现未保存确认: false, 表单已销毁: gone })
    }
    const title = (await page.locator('dialog.leave-dialog h2').innerText()).trim()
    await dismissByKeep()
    const kept = await page.locator('.sched-form input[type="text"]').inputValue()
    await page.getByRole('button', { name: '取消' }).first().click()
    await dismissByKeep()
    return JSON.stringify({ 出现未保存确认: true, 标题: title, 继续编辑后输入: kept })
  })

  // ---------- E3: 日程创建成功但列表刷新失败 ----------
  await step('E3', '日程创建成功、列表刷新失败', async () => {
    await nav('日程').click()
    await page.locator('.sched-list').waitFor()
    const before = (await page.locator('.sched-item-title').allInnerTexts()).length
    state.fault.scheduleList = 'network'
    await page.getByRole('button', { name: '新建日程' }).click()
    await page.locator('.sched-form input[type="text"]').fill('刷新失败的日程')
    await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-06T09:00')
    await page.locator('.sched-form button[type="submit"]').click()
    await page.locator('.sched-notice').first().waitFor({ timeout: 6000 })
    await page.waitForTimeout(600)
    const notice = (await page.locator('.sched-notice').first().innerText()).trim()
    const bannerText = await page.locator('.sched-state--error').allInnerTexts()
    const titles = await page.locator('.sched-item-title').allInnerTexts()
    delete state.fault.scheduleList
    return JSON.stringify({
      成功提示: notice,
      刷新失败横幅: bannerText.length > 0 ? bannerText[0].split('\n')[0] : null,
      列表条目: titles,
      新建条目是否出现在列表: titles.includes('刷新失败的日程'),
      创建前条目数: before,
      服务端是否已创建: state.schedules.some((s) => s.title === '刷新失败的日程'),
    })
  })

  // ---------- E4: Insight 新建后点「取消新建」 ----------
  await step('E4', 'Insight 新建后点「取消新建」是否仍写入', async () => {
    await page.getByRole('button', { name: '重新读取' }).first().click().catch(() => {})
    await nav('洞察').click()
    await page.locator('.insight-page').waitFor()
    await page.getByRole('button', { name: '新建 Insight' }).click()
    await page.locator('.editor-field input[type="text"]').fill('我想取消的洞察')
    await page.locator('.ProseMirror').last().click()
    await page.keyboard.type('本来只想放弃的正文')
    await page.getByRole('button', { name: '取消新建' }).click()
    await page.waitForTimeout(1200)
    const posts = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/insights')
      .filter((r) => (r.body?.title ?? '') === '我想取消的洞察')
    const created = state.insights.some((i) => i.display_title === '我想取消的洞察')
    return JSON.stringify({ 该标题POST次数: posts.length, 服务器已创建: created, 结论: created ? '「取消新建」仍保存成新文件（与按钮语义相反）' : '按取消语义处理' })
  })

  // ---------- E5: Insight 版本冲突 ----------
  await step('E5', 'Insight 保存 409 冲突：提示与输入保留', async () => {
    await page.locator('.file-card', { hasText: '已有洞察' }).click()
    await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 6000 })
    await page.getByRole('button', { name: '修改' }).click()
    state.fault.insightConflict = true
    await page.locator('.ProseMirror').last().click()
    await page.keyboard.type('冲突时的本地输入')
    await page.locator('.autosave-conflict').waitFor({ timeout: 8000 })
    const banner = (await page.locator('.autosave-status').innerText()).replace(/\s+/g, ' ')
    const body = await page.locator('.ProseMirror').last().innerText()
    delete state.fault.insightConflict
    const keep = await page.getByRole('button', { name: '用我的草稿重试' }).count()
    const take = await page.getByRole('button', { name: '采用服务器版本' }).count()
    // 收尾：采用服务器版本，避免残留 dirty 影响后续场景
    if (take === 1) {
      await page.getByRole('button', { name: '采用服务器版本' }).click()
      await page.waitForTimeout(800)
    }
    return JSON.stringify({ 状态条: banner, 输入仍保留: body.includes('冲突时的本地输入'), 提供重试: keep === 1, 提供采用服务器: take === 1 })
  })

  // ---------- E6: 搜索点击已删除结果 ----------
  await step('E6', '搜索点击已失效结果（404）', async () => {
    await dismissByKeep()
    await nav('全部搜索').click()
    await page.locator('input[type="search"]').last().fill('目标')
    await page.locator('.file-card').first().waitFor({ timeout: 6000 })
    state.journals = []
    await page.getByRole('button', { name: 'Journal：目标条目，打开' }).click()
    await page.locator('.detail-state').first().waitFor({ timeout: 6000 })
    const notice = (await page.locator('.detail-state').first().innerText()).trim()
    return JSON.stringify({ notice, 结论: notice.includes('已不存在') ? '明确提示并重新查询' : '提示不明确' })
  })

  // ---------- E7: 内部链接无候选 ----------
  await step('E7', '内部链接找不到目标时的表现', async () => {
    await dismissByKeep()
    await nav('洞察').click()
    await page.locator('.file-card', { hasText: '已有洞察' }).click()
    await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 6000 })
    await page.locator('.s4-internal-link').last().click()
    await page.waitForTimeout(800)
    const body = await page.locator('body').innerText()
    const journalsAfter = state.journals.length
    return JSON.stringify({ 显示找不到目标: body.includes('找不到目标'), 自动新建记录: journalsAfter > 0 })
  })

  // ---------- E8: Insight 保存失败后离开（放在最后：会留下失败会话） ----------
  await step('E8', 'Insight 保存持续失败后能否离开', async () => {
    await dismissByKeep()
    await page.locator('.file-card', { hasText: '已有洞察' }).click()
    await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 6000 })
    await page.getByRole('button', { name: '修改' }).click()
    state.fault.insightPatch = true
    await page.locator('.ProseMirror').last().click()
    await page.keyboard.type('始终保存不上的输入')
    await page.locator('.autosave-failed').waitFor({ timeout: 8000 })
    const label = (await page.locator('.autosave-status').innerText()).replace(/\s+/g, ' ')
    await nav('概览').click()
    if (!(await dialogOpen())) {
      const bodyNow = await page.locator('body').innerText()
      delete state.fault.insightPatch
      return JSON.stringify({ 状态条: label, 出现离开确认: false, 是否切走: bodyNow.includes('今日') })
    }
    const dialogTitle = (await page.locator('dialog.leave-dialog h2').innerText()).trim()
    const dialogBody = (await page.locator('dialog.leave-dialog p').first().innerText()).trim()
    await page.getByRole('button', { name: '继续编辑' }).click()
    const stillThere = (await page.locator('.ProseMirror').last().innerText()).includes('始终保存不上的输入')
    // 确认离开，验证「明确放弃」路径
    await nav('概览').click()
    await page.getByRole('button', { name: '确认离开' }).click()
    await page.waitForTimeout(600)
    const left = (await page.locator('.insight-page').count()) === 0
    delete state.fault.insightPatch
    return JSON.stringify({ 状态条: label, 出现离开确认: true, 对话框标题: dialogTitle, 对话框说明: dialogBody, 继续编辑后输入仍在: stillThere, 确认离开后已切走: left })
  })

  writeFileSync(`${OUT}/edge-results.json`, JSON.stringify({ results, pageErrors, dialogs }, null, 2))
  await browser.close()
  const failed = results.filter((r) => r.status !== 'pass')
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} scenarios completed; pageErrors=${pageErrors.length}`)
}

main().catch((error) => { console.error('FATAL', error); process.exit(1) })
