/**
 * C01 独立日程组件 —— 浏览器交叉验证脚本（测试证据工具，不是产品代码）。
 *
 * 运行：node .workbuddy/s4-c01-crosscheck/run-browser.mjs
 * 前提：夹具 dev server 已在 http://127.0.0.1:5187 运行（.workbuddy/.../harness）。
 *
 * 所有数据来自本地内存 Mock；结论只能表述为 Mock 组件验证，不是真实 HTTP/PostgreSQL 验证。
 */

import { chromium } from 'file:///C:/Users/Free/.workbuddy/skills/guizang-social-card-skill/node_modules/playwright-core/index.mjs'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:5197/harness/'
const SHOTS = 'C:/Programme/demo/SeekJournal-Work-02/evidence/c01-crosscheck/browser'
const CHROME = 'C:/Users/Free/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'

mkdirSync(SHOTS, { recursive: true })

const results = []
function record(id, name, pass, note) {
  results.push({ id, name, pass, note })
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${name}${note ? ` — ${note}` : ''}`)
}
function check(id, name, condition, note) {
  record(id, name, condition === true, note)
  return condition === true
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })

async function newPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  page.consoleErrors = consoleErrors
  return page
}

const calls = (page) => page.evaluate(() => window.__calls)
const writes = (list) => list.filter((call) => call.method === 'create' || call.method === 'update' || call.method === 'remove')

/* ============================================================ A 桌面渲染与时间展示 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=3`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  const banner = await page.locator('.sched-mock').innerText()
  check('A1', 'Mock 来源在界面明确标识', banner.includes('Mock') && banner.includes('未连接后端数据库'), banner.slice(0, 40) + '…')

  const firstTime = await page.locator('.sched-item-time').first().innerText()
  // seed 第 1 条：2026-10-30T00:00Z → 上海 08:00，同日 08:30 结束
  check('A2', 'UTC 时刻按 Asia/Shanghai 展示（00:00Z → 08:00）', firstTime.includes('2026年10月30日') && firstTime.includes('08:00') && firstTime.includes('08:30'), firstTime)

  const pageMeta = await page.locator('.sched-toolbar-meta').innerText()
  check('A3', '桌面首屏显示页码与列表', pageMeta.includes('第 1 页'), pageMeta)

  check('A4', '桌面首屏无控制台错误', page.consoleErrors.length === 0, page.consoleErrors.join(' | ').slice(0, 120))

  await page.screenshot({ path: `${SHOTS}/01-desktop-list.png`, fullPage: true })
  await page.context().close()
}

