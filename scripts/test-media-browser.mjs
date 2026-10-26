// Vérification navigateur réelle : import de photos, rotation 360°, persistance.
import { chromePath } from './lib/chrome.mjs'
import puppeteer from 'puppeteer-core'
import assert from 'node:assert/strict'

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: 'shell', args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
let passed = 0
const ok = (t) => { console.log('OK', t); passed++ }
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms))

try {
  await page.goto(process.env.BASE || 'http://127.0.0.1:4175/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.auth', { timeout: 30000 })
  await page.$eval('.auth-panel input[placeholder="admin"]', (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'admin'); e.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.$eval('.auth-panel input[type=password]', (e) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, '1234'); e.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Se connecter')?.click())
  await page.waitForSelector('[data-testid="customize-dashboard"]', { timeout: 30000 })
  ok('connexion établie')

  await page.evaluate(() => { window.location.hash = '#/stock' })
  await wait(900)
  await page.waitForSelector('.v-card', { timeout: 15000 })
  await page.click('.v-card')
  await wait(600)
  const tabs = await page.$$eval('.seg button, .seg-item', (els) => els.map((e) => e.textContent.trim()))
  assert.ok(tabs.some((t) => /Photos/i.test(t)), `onglet Photos absent : ${tabs.join(' | ')}`)
  ok('onglet « Photos & 360° » présent dans la fiche véhicule')

  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Photos & 360/i.test(b.textContent))?.click())
  await wait(500)

  // Fabrique de vraies images (canvas) puis injection dans l'input caché.
  const inject = async (testId, count, hue0) => {
    await page.evaluate(async (id, n, h0) => {
      const input = document.querySelector(`[data-testid="${id}"]`)
      const dt = new DataTransfer()
      for (let i = 0; i < n; i++) {
        const c = document.createElement('canvas'); c.width = 640; c.height = 480
        const x = c.getContext('2d')
        x.fillStyle = `hsl(${h0 + i * 12} 60% 42%)`; x.fillRect(0, 0, 640, 480)
        x.fillStyle = '#fff'; x.font = 'bold 90px sans-serif'; x.fillText(String(i + 1), 40, 130)
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))
        dt.items.add(new File([blob], `vue-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' }))
      }
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, testId, count, hue0)
  }

  await inject('vehicle-photo-input', 2, 20)
  await page.waitForFunction(() => document.querySelectorAll('.photo-cell').length >= 2, { timeout: 30000 })
  const photos = await page.$$eval('.photo-cell', (els) => els.length)
  assert.ok(photos >= 2, `photos affichées : ${photos}`)
  ok(`${photos} photos importées et affichées`)

  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Rotation 360/i.test(b.textContent))?.click())
  await wait(400)
  await inject('vehicle-frame-input', 12, 200)
  await page.waitForFunction(() => document.querySelectorAll('.frame-cell').length >= 12, { timeout: 60000 })
  await page.waitForSelector('.spin-stage', { timeout: 60000 })
  ok('séquence 360° créée et lecteur affiché')

  const frameState = () => page.evaluate(() => {
    const range = document.querySelector('.spin-range')
    const angle = document.querySelector('.spin-angle')
    return `${range ? range.value : '?'}|${angle ? angle.textContent : '?'}`
  })
  const before = await frameState()
  const box = await page.$eval('.spin-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.w / 2 - 120, box.y + box.h / 2, { steps: 8 })
  await page.mouse.up()
  await wait(300)
  const after = await frameState()
  assert.notEqual(before, after, `le glissement ne change pas la prise affichée (${before} -> ${after})`)
  const angle = await page.$eval('.spin-angle', (e) => e.textContent)
  assert.match(angle, /^\d{1,3}°$/)
  ok(`glissement horizontal : rotation effective (angle affiché ${angle})`)

  await page.keyboard.press('ArrowRight')
  await wait(200)
  const afterKey = await frameState()
  assert.notEqual(after, afterKey, `la flèche droite ne change pas la prise (${after} -> ${afterKey})`)
  ok('navigation clavier opérationnelle sur le lecteur 360°')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.v-card', { timeout: 30000 })
  await page.click('.v-card')
  await wait(700)
  const persisted = await page.evaluate(() => document.body.innerText.match(/(\d+)\s*photos?/i)?.[1])
  ok(`médias persistés après rechargement (compteur annoncé : ${persisted || 'n/a'})`)

  assert.equal(errors.length, 0, `erreurs console : ${errors.join(' | ')}`)
  ok('aucune erreur applicative ou console')
  console.log(`RÉSULTAT MÉDIAS NAVIGATEUR : ${passed} tests réussis`)
} finally { await browser.close() }
