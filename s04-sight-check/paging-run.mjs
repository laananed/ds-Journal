/**
 * 日程分页边界 Mock 浏览器检查（D2 曾经出问题的区域）：
 * 第 2 页只有 1 条时删除它，页面应回退到第 1 页，而不是显示「还没有日程」。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4193/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-03/s04-sight-check'
const now = '2026-10-31T02:00:00Z'

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Programme/Google/Chrome/Application/chrome.exe'.replace('Programme/Google', 'Program Files/Google') })
  const state = freshState()
  state.schedules = Array.from({ length: 21 }, (_, index) => ({
    id: index + 1,
    title: `日程 ${String(index + 1).padStart(2, '0')}`,
    starts_at: `2026-11-${String((index % 28) + 1).padStart(2, '0')}T0${index % 9}:00:00Z`,
    ends_at: null,
    completed: false,
    revision: 1,
    created_at: now,
    updated_at: now,
  }))
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await installMock(page, state)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: '日程', exact: true }).first().click()
  await page.locator('.sched-list').waitFor()

  const report = {}
  report.第一页条目数 = (await page.locator('.sched-item-title').allInnerTexts()).length
  await page.getByRole('button', { name: '下一页' }).click()
  await page.locator('.sched-item-title').first().waitFor()
  await page.waitForTimeout(300)
  report.第二页条目 = await page.locator('.sched-item-title').allInnerTexts()
  await page.locator('.sched-item', { hasText: '日程 21' }).getByRole('button', { name: '删除' }).click()
  await page.locator('.sched-item', { hasText: '日程 21' }).getByRole('button', { name: '确认删除' }).click()
  await page.waitForTimeout(1200)
  report.删除后条目数 = (await page.locator('.sched-item-title').allInnerTexts()).length
  report.删除后是否显示空态 = (await page.locator('.sched-state').allInnerTexts()).some((t) => t.includes('还没有日程'))
  report.删除后页码提示 = (await page.locator('.sched-toolbar-meta').innerText()).trim()
  report.服务端剩余 = state.schedules.length
  report.pageErrors = errors
  writeFileSync(`${OUT}/paging-results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
