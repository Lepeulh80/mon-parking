import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore } from '../../server/auth-store.mjs'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK', name) }
  catch (error) { failed++; console.log('FAIL', name, '-', error.message) }
}

const dir = mkdtempSync(join(tmpdir(), 'mp-rate-'))
const file = join(dir, 'auth.sqlite')

await check('m13 : le seuil de tentatives est atteint et bloque', () => {
  const store = new AuthStore(file, { now: () => 1_000_000 })
  for (let i = 0; i < 3; i++) store.noteLoginFailure('10.0.0.1', 3, 900_000)
  assert.ok(store.loginWait('10.0.0.1', 3, 900_000) > 0, 'aucun blocage après 3 échecs')
  store.close()
})

await check('m13 : le compteur survit au redémarrage du processus', () => {
  const reopened = new AuthStore(file, { now: () => 1_000_000 })
  assert.ok(reopened.loginWait('10.0.0.1', 3, 900_000) > 0, 'compteur perdu au redémarrage')
  reopened.close()
})

await check('m13 : une connexion réussie libère le compteur', () => {
  const store = new AuthStore(file, { now: () => 1_000_000 })
  store.clearLoginFailures('10.0.0.1')
  assert.equal(store.loginWait('10.0.0.1', 3, 900_000), 0, 'compteur non réinitialisé')
  store.close()
})

await check('m13 : la fenêtre expirée ne bloque plus', () => {
  const store = new AuthStore(file, { now: () => 1_000_000 })
  store.noteLoginFailure('10.0.0.2', 2, 60_000)
  store.noteLoginFailure('10.0.0.2', 2, 60_000)
  assert.ok(store.loginWait('10.0.0.2', 2, 60_000) > 0, 'seuil non atteint après 2 échecs')
  const later = new AuthStore(file, { now: () => 1_000_000 + 120_000 })
  assert.equal(later.loginWait('10.0.0.2', 2, 60_000), 0, 'fenêtre expirée toujours bloquante')
  later.close(); store.close()
})

await check('m13 : les clés expirées sont purgées par sweep', () => {
  const store = new AuthStore(file, { now: () => 1_000_000 })
  store.noteLoginFailure('10.0.0.3', 2, 60_000)
  const future = new AuthStore(file, { now: () => 1_000_000 + 300_000 })
  const rows = future.sql.prepare('SELECT COUNT(*) n FROM login_attempts').get().n
  assert.equal(rows, 0, 'lignes expirées non purgées')
  future.close(); store.close()
})

rmSync(dir, { recursive: true, force: true })
console.log(`M7 PERSISTENT RATE LIMIT: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
