// m6 — le rapport de déploiement ne doit pas mentir.
// Défaut v12 : deux check(true, …) affichaient « OK » sans rien tester, et le
// scan de secrets ne lisait que process.env : une clé compilée dans
// dist/assets/*.js passait inaperçue.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scanDist,SECRET_PATTERNS } from '../../scripts/lib/secret-scan.mjs'

const root = new URL('../../', import.meta.url).pathname
let passed = 0, failed = 0
const check = async (name, fn) => { try { await fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e.message) } }

await check('Plus aucun « check(true, …) » auto-validant', () => {
  const text = readFileSync(join(root, 'scripts', 'deploy-check.mjs'), 'utf8')
  assert(!/check\(\s*true\s*,/.test(text), 'un contrôle affiche OK sans rien vérifier')
})

await check('Le scan couvre les motifs critiques', () => {
  const labels = SECRET_PATTERNS.map(([label]) => label).join('|')
  for (const expected of ['PEM', 'Supabase', 'Stripe', 'service_role']) assert(labels.includes(expected), `motif manquant : ${expected}`)
})

const dir = await mkdtemp(join(tmpdir(), 'mp-scan-'))
try {
  await mkdir(join(dir, 'assets'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html>')
  await writeFile(join(dir, 'assets', 'index-ABCDEF12.js'), 'const k="sb_secret_abcdefghijklmnop1234";const r="service_role"')

  await check('Une clé compilée dans un bundle est détectée', async () => {
    const { hits,scanned } = scanDist(dir)
    assert(scanned >= 2, `fichiers scannés : ${scanned}`)
    assert(hits.some((h) => /Supabase/.test(h)), `clé Supabase non détectée : ${JSON.stringify(hits)}`)
    assert(hits.some((h) => /service_role/.test(h)), 'rôle service_role non détecté')
  })

  await check('Un bundle propre ne produit aucun faux positif', async () => {
    await writeFile(join(dir, 'assets', 'index-ABCDEF12.js'), 'export const price=500')
    const { hits } = scanDist(dir)
    assert.equal(hits.length, 0, `faux positifs : ${JSON.stringify(hits)}`)
  })

  await check('Répertoire absent : pas de plantage', async () => {
    const { hits,scanned } = scanDist(join(dir, 'inexistant'))
    assert.equal(hits.length, 0)
    assert.equal(scanned, 0)
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`M6 DEPLOY REPORT: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
