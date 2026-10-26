import { chromePath } from './lib/chrome.mjs'
import { cookieName } from '../server/http.mjs'
// v16 : le sondage de session cote application est de 15 s ; toute attente
// plus courte produit un faux negatif apres revocation.
const REVOCATION_TIMEOUT=30000
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'
const browser=await puppeteer.launch({executablePath:chromePath(),headless:'shell',protocolTimeout:45000,defaultViewport:{width:1440,height:1000},args:['--no-sandbox','--disable-dev-shm-usage']})
const base=process.env.BASE||'http://127.0.0.1:4200/',SESSION_COOKIE=cookieName(base)
let count=0
const ok=name=>{count++;console.log('PASS',name)}
async function open(context){const page=await context.newPage();page.setDefaultTimeout(15000);page.on('dialog',async d=>{console.error('UNEXPECTED_DIALOG',d.message());await d.dismiss()});await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForSelector('.auth,.sidebar');return page}
async function login(page,pin){
 await page.waitForSelector('.auth',{timeout:30000})
 await page.$eval('.auth-panel input[placeholder="admin"]',(e)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'admin');e.dispatchEvent(new Event('input',{bubbles:true}))})
 await page.$eval('.auth-panel input[type=password]',(e,v)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{bubbles:true}))},pin)
 await page.$eval('.auth-panel form',f=>f.requestSubmit());await page.waitForSelector('.sidebar')
}
const changePin=(page,currentPin,newPin)=>page.evaluate(async(body)=>{const r=await fetch('/api/auth/pin',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.status},{currentPin,newPin})
try{
 const first=await browser.createBrowserContext(),page=await open(first)
 const ids=await page.evaluate(()=>new Promise((resolve,reject)=>{const req=indexedDB.open('monparking');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const db=req.result,t=db.transaction('users'),get=t.objectStore('users').index('username').get('admin');get.onsuccess=()=>resolve({userId:get.result.id,lotId:get.result.lotId});t.oncomplete=()=>db.close()}}))
 await page.evaluate(v=>localStorage.setItem('mp_session',JSON.stringify(v)),ids)
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.auth,.sidebar')
 assert.equal(await page.$('.sidebar'),null);ok('Forged local identity cannot restore authentication')
 await login(page,'1234')
 const cookie=(await first.cookies()).find(c=>c.name===SESSION_COOKIE)
 assert(cookie?.httpOnly&&cookie.sameSite==='Strict');assert(cookie.expires>Date.now()/1000)
 if(base.startsWith('https:'))assert.equal(cookie.secure,true)
 assert.equal(await page.evaluate(name=>document.cookie.includes(name),SESSION_COOKIE),false)
 ok('Persistent proof is an expiring HttpOnly SameSite=Strict cookie, invisible to JavaScript')
 const popup=await open(first),second=await browser.createBrowserContext(),other=await open(second)
 await login(other,'1234')
 assert.equal(await changePin(page,'1234','6789'),200)
 // Sondage à 15 s : un contexte distinct peut mettre jusqu'à ~15 s à constater la révocation.
 await Promise.all([page,popup,other].map(p=>p.waitForSelector('.auth',{timeout:30000})))
 ok('PIN change locks both tabs and another independently authenticated browser context')
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.auth',{timeout:30000})
 assert.equal(await page.$('.sidebar'),null);ok('Reload cannot restore the revoked persisted session')
 console.log('CHECK login with replacement PIN')
 await login(page,'6789')
 console.log('CHECK restoring test PIN through the real API')
 assert.equal(await changePin(page,'6789','1234'),200)
 console.log('CHECK login after second revocation')
 await page.waitForSelector('.auth',{timeout:30000});await login(page,'1234')
 console.log('CHECK logout and copied-cookie replay')
 const replay=(await first.cookies()).find(c=>c.name===SESSION_COOKIE)
 await page.bringToFront()
 assert.equal(await page.$eval('button.user-pill',button=>{button.click();return true}),true)
 console.log('CHECK logout handler invoked')
 await page.waitForSelector('.auth',{timeout:30000})
 await popup.waitForSelector('.auth',{timeout:30000})
 await first.setCookie({...replay})
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.auth',{timeout:30000})
 assert.equal(await page.$('.sidebar'),null);ok('Replaying a copied pre-logout cookie is rejected by the server and UI')
 await first.close();await second.close()
 console.log(`SESSION SECURITY BROWSER: ${count} passed / 0 failed`)
}finally{await browser.close()}
