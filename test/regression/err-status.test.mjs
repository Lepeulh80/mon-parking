// Une erreur d'authentification doit rester un 401/403, jamais un 500.
// Regression : les magasins PostgreSQL levaient des erreurs qui n'etaient pas
// reconnues comme AuthError -> toute la facade /api repondait 500.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../../server/http.mjs', import.meta.url), 'utf8')
const pgAuth = readFileSync(new URL('../../server/auth-store-pg.mjs', import.meta.url), 'utf8')

test('auth-store-pg reutilise la classe AuthError du serveur (pas de doublon)', () => {
  assert.equal(/class AuthError/.test(pgAuth), false, 'classe AuthError dupliquee')
  assert.match(pgAuth, /import \{ AuthError \} from '\.\/auth-store\.mjs'/)
})

test('la facade honore un .status 4xx porte par une erreur quelconque', () => {
  assert.ok(src.includes('Number.isInteger(e&&e.status)&&e.status>=400&&e.status<600'), 'statut non propage')
})

test('une erreur sans statut reste un 500', () => {
  assert.ok(src.includes('?e.status:500'), 'repli 500 absent')
})
