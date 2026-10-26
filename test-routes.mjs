/**
 * Énumération des routes /api/ et contrôle d'accès anonyme.
 *
 * Motif (revue v19.4) : aucun test ne prouvait l'absence de route ouverte.
 * Ce test lit la table de routage dans le code source, exige que chaque route
 * déclarée soit couverte par la matrice, puis interroge un vrai serveur HTTP
 * sans cookie de session.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AuthStore } from './server/auth-store.mjs'
import { createAuthServer } from './server/http.mjs'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK', name) }
  catch (e) { failed++; console.log('FAIL', name, '-', e.message) }
}

// Méthode réellement déclarée, nature attendue sans session.
const MATRIX = [
  ['/api/auth/login', 'POST', 'public'],
  ['/api/auth/mfa', 'POST', 'public'],
  ['/api/auth/status', 'GET', 'status'],
  ['/api/auth/logout', 'POST', 'idempotent'],
  ['/api/auth/mfa/enroll', 'POST', 'protected'],
  ['/api/auth/mfa/activate', 'POST', 'protected'],
  ['/api/auth/mfa/disable', 'POST', 'protected'],
  ['/api/auth/session', 'GET', 'protected'],
  ['/api/auth/authorize', 'POST', 'protected'],
  ['/api/auth/pin', 'POST', 'protected'],
  ['/api/auth/switch-lot', 'POST', 'protected'],
  ['/api/admin/users', 'POST', 'protected'],
  ['/api/admin/lots', 'POST', 'protected'],
  ['/api/admin/users/:id', 'PATCH', 'protected'],
]

const source = readFileSync(new URL('./server/http.mjs', import.meta.url), 'utf8')

await check('r1 : chaque route /api/ du code source est couverte par la matrice', () => {
  const declared = new Set()
  for (const m of source.matchAll(/url\.pathname==='(\/api\/[^']*)'/g)) declared.add(m[1])
  if (/\/\^\\\/api\\\/admin\\\/users/.test(source)) declared.add('/api/admin/users/:id')
  const covered = new Set(MATRIX.map(([p]) => p))
  const uncovered = [...declared].filter((p) => !covered.has(p))
  assert.deepEqual(uncovered, [], `routes déclarées sans test : ${uncovered.join(', ')}`)
  assert.ok(declared.size >= 13, `seulement ${declared.size} routes détectées`)
})

const dir = mkdtempSync(join(tmpdir(), 'mp-routes-'))
const store = new AuthStore(join(dir, 'auth.sqlite'))
const port = 30000 + Math.floor(Math.random() * 20000)
const origin = `http://127.0.0.1:${port}`
const server = createAuthServer({ store, origin, distDir: resolve('dist') })
await new Promise((r) => server.listen(port, '127.0.0.1', r))

const call = async (route, method) => {
  const path = route.replace(':id', 'inconnu')
  return fetch(`${origin}${path}`, {
    method,
    headers: method === 'POST' || method === 'PATCH' ? { 'Content-Type': 'application/json', Origin: origin } : {},
    body: method === 'GET' ? undefined : '{}',
  })
}

for (const [route, method, kind] of MATRIX) {
  await check(`r : ${method} ${route} — ${kind}`, async () => {
    const res = await call(route, method)
    const cookie = res.headers.get('set-cookie') || ''
    if (kind === 'protected') {
      assert.ok([401, 403].includes(res.status),
        `attendu 401/403 sans session, reçu ${res.status}`)
      assert.doesNotMatch(cookie, /mp_session=[A-Za-z0-9]/,
        'un cookie de session a été émis sans authentification')
      const payload = await res.text()
      assert.doesNotMatch(payload, /"lotId"|"username"|"pinHash"/,
        `charge utile divulguée : ${payload.slice(0, 120)}`)
    } else if (kind === 'status') {
      assert.equal(res.status, 200)
      const payload = await res.json()
      assert.equal(payload.authenticated, false, 'anonyme déclaré authentifié')
      assert.equal(payload.username, undefined, 'identité divulguée à un anonyme')
      assert.equal(payload.lotId, undefined, 'parking divulgué à un anonyme')
    } else if (kind === 'public') {
      assert.ok([400, 401].includes(res.status),
        `une connexion anonyme vide doit être refusée, reçu ${res.status}`)
      assert.doesNotMatch(cookie, /mp_session=[A-Za-z0-9]/, 'cookie émis sans identifiants valides')
    } else {
      assert.equal(res.status, 200)
      assert.doesNotMatch(cookie, /mp_session=[A-Za-z0-9]/, 'cookie émis sur une déconnexion anonyme')
    }
  })
}

await check('r : une route inconnue sous /api/ ne divulgue rien', async () => {
  const res = await fetch(`${origin}/api/inexistant`)
  assert.equal(res.status, 405)
  const payload = await res.json()
  assert.equal(payload.error, 'Route ou méthode refusée.')
})

await check('r : le cookie de session est HttpOnly et SameSite=Strict', () => {
  assert.match(source, /HttpOnly/)
  assert.match(source, /SameSite=Strict/)
})

await check('r : aucun secret en dur dans le serveur', () => {
  for (const file of ['server/auth-store.mjs', 'server/http.mjs', 'server/totp.mjs']) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /(?:secret|key|token)\s*[:=]\s*['"][A-Za-z0-9+/]{24,}['"]/i,
      `valeur secrète probable dans ${file}`)
  }
})

server.close()
store.close()
console.log(`\nROUTES API : ${passed} passed / ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
