import { chromePath } from './scripts/lib/chrome.mjs'
import puppeteer from 'puppeteer-core'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const BASE = process.env.BASE || 'http://127.0.0.1:4175/'
const SHOTS = process.env.SHOTS || '/home/user/shots8'
const CHROME = chromePath()
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args:['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage(), errors=[]
await page.setViewport({width:1440,height:1000}); await fs.mkdir(SHOTS,{recursive:true})
page.on('pageerror',(e) => errors.push(String(e)))
page.on('console',(m) => { if(m.type()==='error') errors.push(m.text()) })
const sleep=(ms=400) => new Promise((r)=>setTimeout(r,ms))
let passed=0
const ok=(s)=>{ console.log('OK',s); passed++ }
async function set(selector,value) {
  await page.waitForSelector(selector)
  await page.$eval(selector,(el,v)=>{ const proto=el.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})) },value)
}
async function click(text) {
  const done=await page.evaluate((txt)=>{ const e=[...document.querySelectorAll('button,a')].find((x)=>x.textContent.trim()===txt&&!x.disabled); e?.click();return !!e },text)
  assert(done,`Button missing: ${text}`); await sleep()
}
async function save() { await page.click('[data-testid="ops-save"]'); await page.waitForFunction(()=>!document.querySelector('.modal'),{timeout:10000}); await sleep() }
const local=(delta)=>{ const d=new Date(Date.now()+delta); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16) }
try {
  await page.goto(BASE,{waitUntil:'domcontentloaded'}); await page.waitForSelector('.auth')
  await set('.auth-panel input[placeholder="admin"]','admin')
  await set('.auth-panel input[type="password"]','1234'); await click('Se connecter'); await page.waitForSelector('.sidebar')
  await click('Équipe & exploitation'); await page.waitForSelector('[data-testid="clock-in"]'); ok('nouvelle route chargée avec les données existantes')
  await page.click('[data-testid="clock-in"]'); await page.waitForSelector('[data-testid="clock-pause"]'); ok('prise de service persistée')
  await page.click('[data-testid="clock-pause"]'); await page.waitForSelector('[data-testid="clock-resume"]'); ok('pause puis reprise disponibles')
  await page.click('[data-testid="clock-resume"]'); await page.waitForSelector('[data-testid="clock-pause"]')
  await page.click('[data-testid="clock-out"]'); await page.waitForSelector('[data-testid="clock-in"]'); ok('fin de service et feuille des heures')
  await page.click('[data-testid="new-shift"]'); await set('[data-testid="ops-startAt"]',local(86400000)); await set('[data-testid="ops-endAt"]',local(115200000)); await set('[data-testid="ops-zone"]','A'); await save(); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Planifié')); ok('vacation créée via formulaire réel')
  await page.screenshot({path:`${SHOTS}/01-equipe-pointage.png`})
  await click('Caisse & rapprochement'); await page.click('[data-testid="open-cash"]'); await set('[data-testid="ops-amount"]','10000'); await save(); assert((await page.$eval('[data-testid="cash-expected"]',e=>e.innerText)).replace(/\D/g,'').includes('10000')); ok('caisse ouverte à 10 000 via le formulaire')
  await click('Apport / retrait'); await set('[data-testid="ops-amount"]','500'); await set('[data-testid="ops-reason"]','Monnaie début de service'); await save(); ok('apport au journal de caisse')
  await page.screenshot({path:`${SHOTS}/02-caisse.png`})
  await click('Incidents'); await page.click('[data-testid="new-incident"]'); await set('[data-testid="ops-title"]','Barrière bloquée'); await set('[data-testid="ops-description"]','Signalement de sécurité voie A'); await set('[data-testid="ops-plate"]','CI 1234 AB'); await save(); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Barrière bloquée')); ok('incident créé et visible')
  await click('Mettre à jour'); await set('[data-testid="ops-reason"]','Technicien affecté'); await save(); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Technicien affecté')); ok('suivi d’incident journalisé')
  await page.screenshot({path:`${SHOTS}/03-incidents.png`})
  await click('Tarifs & abonnements'); await page.click('[data-testid="new-rate"]'); await set('[data-testid="ops-name"]','Tarif VIP testé'); await set('[data-testid="ops-hourlyRate"]','250'); await set('[data-testid="ops-dailyCap"]','3000'); await set('[data-testid="ops-graceMinutes"]','0'); await save(); ok('grille tarifaire créée')
  await page.click('[data-testid="new-pass"]'); await set('[data-testid="ops-holder"]','Client abonnement test'); await set('[data-testid="ops-plate"]','CI 9000 ZZ'); await set('[data-testid="ops-amount"]','5000'); await save(); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('CI 9000 ZZ')); ok('abonnement payé dans la caisse ouverte')
  await page.screenshot({path:`${SHOTS}/04-tarifs-abonnements.png`})
  await click('Stationnement'); await click('Nouveau ticket'); await page.waitForSelector('[data-testid="entry-rate-plan"]'); const available=await page.$$eval('[data-testid="entry-rate-plan"] option',options=>options.map(o=>o.textContent)); assert(available.includes('Tarif VIP testé')); ok('grille disponible dans le véritable formulaire d’entrée du parking')
  await click('Annuler'); await click('Équipe & exploitation'); await click('Caisse & rapprochement'); await page.click('[data-testid="close-cash"]'); await set('[data-testid="ops-amount"]','15490'); await set('[data-testid="ops-reason"]','Écart de 10 à contrôler'); await save(); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Clôturée')); ok('clôture rapprochée : 15 500 attendus, 15 490 comptés')
  await click('Pilotage & alertes'); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Occupation')); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Écart de caisse')); ok('KPI et alerte d’écart opérationnels')
  await page.screenshot({path:`${SHOTS}/05-pilotage.png`})
  await click('Traçabilité'); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('caisse-cloture')); ok('journal opérationnel alimenté')
  await click('Matrice des droits'); assert(/agent\s+de\s+parking/i.test(await page.$eval('.ops-page',e=>e.innerText))); ok('matrice des cinq rôles affichée')
  await click('Planning & pointage'); await page.setViewport({width:390,height:844}); await sleep(); assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))); ok('vue mobile sans débordement horizontal')
  await page.screenshot({path:`${SHOTS}/06-mobile.png`}); await page.setViewport({width:1440,height:1000})
  await page.reload({waitUntil:'domcontentloaded'}); await page.waitForSelector('.ops-page'); await click('Incidents'); assert((await page.$eval('.ops-page',e=>e.innerText)).includes('Barrière bloquée')); ok('données persistées après rechargement')
  // Verify existing OCR admin still mounts after the migration.
  await click('Administration'); await click('Apprentissage OCR'); assert((await page.$eval('main',e=>e.innerText)).includes('Apprentissage partagé entre postes')); ok('panneau de partage OCR v7 préservé')
  assert.equal(errors.length,0,errors.join('\n')); ok('aucune erreur console ou React')
  console.log(`RÉSULTAT NAVIGATEUR V8 : ${passed} tests réussis`)
} finally { await browser.close() }