/* ============================================================ B 窄屏 */
{
  const page = await newPage(375, 760)
  await page.goto(`${BASE}?seed=3`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('B1', '窄屏 375px 无横向溢出', overflow <= 0, `scrollWidth 超出 ${overflow}px`)
  await page.screenshot({ path: `${SHOTS}/02-narrow-375-list.png`, fullPage: true })

  await page.getByRole('button', { name: '新建日程' }).click()
  await page.waitForSelector('.sched-form')
  const formOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check('B2', '窄屏表单无横向溢出', formOverflow <= 0, `超出 ${formOverflow}px`)
  await page.screenshot({ path: `${SHOTS}/03-narrow-375-form.png`, fullPage: true })
  await page.context().close()
}

/* ============================================================ C 表单校验提示 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')
  await page.getByRole('button', { name: '新建日程' }).click()

  await page.locator('button[type="submit"]').click()
  const titleErr = await page.locator('#sched-title-error').innerText()
  const startErr = await page.locator('#sched-start-error').innerText()
  check('C1', '缺标题给出明确提示', titleErr.includes('标题不能为空'), titleErr)
  check('C2', '缺开始时间给出明确提示', startErr.includes('需要开始时间'), startErr)

  const ariaInvalid = await page.locator('input[type="text"]').getAttribute('aria-invalid')
  check('C3', '错误字段标记 aria-invalid', ariaInvalid === 'true', String(ariaInvalid))

  const formErrorBefore = await page.locator('.sched-form [role="alert"]').innerText()
  check('C4', '提交失败说明不会替用户补时间', formErrorBefore.includes('不会替你补一个时间'), formErrorBefore)

  // 结束早于开始：产品给结束框设了原生 min，浏览器先拦下并给出原生提示
  await page.locator('input[type="text"]').fill('交叉测试日程')
  await page.locator('input[type="datetime-local"]').nth(0).fill('2026-10-30T14:30')
  await page.locator('input[type="datetime-local"]').nth(1).fill('2026-10-30T13:30')
  const nativeBlocked = await page.locator('input[type="datetime-local"]').nth(1).evaluate((element) => !element.validity.valid && element.validity.rangeUnderflow)
  const writesBeforeC5 = writes(await calls(page)).length
  await page.locator('button[type="submit"]').click()
  await page.waitForTimeout(200)
  check('C5', '早于开始被拦下（原生 min 提示），且不产生写入', nativeBlocked && writes(await calls(page)).length === writesBeforeC5, `rangeUnderflow=${nativeBlocked}`)

  // 结束等于开始：原生 min 允许，应落到产品自己的中文提示
  await page.locator('input[type="datetime-local"]').nth(1).fill('2026-10-30T14:30')
  await page.locator('button[type="submit"]').click()
  const endErr = await page.locator('#sched-end-error').innerText({ timeout: 5000 })
  check('C5b', '结束等于开始时给出中文明确提示', endErr.includes('结束时间必须晚于开始时间'), endErr)

  await page.locator('input[type="datetime-local"]').nth(1).fill('')
  await page.screenshot({ path: `${SHOTS}/04-form-validation-errors.png`, fullPage: true })

  // 标题码点上限
  await page.locator('input[type="text"]').fill('😀'.repeat(81))
  const counter = await page.locator('#sched-title-count').innerText()
  check('C6', '标题计数按码点显示 81/80', counter.includes('81') && counter.includes('80'), counter)
  await page.locator('button[type="submit"]').click()
  const overErr = await page.locator('#sched-title-error').innerText()
  check('C7', '超 80 码点被拦下并说明上限', overErr.includes('80'), overErr)

  await page.locator('input[type="text"]').fill('😀'.repeat(80))
  const counter80 = await page.locator('#sched-title-count').innerText()
  check('C8', '80 个 emoji 恰好达标（不被 UTF-16 误判）', counter80.includes('80'), counter80)
  await page.context().close()
}

/* ============================================================ D 创建成功与幂等键 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  const before = (await page.locator('.sched-list li').count())
  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('input[type="text"]').fill('与导师讨论提纲')
  await page.locator('input[type="datetime-local"]').nth(0).fill('2026-10-30T14:30')
  await page.locator('input[type="datetime-local"]').nth(1).fill('2026-10-30T16:00')
  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-notice')
  const notice = await page.locator('.sched-notice').innerText()
  check('D1', '创建成功给出提示且说明不影响 Set', notice.includes('已创建') && notice.includes('Set'), notice)

  const after = await page.locator('.sched-list li').count()
  check('D2', '列表条数 +1', after === before + 1, `${before} → ${after}`)

  const createCalls = (await calls(page)).filter((call) => call.method === 'create')
  check('D3', '创建请求带 client_create_id', createCalls.length === 1 && typeof createCalls[0].detail.key === 'string', JSON.stringify(createCalls.map((c) => c.detail.key)))

  const newRow = await page.locator('.sched-list li').last().innerText()
  check('D4', '新日程按上海时间展示 14:30–16:00', newRow.includes('14:30') && newRow.includes('16:00'), newRow.replace(/\n/g, ' / '))
  await page.screenshot({ path: `${SHOTS}/05-after-create.png`, fullPage: true })

  // 明确新建 → 换新键
  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('input[type="text"]').fill('第二条')
  await page.locator('input[type="datetime-local"]').nth(0).fill('2026-10-31T09:00')
  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-notice')
  const allCreates = (await calls(page)).filter((call) => call.method === 'create')
  check('D5', '显式新建使用不同创建键', allCreates.length === 2 && allCreates[0].detail.key !== allCreates[1].detail.key, `${allCreates[0]?.detail.key} vs ${allCreates[1]?.detail.key}`)
  await page.context().close()
}

/* ============================================================ E 创建失败重试复用同键 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('input[type="text"]').fill('网络失败用例')
  await page.locator('input[type="datetime-local"]').nth(0).fill('2026-10-30T18:00')
  await page.evaluate(() => { window.__failNextCreate = true })
  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-form [role="alert"]')

  const failMsg = await page.locator('.sched-form [role="alert"]').innerText()
  check('E1', '创建网络失败提示不重复创建', failMsg.includes('不会重复创建'), failMsg)
  check('E2', '失败后表单仍保留用户输入', (await page.locator('input[type="text"]').inputValue()) === '网络失败用例')
  await page.screenshot({ path: `${SHOTS}/06-create-network-failure.png`, fullPage: true })

  const firstKey = (await calls(page)).filter((call) => call.method === 'create')[0]?.detail.key
  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-notice')
  const createsAfterRetry = (await calls(page)).filter((call) => call.method === 'create')
  check('E3', '重试复用同一创建键', createsAfterRetry.length === 2 && createsAfterRetry[1].detail.key === firstKey, `${firstKey} / ${createsAfterRetry[1]?.detail.key}`)
  const rows = await page.locator('.sched-list li').count()
  check('E4', '重试后只落一条日程', rows === 2, `列表 ${rows} 条（应为 2）`)
  await page.context().close()
}

/* ============================================================ F 建议候选零写 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  const baselineWrites = writes(await calls(page)).length
  await page.locator('.sched-suggest textarea').fill('明天下午三点和导师讨论论文提纲')
  await page.getByRole('button', { name: '生成候选' }).click()
  await page.waitForSelector('.sched-candidate')

  const mood = await page.locator('.sched-mood').innerText()
  check('F1', '情绪标为推测、不作诊断、不写入', mood.includes('推测') && mood.includes('不作诊断') && mood.includes('不会写入'), mood.replace(/\n/g, ' ').slice(0, 80) + '…')
  check('F2', '候选标注未保存', (await page.locator('.sched-candidate-flag').first().innerText()).includes('未保存'))
  const afterDisplay = writes(await calls(page)).length
  check('F3', '候选显示产生零日程写', afterDisplay === baselineWrites, `写调用 ${baselineWrites} → ${afterDisplay}`)

  const noTime = await page.locator('.sched-candidate-time').first().innerText()
  check('F4', '缺时间候选明确要求补充', noTime.includes('缺少开始时间'), noTime)

  await page.getByRole('button', { name: '忽略' }).click()
  const afterDismiss = writes(await calls(page)).length
  check('F5', '取消/忽略候选仍零写', afterDismiss === baselineWrites, `写调用 ${afterDismiss}`)
  await page.screenshot({ path: `${SHOTS}/07-suggestion-candidates.png`, fullPage: true })
  await page.context().close()
}

/* ============================================================ G 候选填入表单仍需显式保存 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1&candidateStart=2026-11-01T07:00:00.000Z`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  const baselineWrites = writes(await calls(page)).length
  await page.locator('.sched-suggest textarea').fill('周日上午十点复盘')
  await page.getByRole('button', { name: '生成候选' }).click()
  await page.waitForSelector('.sched-candidate')
  await page.getByRole('button', { name: '填入表单' }).click()
  await page.waitForSelector('.sched-form')

  const filledTitle = await page.locator('input[type="text"]').inputValue()
  const filledStart = await page.locator('input[type="datetime-local"]').nth(0).inputValue()
  check('G1', '填入表单只填字段（候选时间转上海 15:00）', filledStart === '2026-11-01T15:00', `${filledTitle} / ${filledStart}`)
  check('G2', '填入表单不产生写入', writes(await calls(page)).length === baselineWrites, `写调用 ${baselineWrites}`)

  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-notice')
  const createCalls = (await calls(page)).filter((call) => call.method === 'create')
  check('G3', '只有用户点保存才创建一条日程', createCalls.length === 1, `create 调用 ${createCalls.length}`)
  await page.context().close()
}

/* ============================================================ H 模型不可用时手动日程仍可用 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1&suggest=fail`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  await page.locator('.sched-suggest textarea').fill('任意描述')
  await page.getByRole('button', { name: '生成候选' }).click()
  await page.waitForSelector('.sched-suggest [role="alert"]')
  const suggestErr = await page.locator('.sched-suggest [role="alert"]').innerText()
  check('H1', '模型失败提示且说明手动不受影响', suggestErr.includes('手动新建日程不受影响'), suggestErr)
  check('H2', '模型失败不暴露供应商原始错误', !suggestErr.includes('Mock：模型不可用'), suggestErr)
  await page.screenshot({ path: `${SHOTS}/08-suggest-failure.png`, fullPage: true })

  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('input[type="text"]').fill('模型挂了也能建')
  await page.locator('input[type="datetime-local"]').nth(0).fill('2026-11-02T08:15')
  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-notice')
  check('H3', '模型不可用时手动创建成功', (await page.locator('.sched-notice').innerText()).includes('已创建'))
  await page.context().close()
}

/* ============================================================ I CAS 冲突保留用户输入 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=2`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  const firstRow = page.locator('.sched-list li').first()
  await firstRow.getByRole('button', { name: '编辑' }).click()
  await page.waitForSelector('.sched-form')
  await page.locator('input[type="text"]').fill('冲突前的用户输入')

  // 在编辑表单打开时，用同一行「标记完成」推高 revision，制造 409
  await firstRow.getByRole('button', { name: /标记(未)?完成/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sched-notice').length > 0)
  await page.locator('button[type="submit"]').click()
  await page.waitForTimeout(600)

  const formStillOpen = await page.locator('.sched-form').count() > 0
  const keptValue = formStillOpen ? await page.locator('input[type="text"]').inputValue() : null
  check('I1', 'CAS 冲突后保留用户输入（期望：表单仍开且内容保留）', formStillOpen && keptValue === '冲突前的用户输入', formStillOpen ? `表单仍在，值=${keptValue}` : '表单已被关闭，用户输入丢失')

  const alerts = await page.locator('[role="alert"]').allInnerTexts()
  const notices = await page.locator('.sched-notice').allInnerTexts()
  const bodyTail = (await page.locator('.sched-toolbar-meta').innerText()).trim()
  check('I2', 'CAS 冲突给出可见说明', alerts.concat(notices).some((text) => text.includes('版本') || text.includes('冲突')), `alert=${JSON.stringify(alerts)} notice=${JSON.stringify(notices)} 页码=${bodyTail}`)
  await page.screenshot({ path: `${SHOTS}/09-cas-conflict.png`, fullPage: true })
  await page.context().close()
}

/* ============================================================ J 删除确认、完成切换 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=2`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')
  const row = page.locator('.sched-list li').first()

  await row.getByRole('button', { name: '删除' }).click()
  const hint = await row.locator('.sched-hint').innerText()
  check('J1', '删除需二次确认并说明硬删除/不动 Set', hint.includes('硬删除') && hint.includes('Set'), hint)
  await page.screenshot({ path: `${SHOTS}/10-delete-confirm.png`, fullPage: true })

  await row.getByRole('button', { name: '取消' }).click()
  check('J2', '取消删除不删条目', (await page.locator('.sched-list li').count()) === 2)
  check('J3', '取消删除未发出 remove 调用', (await calls(page)).filter((c) => c.method === 'remove').length === 0)

  await row.getByRole('button', { name: '删除' }).click()
  await row.getByRole('button', { name: '确认删除' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sched-list li').length === 1)
  const removeCalls = (await calls(page)).filter((c) => c.method === 'remove')
  check('J4', '确认后硬删除一条并带版本', removeCalls.length === 1 && removeCalls[0].detail.expectedRevision === 1, JSON.stringify(removeCalls))

  const remainRow = page.locator('.sched-list li').first()
  await remainRow.getByRole('button', { name: '标记完成' }).click()
  await page.waitForFunction(() => document.querySelector('.sched-badge--done') !== null)
  check('J5', '完成状态可切换并通过 PATCH 增版', (await calls(page)).filter((c) => c.method === 'update').length >= 1)
  await page.context().close()
}

/* ============================================================ K 分页 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=25`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')
  check('K1', '首页 20 条', (await page.locator('.sched-list li').count()) === 20, `${await page.locator('.sched-list li').count()} 条`)
  await page.getByRole('button', { name: '下一页' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sched-list li').length === 5)
  check('K2', '第二页 5 条', true)
  check('K3', '末页禁用下一页', await page.getByRole('button', { name: '下一页' }).isDisabled())
  await page.getByRole('button', { name: '上一页' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sched-list li').length === 20)
  check('K4', '返回上一页恢复 20 条', true)
  await page.context().close()
}

/* ============================================================ L 末页删空后的空状态 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=21`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')
  await page.getByRole('button', { name: '下一页' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.sched-list li').length === 1)
  const row = page.locator('.sched-list li').first()
  await row.getByRole('button', { name: '删除' }).click()
  await row.getByRole('button', { name: '确认删除' }).click()
  await page.waitForTimeout(700)

  const emptyText = await page.locator('.sched-state').first().innerText().catch(() => '')
  const meta = await page.locator('.sched-toolbar-meta').innerText()
  const misleading = emptyText.includes('还没有日程')
  check('L1', '末页删空后自动回到有数据的页（期望），实际未回退', misleading === false, `页码=${meta}；空状态文案="${emptyText.replace(/\n/g, ' ').slice(0, 40)}"`)
  await page.screenshot({ path: `${SHOTS}/11-empty-last-page.png`, fullPage: true })
  await page.context().close()
}

/* ============================================================ M 键盘访问 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=2`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  await page.locator('body').click()
  const tabOrder = []
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    tabOrder.push(await page.evaluate(() => {
      const active = document.activeElement
      if (active === null) return 'null'
      const tag = active.tagName.toLowerCase()
      const text = (active.textContent ?? '').trim().slice(0, 12)
      return tag === 'button' ? `button:${text}` : `${tag}:${active.getAttribute('type') ?? ''}`
    }))
  }
  check('M1', 'Tab 顺序可到达按钮与列表操作', tabOrder.slice(0, 5).join(',').includes('button'), tabOrder.join(' → '))

  let focusRing = null
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab')
    focusRing = await page.evaluate(() => {
      const active = document.activeElement
      if (active === null || active.tagName.toLowerCase() !== 'button') return null
      const style = getComputedStyle(active)
      return { text: (active.textContent ?? '').trim().slice(0, 8), outline: style.outlineStyle, width: style.outlineWidth }
    })
    if (focusRing !== null) break
  }
  check('M2', '键盘焦点落在按钮时有可见焦点环', focusRing !== null && focusRing.outline !== 'none' && parseFloat(focusRing.width) > 0, JSON.stringify(focusRing))

  // 键盘在标题输入框内回车提交表单
  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('input[type="text"]').click()
  await page.keyboard.type('键盘创建的日程')
  await page.locator('button[type="submit"]').focus()
  await page.keyboard.press('Enter')
  const submittedEnter = await page.locator('#sched-start-error').count() > 0 || (await page.locator('.sched-form [role="alert"]').count()) > 0
  check('M3', '键盘 Enter 可触发表单提交与校验反馈', submittedEnter)
  await page.screenshot({ path: `${SHOTS}/12-keyboard-form.png`, fullPage: true })
  await page.context().close()
}

/* ============================================================ O 保存载荷不含情绪字段 */
{
  const page = await newPage(1280, 900)
  const apiRequests = []
  page.on('request', (request) => {
    const url = request.url()
    // 只看真正打到后端路径的请求；/@fs/... 下的 src/api/*.ts 是模块加载，不是接口调用
    if (new URL(url).pathname.startsWith('/api/')) apiRequests.push(url)
  })
  await page.goto(`${BASE}?seed=1&candidateStart=2026-11-01T07:00:00.000Z`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')

  await page.locator('.sched-suggest textarea').fill('周日上午十点复盘')
  await page.getByRole('button', { name: '生成候选' }).click()
  await page.waitForSelector('.sched-candidate')
  await page.getByRole('button', { name: '填入表单' }).click()
  await page.locator('button[type="submit"]').click()
  await page.waitForSelector('.sched-notice')

  const createCall = (await calls(page)).filter((call) => call.method === 'create')[0]
  const expectedKeys = ['client_create_id', 'completed', 'ends_at', 'starts_at', 'title']
  check('O1', '保存载荷只有契约字段，无情绪字段', JSON.stringify(createCall.detail.keys) === JSON.stringify(expectedKeys), JSON.stringify(createCall.detail.keys))
  check('O2', '候选流程未发出任何 /api/ 请求（不触碰 Ritual/Goal）', apiRequests.length === 0, `api 请求 ${apiRequests.length} 个：${JSON.stringify(apiRequests)}`)
  await page.context().close()
}

/* ============================================================ N 建议区未注入时不出现 */
{
  const page = await newPage(1280, 900)
  await page.goto(`${BASE}?seed=1&suggest=none`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.sched-list li')
  check('N1', '未注入建议提供者时建议区整体不出现', (await page.locator('.sched-suggest').count()) === 0)
  await page.context().close()
}

await browser.close()

const passed = results.filter((item) => item.pass).length
const failed = results.length - passed
console.log(`\n合计 ${results.length} 项：通过 ${passed}，失败 ${failed}`)
writeFileSync(`${SHOTS}/browser-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), passed, failed, results }, null, 2))
process.exitCode = failed === 0 ? 0 : 1

