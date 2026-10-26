/**
 * Test de l'API de notifications (src/lib/toastApi.js) et de son câblage.
 * Node pur, aucun JSX, aucun DOM.
 *
 * Motif : en v19.2, le contexte React `ToastCtx` valait `{ push: () => {} }`.
 * Hors `<ToastProvider>`, `toast.ok('…')` levait
 * `TypeError: toast.ok is not a function` — plantage d'écran au lieu d'un no-op.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createToastApi, NOOP_TOAST, isToastApi, TOAST_KINDS } from './src/lib/toastApi.js'

let pass = 0
let fail = 0
async function test(name, fn) {
  try {
    await fn()
    pass++
    console.log(`PASS ${name}`)
  } catch (e) {
    fail++
    console.log(`FAIL ${name} → ${e.message}`)
  }
}

/* ---------- 1. routage des kinds ---------- */
await test('t1 : ok/err/info passent le bon kind à push', () => {
  const seen = []
  const api = createToastApi((m, k) => seen.push([m, k]))
  api.ok('Vente enregistrée.')
  api.err('Stock épuisé.')
  api.info('Synchronisation en cours.')
  assert.deepEqual(seen, [
    ['Vente enregistrée.', 'ok'],
    ['Stock épuisé.', 'err'],
    ['Synchronisation en cours.', 'info'],
  ])
})

await test('t2 : push brut conserve son kind par défaut', () => {
  const seen = []
  const api = createToastApi((m, k) => seen.push([m, k]))
  api.push('Message neutre.')
  assert.deepEqual(seen, [['Message neutre.', undefined]])
})

await test('t3 : un argument parasite ne peut pas changer le kind', () => {
  const seen = []
  const api = createToastApi((m, k) => seen.push([m, k]))
  // Un appelant qui passerait 'err' en second argument ne doit rien détourner.
  api.ok('Validé.', 'err')
  assert.deepEqual(seen, [['Validé.', 'ok']])
})

await test('t4 : message non-chaîne converti, jamais undefined', () => {
  const seen = []
  const api = createToastApi((m, k) => seen.push([m, k]))
  api.err(undefined)
  api.err(null)
  api.ok(42)
  assert.deepEqual(seen.map(([m]) => m), ['', '', '42'])
})

await test('t5 : createToastApi refuse une valeur non appelable', () => {
  assert.throws(() => createToastApi(null), /attend une fonction push/)
  assert.throws(() => createToastApi({}), /attend une fonction push/)
})

/* ---------- 2. API inerte ---------- */
await test('t6 : NOOP_TOAST expose les quatre méthodes et ne lève pas', () => {
  assert.equal(isToastApi(NOOP_TOAST), true)
  for (const k of ['push', 'ok', 'err', 'info']) assert.equal(typeof NOOP_TOAST[k], 'function')
  assert.doesNotThrow(() => {
    NOOP_TOAST.push('a')
    NOOP_TOAST.ok('b')
    NOOP_TOAST.err('c')
    NOOP_TOAST.info('d')
  })
})

await test('t7 : isToastApi rejette un contexte partiel (le défaut v19.2)', () => {
  const legacy = { push: () => {} } // valeur exacte de l'ancien contexte par défaut
  assert.equal(isToastApi(legacy), false)
  assert.equal(isToastApi(undefined), false)
  assert.equal(isToastApi({}), false)
})

await test('t8 : TOAST_KINDS est fermé et figé', () => {
  assert.deepEqual([...TOAST_KINDS], ['info', 'ok', 'err'])
  assert.equal(Object.isFrozen(TOAST_KINDS), true)
})

/* ---------- 3. câblage dans le composant ---------- */
const ui = readFileSync(new URL('./src/components/UI.jsx', import.meta.url), 'utf8')

await test('t9 : le contexte par défaut est NOOP_TOAST, plus un objet partiel', () => {
  assert.match(ui, /createContext\(NOOP_TOAST\)/)
  assert.doesNotMatch(ui, /createContext\(\{\s*push:/)
})

await test('t10 : le provider construit son API avec createToastApi', () => {
  assert.match(ui, /useMemo\(\(\) => createToastApi\(push\), \[push\]\)/)
})

await test('t11 : CardHead rend right et icon facultatifs', () => {
  assert.match(ui, /function CardHead\(\{ title, sub, right = null, icon: Icon = null \}\)/)
})

await test('t12 : la classe du toast est contrainte à TOAST_KINDS', () => {
  assert.match(ui, /TOAST_KINDS\.includes\(t\.kind\)/)
})

/* ---------- 4. l'écran Sync ne peut plus planter sans provider ---------- */
const sync = readFileSync(new URL('./src/screens/Sync.jsx', import.meta.url), 'utf8')

await test('t13 : Sync.jsx valide le contexte avant usage', () => {
  assert.match(sync, /isToastApi\(rawToast\) \? rawToast : NOOP_TOAST_STUB/)
})

await test('t14 : Sync.jsx ne consomme plus directement le contexte brut', () => {
  assert.doesNotMatch(sync, /const toast = useToast\(\)/)
})

console.log(`\nTOAST API : ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
