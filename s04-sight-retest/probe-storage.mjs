/**
 * 定向探针：浏览器存储不可用 / 写入失败时，界面状态文案是否如实。
 *
 * 不是通过/失败断言，而是把当时的可见文案原样取回来，供人工判断
 * “是否错误地宣称草稿已保存”。
 */
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')

const BASE = 'http://127.0.0.1:4194/'
const OUT = 'C:/Programme/demo/SeekJournal-Work-02/s04-sight-retest'
const CHROME = 'C:/Programme/demo/SeekJournal-Work-03/../../Program Files/Google/Chrome/Application/chrome.exe'
const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const nav = (page, label) => page.getByRole('button', { name: label, exact: true }).first()

async function run(label, init) {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH })
  const state = freshState()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await installMock(page, state)
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await nav(page, '洞察').click()
  await page.getByRole('button', { name: '新建 Insight', exact: true }).click()
  await page.locator('.journal-editor').waitFor({ timeout: 8000 })
  await page.locator('.journal-editor input[type="text"]').first().fill('状态探针')
  await page.locator('.journal-editor .ProseMirror').last().click()
  await page.keyboard.type('正文-状态探针')
  await page.waitForTimeout(300)
  const editorAt300 = (await page.locator('.journal-editor').innerText()).replace(/\n+/g, ' | ')
  await page.waitForTimeout(1600)
  const editorAt1900 = (await page.locator('.journal-editor').innerText()).replace(/\n+/g, ' | ')
  const pages = await page.evaluate(() => {
    try { return localStorage.length } catch { return 'BLOCKED' }
  })
  await page.waitForTimeout(200)
  await page.locator('.journal-editor').getByRole('button', { name: '返回列表', exact: true }).click()
  await page.waitForTimeout(800)
  const listText = (await page.locator('body').innerText()).replace(/\n+/g, ' | ')
  writeFileSync(`${OUT}/probe-${label}.json`, JSON.stringify({
    label, pageErrors, localStorageLength: pages,
    editorAt300: editorAt300.slice(0, 600),
    editorAt1900: editorAt1900.slice(0, 600),
    listText: listText.slice(0, 600),
    POST: state.requests.filter((r) => r.method === 'POST').length,
    serverCount: state.insights.length,
  }, null, 2))
  console.log(`${label}: pageErrors=${pageErrors.length} localStorageLength=${pages} POST=${state.requests.filter((r) => r.method === 'POST').length}`)
  await context.close()
  await browser.close()
}

await run('blocked', () => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('storage disabled', 'SecurityError') },
  })
})

await run('writefail', () => {
  const original = Storage.prototype.setItem
  Storage.prototype.setItem = function patched(key, value) {
    if (String(key).startsWith('seekjournal.insight.draft.')) {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    }
    return original.call(this, key, value)
  }
})

console.log('DONE')
