import { randomUUID } from 'node:crypto'
import { hashServerPin } from './auth-store.mjs'

const USERNAME_RE = /^[A-Za-z0-9._-]{3,120}$/

/**
 * Amorçage du premier administrateur sur les plateformes sans shell
 * (Render, Railway) : le provisionnement manuel `npm run auth:setup`
 * suppose un terminal. Ici, ADMIN_USERNAME et ADMIN_PIN ne servent
 * QUE si la base ne contient encore aucun compte — un redémarrage ne
 * peut donc jamais écraser un mot de passe déjà changé.
 */
export async function bootstrapAdmin(store, env = process.env, log = console) {
  const username = String(env.ADMIN_USERNAME || '').trim()
  const pin = String(env.ADMIN_PIN || '')
  if (!username && !pin) return { created: false, reason: 'NOT_CONFIGURED' }
  if (!username) throw new Error('ADMIN_USERNAME manquant alors que ADMIN_PIN est défini.')
  if (!pin) throw new Error('ADMIN_PIN manquant alors que ADMIN_USERNAME est défini.')
  if (!USERNAME_RE.test(username)) {
    throw new Error('ADMIN_USERNAME invalide : 3 à 120 caractères parmi A-Z a-z 0-9 . _ -')
  }
  if (pin.length < 4 || pin.length > 64) throw new Error('ADMIN_PIN invalide : 4 à 64 caractères requis.')

  if (await hasAccount(store)) return { created: false, reason: 'ALREADY_PROVISIONED' }

  const lotName = (String(env.ADMIN_LOT_NAME || '').trim() || 'Mon parking').slice(0, 80)
  const adminName = (String(env.ADMIN_NAME || '').trim() || username).slice(0, 120)
  const credentials = await hashServerPin(pin)
  const lotId = randomUUID()
  const id = randomUUID()
  store.importTrusted({
    lots: [{
      id: lotId,
      name: lotName,
      code: lotName.slice(0, 4).toUpperCase(),
      active: true,
      currency: 'XOF',
      hourlyRate: 500,
      dailyCap: 6000,
      graceMinutes: 15,
    }],
    users: [{
      id,
      lotId,
      username,
      name: adminName,
      role: 'admin',
      active: true,
      pinHash: credentials.hash,
      salt: credentials.salt,
    }],
  })
  log.log(`Compte administrateur initial « ${username} » créé (amorçage plateforme).`)
  return { created: true, username, lotId }
}

async function hasAccount(store) {
  // Les magasins PostgreSQL sont asynchrones : comparer une promesse à 0
  // renvoyait toujours faux et l'amorçage échouait au milieu d'une transaction.
  if (typeof store.countAccounts === 'function') return (await store.countAccounts()) > 0
  if (typeof store.hasAdmin === 'function') return !!store.hasAdmin()
  if (typeof store.sql?.prepare === 'function') return store.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n > 0
  const row = await store.sql.one('SELECT COUNT(*) AS n FROM accounts')
  return Number(row.n) > 0
}
