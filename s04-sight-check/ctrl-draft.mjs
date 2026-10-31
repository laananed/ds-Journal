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
async function dismiss() {
  const dlg = page.locator('dialog.leave-dialog[open]')
  if (await dlg.count()) {
    const btn = page.getByRole('button',{name:'确认离开',exact:true})
    if (await btn.count()) await btn.click({force:true}).catch(()=>{})
    await page.waitForTimeout(300)
    return true
  }
  return false
}
await nav('写作').click()
await page.waitForTimeout(500)
console.log('step1 body', (await page.locator('body').innerText()).slice(0,200).replace(/\n+/g,' | '))
console.log('PM', await page.locator('.ProseMirror').count(), 'dialog', await page.locator('dialog[open]').count())
await dismiss()
const pm = page.locator('.ProseMirror').first()
if (await pm.count()) {
  await pm.click({force:true})
  await page.keyboard.type('本地草稿对照CTRL')
  await page.waitForTimeout(900)
}
const idb = await page.evaluate(async () => {
  const out = {}
  for (const info of await indexedDB.databases()) {
    const db = await new Promise((res,rej)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})
    out[info.name] = {}
    for (const name of Array.from(db.objectStoreNames)) {
      out[info.name][name] = await new Promise((res)=>{const tx=db.transaction(name,'readonly');const c=tx.objectStore(name).count();c.onsuccess=()=>res(c.result);c.onerror=()=>res(-1)})
    }
    db.close()
  }
  return out
})
const payload={ idb, label:(await page.getByRole('button',{name:/本地草稿/}).allInnerTexts()).join(','), requests: state.requests.map(r=>r.method+' '+r.path) }; writeFileSync('draft-detection-control.json', JSON.stringify(payload,null,2)); console.log(JSON.stringify(payload,null,1))
await browser.close()
