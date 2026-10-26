import { chromePath } from './lib/chrome.mjs'
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
const browser=await puppeteer.launch({executablePath:chromePath(),headless:'shell',args:['--no-sandbox','--disable-dev-shm-usage']})
let failures=0
try{
 for(const [name,proof] of [
  ['Invented localStorage identity',{userId:'LOOKUP',lotId:'LOOKUP'}],
  ['Expired persisted identity',{userId:'LOOKUP',lotId:'LOOKUP',expires:1}],
  ['Fabricated session token',{userId:'LOOKUP',lotId:'LOOKUP',token:'attacker-signed-nothing',authVersion:999999}],
 ]){
  const context=await browser.createBrowserContext(),page=await context.newPage()
  try{
   await page.goto(process.env.BASE||'http://127.0.0.1:4186/',{waitUntil:'domcontentloaded'});await page.waitForSelector('.auth')
   const ids=await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('monparking');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,t=db.transaction('users'),get=t.objectStore('users').index('username').get('admin');get.onsuccess=()=>resolve({userId:get.result.id,lotId:get.result.lotId});t.oncomplete=()=>db.close()}}))
   await page.evaluate(p=>localStorage.setItem('mp_session',JSON.stringify(p)),{...proof,...ids})
   await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.auth,.sidebar')
   assert.equal(await page.$('.sidebar'),null,'A persisted client identity must never authenticate the user')
   assert(await page.$('.auth'));console.log('PASS',name,'rejected')
  }catch(e){failures++;console.error('FAIL',name,e.message)}finally{await context.close()}
 }
}finally{await browser.close()}
console.log(`PERSISTED PROOF: ${3-failures} passed / ${failures} failed`);process.exitCode=failures?1:0
