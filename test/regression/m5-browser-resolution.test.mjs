// m5 — reproductibilité des tests navigateur.
// Défaut v12 : chemin Chrome codé en dur (/home/user/.cache/puppeteer/chrome/
// linux-155.0.8059.79/…) dans 5 fichiers → npm run test:browser échoue sur
// toute autre machine et en CI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../../', import.meta.url).pathname
const files = ['test-v8-browser.mjs', 'test-v9-browser.mjs', 'test-v10-browser.mjs', 'scripts/test-persisted-proof.mjs', 'scripts/security-review-pin-session.mjs']
let passed = 0, failed = 0
const check = (name, fn) => { try { fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e.message) } }

check('Aucun chemin absolu de navigateur codé en dur', () => {
  const offenders = []
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    if (/\/home\/user\/\.cache\/puppeteer/.test(text) || /linux-155\.0\.8059\.79/.test(text)) offenders.push(file)
  }
  assert.equal(offenders.length, 0, `chemins codés en dur : ${offenders.join(', ')}`)
})

check('Chaque test navigateur passe par le résolveur partagé', () => {
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8')
    assert(/import\s*\{\s*chromePath\s*\}/.test(text), `import manquant dans ${file}`)
    assert(text.includes('chromePath()'), `chromePath() non utilisé dans ${file}`)
  }
})

check('Le résolveur renvoie un exécutable réel ou un message actionnable', async () => {
  const { chromePath } = await import('../../scripts/lib/chrome.mjs')
  const saved = process.env.CHROME
  try {
    process.env.CHROME = '/chemin/inexistant/chrome'
    assert.throws(() => chromePath(), /CHROME pointe vers un fichier absent/)
    delete process.env.CHROME
    const found = chromePath()
    assert(typeof found === 'string' && found.length > 0)
    console.log(`        navigateur résolu : ${found}`)
  } catch (error) {
    // Un environnement sans navigateur doit produire un message explicite, pas un ENOENT.
    assert.match(error.message, /Navigateur introuvable|chromePath/)
    throw error
  } finally {
    if (saved === undefined) delete process.env.CHROME
    else process.env.CHROME = saved
  }
})

console.log(`M5 BROWSER RESOLUTION: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
