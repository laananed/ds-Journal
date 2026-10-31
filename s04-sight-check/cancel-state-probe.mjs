import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')
const BASE='http://127.0.0.1:4193/'
const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'})
const state = freshState()
const page = await browser.newPage({viewport:{width:1280,height:900}})
await installMock(page,state)
await page.goto(BASE,{waitUntil:'networkidle'})
const nav=(l)=>page.getByRole('button',{name:l,exact:true}).first()
await nav('洞察').click()
await page.getByRole('button',{name:'新建 Insight',exact:true}).click()
await page.locator('.journal-editor').waitFor()
await page.waitForTimeout(1000)
const banner = page.locator('.autosave-status')
const initial = { text: (await banner.innerText()).replace(/\n+/g,' | '), cls: await banner.getAttribute('class') }
const requests = state.requests.map(r=>r.method+' '+r.path)
writeFileSync('cancel-initial-state.json', JSON.stringify({ initial, requests, serverCount: state.insights.length }, null, 2))
console.log(JSON.stringify({ initial, requests, serverCount: state.insights.length }, null, 1))
await browser.close()
