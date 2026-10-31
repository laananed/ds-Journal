/**
 * 「响应丢失后重试」Mock 检查：服务端已写入但响应没回来，用户重试时是否
 * 复用同一个创建键（不产生重复条目），以及输入是否还在。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4193/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-03/s04-sight-check'

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Programme/Google/Chrome/Application/chrome.exe'.replace('Programme/Google', 'Program Files/Google') })
  const state = freshState()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await installMock(page, state)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const nav = (label) => page.getByRole('button', { name: label, exact: true }).first()
  const report = {}

  // ---- 日程：响应丢失后重试 ----
  await nav('日程').click()
  await page.locator('.sched-list').waitFor()
  state.fault.scheduleCreate = 'lost'
  await page.getByRole('button', { name: '新建日程' }).click()
  await page.locator('.sched-form input[type="text"]').fill('响应丢失的日程')
  await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-07T09:00')
  await page.locator('.sched-form button[type="submit"]').click()
  await page.locator('.sched-form .sched-field-error, .sched-form-error, .sched-notice--error').first().waitFor({ timeout: 6000 })
  report.日程_失败后表单仍在 = (await page.locator('.sched-form').count()) === 1
  report.日程_失败后输入 = await page.locator('.sched-form input[type="text"]').inputValue()
  delete state.fault.scheduleCreate
  await page.locator('.sched-form button[type="submit"]').click()
  await page.locator('.sched-item-title', { hasText: '响应丢失的日程' }).waitFor({ timeout: 6000 })
  const posts = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/schedules')
  report.日程_POST次数 = posts.length
  report.日程_两次创建键相同 = posts.length >= 2 && posts[0].body.client_create_id === posts[posts.length - 1].body.client_create_id
  report.日程_服务端条目数 = state.schedules.filter((s) => s.title === '响应丢失的日程').length

  // ---- Insight：响应丢失后重试 ----
  await nav('洞察').click()
  await page.locator('.insight-page').waitFor()
  state.fault.insightCreate = 'lost'
  await page.getByRole('button', { name: '新建 Insight' }).click()
  await page.locator('.editor-field input[type="text"]').fill('响应丢失的洞察')
  await page.locator('.ProseMirror').last().click()
  await page.keyboard.type('正文内容')
  await page.locator('.autosave-failed').waitFor({ timeout: 8000 })
  report.洞察_失败后输入仍在 = (await page.locator('.ProseMirror').last().innerText()).includes('正文内容')
  delete state.fault.insightCreate
  const retry = page.getByRole('button', { name: '重试保存' })
  if (await retry.count()) await retry.click()
  else await page.getByRole('button', { name: '立即保存' }).click()
  await page.locator('.autosave-saved').first().waitFor({ timeout: 8000 })
  const iposts = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/insights')
  report.洞察_POST次数 = iposts.length
  report.洞察_两次创建键相同 = iposts.length >= 2 && iposts[0].body.client_create_id === iposts[iposts.length - 1].body.client_create_id
  report.洞察_服务端条目数 = state.insights.filter((i) => i.display_title === '响应丢失的洞察').length
  report.pageErrors = errors

  writeFileSync(`${OUT}/idempotency-results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
