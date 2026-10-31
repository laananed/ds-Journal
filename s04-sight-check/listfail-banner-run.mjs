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
await nav('日程').click()
await page.locator('.sched-item').first().waitFor()
await page.waitForTimeout(300)
state.fault.scheduleList = true
await page.getByRole('button',{name:'新建日程',exact:true}).click()
await page.locator('.sched-form input[type="text"]').fill('横幅MSB')
await page.locator('.sched-form input[type="datetime-local"]').first().fill('2026-11-07T09:00')
await page.locator('.sched-form').getByRole('button',{name:'保存',exact:true}).click()
await page.waitForTimeout(1200)
const banner = page.locator('.sched-state--error')
console.log('banner count', await banner.count())
if (await banner.count()) console.log('BANNER:', (await banner.innerText()).replace(/\n+/g,' | '))
const notice = page.locator('.sched-notice, .detail-success, [role="status"]')
console.log('notices:', (await notice.allInnerTexts()).join(' || ').slice(0,300))
console.log('list titles', await page.locator('.sched-item-title').allInnerTexts())
console.log('server', state.schedules.map(s=>s.title))
writeFileSync('listfail-banner.json', JSON.stringify({banner: await banner.count()? await banner.innerText():null, notices: await notice.allInnerTexts(), listTitles: await page.locator('.sched-item-title').allInnerTexts(), server: state.schedules.map(s=>s.title)},null,2)); await browser.close()
