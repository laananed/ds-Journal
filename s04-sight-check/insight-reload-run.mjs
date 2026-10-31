/**
 * Insight 输入后立即刷新页面的检查（自动保存 800ms 防抖窗口内的输入是否丢失）。
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

  await nav('洞察').click()
  await page.locator('.file-card', { hasText: '已有洞察' }).click()
  await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 6000 })
  await page.getByRole('button', { name: '修改' }).click()
  await page.locator('.ProseMirror').last().click()
  await page.keyboard.type('刷新前刚敲的字')
  // 不等自动保存（800ms 防抖）立刻刷新
  await page.reload({ waitUntil: 'networkidle' })
  await nav('洞察').click()
  await page.locator('.file-card', { hasText: '已有洞察' }).click()
  await page.locator('.detail-title', { hasText: '已有洞察' }).waitFor({ timeout: 6000 })
  const serverText = state.insights.find((i) => i.id === 100).content
  const pageText = await page.locator('.ProseMirror').last().innerText()
  report.刷新前未等自动保存 = true
  report.服务器正文是否包含新输入 = serverText.includes('刷新前刚敲的字')
  report.页面是否显示新输入 = pageText.includes('刷新前刚敲的字')
  report.是否有任何恢复提示 = (await page.locator('body').innerText()).includes('草稿')
  report.PATCH次数 = state.requests.filter((r) => r.method === 'PATCH').length
  report.pageErrors = errors
  writeFileSync(`${OUT}/insight-reload-results.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
