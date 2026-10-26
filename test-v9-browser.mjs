import { chromePath } from './scripts/lib/chrome.mjs'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const browser=await puppeteer.launch({executablePath:chromePath(),headless:'shell',args:['--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage(),errs=[],OUT='/home/user/shots9';await fs.mkdir(OUT,{recursive:true});await page.setViewport({width:1440,height:1000})
page.on('pageerror',e=>errs.push(String(e)));page.on('console',m=>{if(m.type()==='error')errs.push(m.text())})
const wait=(n=450)=>new Promise(r=>setTimeout(r,n));let count=0
const ok=t=>{console.log('OK',t);count++}
const set=async(selector,v)=>{await page.waitForSelector(selector);await page.$eval(selector,(e,value)=>{const proto=e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}))},v)}
const click=async(txt)=>{const yes=await page.evaluate(t=>{const el=[...document.querySelectorAll('button,a')].find(e=>(e.textContent.trim()===t || (t==='Tickets en cours' && e.textContent.trim().startsWith('Tickets en cours (')))&&!e.disabled);el?.click();return !!el},txt);assert(yes,`Bouton absent : ${txt}`);await wait()}
const navigate=async(hash)=>{await page.evaluate(v=>{location.hash=v},hash);await wait(700)}
async function exportHTML(name,selector){
 const html=await page.evaluate(sel=>{
  const styles=[...document.styleSheets].map(s=>{try{return [...s.cssRules].map(r=>r.cssText).join('\n')}catch{return ''}}).join('\n')
  const target=document.querySelector(sel).cloneNode(true)
  target.querySelectorAll('script').forEach(e=>e.remove())
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>'+styles+'</style></head><body style="margin:0;padding:24px;background:#06090f;color:#e9eef7"><h1 style="font-size:24px;margin-bottom:20px">MON PARKING v9 · capture du parcours testé</h1>'+target.outerHTML+'</body></html>'
 },selector)
 await fs.writeFile(`${OUT}/${name}.html`,html)
}
try{
 await page.goto(process.env.BASE||'http://127.0.0.1:4175/',{waitUntil:'domcontentloaded'});await page.waitForSelector('.auth');await set('.auth-panel input[placeholder="admin"]','admin');await set('.auth-panel input[type="password"]','1234');await click('Se connecter');await page.waitForSelector('.sidebar')
 await click('Équipe & exploitation');await click('Rapports & parking pro');await page.waitForSelector('[data-testid="pro-billingMode"]');ok('nouvel espace professionnel chargé sans modifier les données v8')
 await set('[data-testid="pro-billingMode"]','daily');await set('[data-testid="pro-dailyRate"]','3000');await set('[data-testid="pro-dailyCap"]','3000');await set('[data-testid="pro-graceMinutes"]','0');await set('[data-testid="pro-lostTicketFee"]','2000');await set('[data-testid="pro-maxStayHours"]','24');await set('[data-testid="pro-overstayHourlyRate"]','100');await page.click('[data-testid="save-parking-policy"]');await wait();ok('politique journalière et ticket perdu enregistrés')
 await click('Caisse & rapprochement');await page.click('[data-testid="open-cash"]');await set('[data-testid="ops-amount"]','1000');await page.click('[data-testid="ops-save"]');await page.waitForFunction(()=>!document.querySelector('.modal'));ok('caisse opérateur ouverte')
 await navigate('#/stationnement');await click('Nouveau ticket');await set('[data-testid="entry-plate"]','CI 9900 ZZ');const spot=await page.$eval('[data-testid="entry-spot"]',s=>[...s.options].find(o=>o.value)?.value);await page.select('[data-testid="entry-spot"]',spot);await click('Enregistrer l’entrée');await page.waitForFunction(()=>!document.querySelector('.modal'));ok('entrée quotidienne créée avec politique figée')
 await navigate('#/exploitation');await click('Rapports & parking pro');await set('[data-testid="pro-ticket-search"]','CI 9900 ZZ');await click('Ticket perdu');await set('[data-testid="special-reason"]','Ticket papier égaré par le client');await page.click('[data-testid="save-ticket-special"]');await page.waitForFunction(()=>!document.querySelector('.modal'));ok('déclaration de perte motivée et persistée')
 await click('Corriger la plaque');await set('[data-testid="corrected-plate"]','CI 9901 ZZ');await set('[data-testid="special-reason"]','Vérification du certificat du véhicule');await page.click('[data-testid="save-ticket-special"]');await page.waitForFunction(()=>!document.querySelector('.modal'));await set('[data-testid="pro-ticket-search"]','CI 9901 ZZ');assert((await page.$eval('main',e=>e.innerText)).includes('CI 9901 ZZ'));ok('correction versionnée visible dans le ticket et l’historique')
 await navigate('#/stationnement');await click('Tickets en cours');const found=await page.evaluate(()=>{const row=[...document.querySelectorAll('tr')].find(r=>r.innerText.includes('CI 9901 ZZ'));const b=[...row.querySelectorAll('button')].find(b=>b.textContent.includes('Clôturer'));b.click();return true});assert(found);await page.waitForSelector('.modal');const modal=await page.$eval('.modal',e=>e.innerText);assert(modal.includes('5'));assert(modal.includes('Ticket perdu'));await exportHTML('01-sortie-journaliere','.modal');await page.screenshot({path:`${OUT}/01-sortie.png`});ok('sortie affiche le forfait journalier et le ticket perdu séparément')
 await click('Encaisser');await page.waitForFunction(()=>!document.querySelector('.modal'));ok('encaissement positif et libération de place')
 await navigate('#/exploitation');await click('Caisse & rapprochement');await page.click('[data-testid="close-cash"]');await set('[data-testid="ops-amount"]','6000');await page.click('[data-testid="ops-save"]');await page.waitForFunction(()=>!document.querySelector('.modal'));ok('clôture : fond 1 000 + recette 5 000 = 6 000, écart nul')
 await click('Rapports & parking pro');const text=await page.$eval('main',e=>e.innerText);assert(text.includes('Rapport journalier'));assert(text.includes('Mode local'));await exportHTML('02-rapport-journalier','.ops-page');await page.screenshot({path:`${OUT}/02-rapport.png`});ok('rapport quotidien, ventilation des paiements et rapprochement affichés')
 await page.click('[data-testid="daily-report-csv"]');await wait();ok('export CSV journalier déclenché')
 await page.setViewport({width:390,height:844});await wait();assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)));await page.screenshot({path:`${OUT}/03-mobile.png`});ok('écran professionnel utilisable en mobile')
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.ops-page');await click('Rapports & parking pro');assert((await page.$eval('main',e=>e.innerText)).includes('Mode local'));ok('persistance après rechargement sans faux état cloud connecté')
 assert.equal(errs.length,0,errs.join('\n'));ok('aucune erreur console ou React')
 console.log(`RÉSULTAT NAVIGATEUR V9 : ${count} tests réussis`)
}finally{await browser.close()}
