import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { freshState, installMock } from './mock-core.mjs'
const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/Free/.npm-cache/_npx/af752b90495482d7/node_modules/playwright-core')
const BASE='http://127.0.0.1:4193/'
const browser = await chromium.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'})
const nav=(p,l)=>p.getByRole('button',{name:l,exact:true}).first()

async function openNew(page){
  await nav(page,'洞察').click()
  await page.getByRole('button',{name:'新建 Insight',exact:true}).click()
  await page.locator('.journal-editor').waitFor()
}
async function run(label, fill){
  const state = freshState()
  const page = await browser.newPage({viewport:{width:1280,height:900}})
  await installMock(page,state)
  await page.goto(BASE,{waitUntil:'networkidle'})
  await openNew(page)
  if (fill) await fill(page)
  await page.locator('.journal-editor').getByRole('button',{name:'取消新建'}).click()
  await page.waitForTimeout(400)
  const dlg = page.locator('dialog.leave-dialog')
  const open = await page.locator('dialog[open]').count()
  const text = open ? (await dlg.innerText()).replace(/\n+/g,' | ') : ''
  const postsBeforeConfirm = state.requests.filter(r=>r.method==='POST').length
  if (open) { await page.getByRole('button',{name:'确认离开',exact:true}).click(); await page.waitForTimeout(600) }
  const after = {
    label,
    dialogOpen: open > 0,
    dialogText: text,
    postsBeforeConfirm,
    panelClosed: (await page.locator('.journal-editor').count()) === 0,
    serverCount: state.insights.length,
    serverTitles: state.insights.map(i=>i.display_title),
    bodyHasTitle: (await page.locator('body').innerText()).includes(label),
  }
  await page.close()
  return after
}

const out = []
out.push(await run('空取消K0', null))
out.push(await run('仅标题K1', async (p)=>{ await p.locator('.journal-editor input[type="text"]').first().fill('仅标题K1') }))
out.push(await run('正文无标题K2', async (p)=>{ await p.locator('.journal-editor .ProseMirror').last().click(); await p.keyboard.type('正文无标题K2') }))
writeFileSync('cancel-branch-results.json', JSON.stringify(out,null,2)); console.log('wrote', out.length)
await browser.close()
