// m4 — poids du premier chargement / précache.
// Défaut v12 : le moteur OCR (5,6 Mo de WASM) était précaché avec le reste :
// première visite mobile très lourde pour une fonction utilisée occasionnellement.
import assert from 'node:assert/strict'
import { existsSync,readFileSync,statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname
let passed = 0, failed = 0
const check = (name, fn) => { try { fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e.message) } }

check('Configuration : /ocr/ exclu du précache mais servi à la demande', () => {
  const config = readFileSync(join(root, 'vite.config.js'), 'utf8')
  assert(/globIgnores:\s*\[[^\]]*ocr/.test(config), 'motif d’exclusion du répertoire ocr absent')
  assert(/urlPattern:\s*\(\{\s*url\s*\}\)\s*=>\s*url\.pathname\.startsWith\('\/ocr\/'\)/.test(config), 'route de cache runtime /ocr/ absente')
})

const swPath = join(root, 'dist', 'sw.js')
check('Service worker généré présent (sinon exécuter npm run build)', () => {
  assert(existsSync(swPath), 'dist/sw.js absent')
})

check('Le manifeste de précache ne contient plus le moteur OCR', () => {
  const sw = readFileSync(swPath, 'utf8')
  // Workbox écrit un littéral JS (clés non guillemetées) : {url:"x",revision:"y"}
  const entries = [...sw.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1])
  assert(entries.length > 0, 'manifeste de précache vide ou illisible')
  const ocr = entries.filter((url) => /(^|\/)ocr\//.test(url) || /tesseract-core.*\.wasm$/.test(url))
  assert.equal(ocr.length, 0, `précaché à tort : ${ocr.slice(0, 3).join(', ')}`)
})

check('Le moteur OCR reste livré dans dist/ocr (scan hors ligne après 1er usage)', () => {
  for (const file of ['tesseract-core-lstm.wasm', 'worker.min.js']) {
    const full = join(root, 'dist', 'ocr', file)
    assert(existsSync(full), `fichier manquant : dist/ocr/${file}`)
    assert(statSync(full).size > 0, `fichier vide : ${file}`)
  }
})

check('Le précache reste sous 10 Mo', () => {
  const sw = readFileSync(swPath, 'utf8')
  const revision = [...sw.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1])
  let total = 0
  for (const url of revision) {
    const path = join(root, 'dist', url.replace(/^\.?\//, ''))
    if (existsSync(path)) total += statSync(path).size
  }
  assert(total < 10 * 1024 * 1024, `précache de ${(total / 1024 / 1024).toFixed(1)} Mo`)
  console.log(`        précache mesuré : ${(total / 1024 / 1024).toFixed(2)} Mo`)
})

console.log(`M4 PRECACHE: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
