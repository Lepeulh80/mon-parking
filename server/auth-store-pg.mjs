// MON PARKING — magasin d'authentification sur PostgreSQL.
//
// Portage de server/auth-store.mjs (SQLite synchrone) vers l'adaptateur
// asynchrone server/sql.mjs. Le contrat public est identique, à une différence
// près : toute méthode qui touche la base renvoie une promesse. Le code HTTP
// attend déjà ces méthodes avec `await`, ce qui reste valable pour les deux
// moteurs.
//
// Deux points de moteur méritent d'être explicites :
//   * les horodatages (Date.now(), ~1,8e12) dépassent int4 : les colonnes sont
//     en BIGINT et node-pg les rend en chaîne. Les comparaisons numériques les
//     convertissent, et les `COUNT(*)` sont renormalisés avec Number().
//   * SQLite tenait une transaction sur l'unique connexion. Ici une transaction
//     réserve un client du pool ; AsyncLocalStorage fait que `this.sql` pointe
//     sur ce client pendant tout le callback, y compris dans les appels
//     imbriqués (audit, issue, authenticate). Sans cela, ces requêtes
//     repartiraient sur une autre connexion et échapperaient au verrou.
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, pbkdf2 as pbkdf2Callback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateSecret, generateBackupCodes, hashBackupCode, otpauthUrl, verifyTotp, DIGITS, STEP_MS } from './totp.mjs'
import { openSql, Sql } from './sql.mjs'

const pbkdf2 = promisify(pbkdf2Callback)
const digest = (s) => createHash('sha256').update(s).digest('hex')
const ROLES = new Set(['admin', 'responsable', 'caissier', 'agent', 'employe'])
const SECRET_PREFIX = 'v1:'

export class AuthError extends Error { constructor(status, message) { super(message); this.status = status } }

function parseActive(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  throw new AuthError(400, 'Valeur « active » invalide : booléen attendu.')
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function hashServerPin(pin) {
  if (!/^\d{4,12}$/.test(String(pin))) throw new AuthError(400, 'PIN de 4 à 12 chiffres requis.')
  const salt = randomBytes(16).toString('hex')
  const hash = (await pbkdf2(String(pin), salt, 600000, 32, 'sha256')).toString('hex')
  return { hash: `pbkdf2-sha256$600000$${hash}`, salt }
}

async function verifyPin(pin, row) {
  if (typeof pin !== 'string' || pin.length > 128) return false
  const match = /^pbkdf2-sha256\$(310000|600000)\$([a-f0-9]{64})$/.exec(row.pin_hash)
  if (match) return safeEqual((await pbkdf2(pin, row.pin_salt, Number(match[1]), 32, 'sha256')).toString('hex'), match[2])
  if (process.env.AUTH_DENY_LEGACY_PIN === '1') return false
  let h = `${row.pin_salt}:${pin}`
  if (/^[a-f0-9]{64}$/.test(row.pin_hash)) { for (let i = 0; i < 3; i++) h = digest(h); return safeEqual(h, row.pin_hash) }
  if (/^fb[a-f0-9]{2,16}$/.test(row.pin_hash)) {
    for (let j = 0; j < 3; j++) {
      let h1 = 0x811c9dc5, h2 = 0x1000193
      for (let i = 0; i < h.length; i++) { h1 = (h1 ^ h.charCodeAt(i)) * 0x01000193; h2 = (h2 + h.charCodeAt(i) * (i + 7)) >>> 0 }
      h = `fb${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
    }
    return safeEqual(h, row.pin_hash)
  }
  return false
}

function loadSecretKey(anchorPath) {
  if (process.env.AUTH_2FA_KEY) {
    const raw = Buffer.from(String(process.env.AUTH_2FA_KEY), 'base64')
    if (raw.length !== 32) throw new Error('AUTH_2FA_KEY doit faire exactement 32 octets encodés en base64.')
    return raw
  }
  const file = join(anchorPath, 'auth-store.key')
  if (existsSync(file)) {
    const raw = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
    if (raw.length === 32) return raw
  }
  const key = randomBytes(32)
  writeFileSync(file, key.toString('hex'), { mode: 0o600 })
  if (process.env.NODE_ENV === 'production') {
    console.warn(`[auth] AUTH_2FA_KEY absent : clé de scellement générée dans ${file}. Fournissez AUTH_2FA_KEY et sauvegardez-la, sinon les secrets TOTP deviennent illisibles.`)
  }
  return key
}

export class PgAuthStore {
  static async open({ connectionString, autoMigrate = true, secretAnchor = process.cwd() } = {}) {
    const { sql, close } = await openSql({ connectionString })
    const store = new PgAuthStore(sql, { close, secretAnchor })
    if (autoMigrate) await store.ensureSchema()
    await store.reencryptTotpSecrets()
    await store.sweep().catch(() => 0)
    return store
  }

  constructor(sql, { close = async () => {}, secretAnchor = process.cwd(), ttlMs = 8 * 3600 * 1000 } = {}) {
    this._sql = sql
    this._pool = sql.pool
    this._close = close
    this._als = new AsyncLocalStorage()
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new Error('Invalid session lifetime')
    this.ttlMs = ttlMs
    this.secretKey = loadSecretKey(secretAnchor)
    this.hooks = {}
  }

  // `this.sql` renvoie la connexion de la transaction en cours quand il y en a
  // une, exactement comme la connexion unique de SQLite.
  get sql() { return this._als.getStore() || this._sql }
  now() { return Date.now() }

  async transaction(fn) {
    if (this._als.getStore()) return fn()
    const client = await this._pool.connect()
    try {
      await client.query('BEGIN')
      const scoped = new Sql({ query: (text, params) => client.query(text, params) })
      const value = await this._als.run(scoped, () => fn())
      await client.query('COMMIT')
      return value
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* connexion perdue */ }
      throw error
    } finally { client.release() }
  }

  // Le DDL est idempotent : il peut être rejoué sans risque. Sur un endpoint
  // pooler (PgBouncer, mode transaction), le DDL est refusé par le pooler :
  // passez PG_AUTO_MIGRATE=0 et lancez `npm run db:migrate` sur l'hôte direct.
  async ensureSchema() {
    const here = dirname(new URL(import.meta.url).pathname)
    const files = [
      join(here, '..', 'supabase', 'migrations', '20261026100000_auth_store.sql'),
      join(here, '..', 'supabase', 'migrations', '20261027120000_server_business.sql'),
    ]
    for (const file of files) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      try { await this._sql.exec(text) }
      catch (error) {
        throw new Error(`Migration PostgreSQL refusée (${file.split('/').pop()}) : ${error.message}. `
          + 'Sur un endpoint -pooler, définissez PG_AUTO_MIGRATE=0 puis exécutez `npm run db:migrate` avec l\'URL directe.')
      }
    }
  }

  async countAccounts() { return Number((await this.sql.one('SELECT COUNT(*) AS n FROM accounts')).n) }
  async countActiveAdmins() { return Number((await this.sql.one("SELECT COUNT(*) AS n FROM accounts WHERE role='admin' AND active=1")).n) }

  async sweep({ auditKeepDays = 180 } = {}) {
    const now = this.now()
    const sessions = await this.sql.run('DELETE FROM sessions WHERE expires<=?', [now])
    const attempts = await this.sql.run('DELETE FROM login_attempts WHERE reset<=?', [now])
    const challenges = await this.sql.run('DELETE FROM login_challenges WHERE expires<=?', [now])
    const cutoff = now - auditKeepDays * 86400000
    const audit = await this.sql.run('DELETE FROM auth_audit WHERE at<?', [cutoff])
    return { sessions: sessions.changes, attempts: attempts.changes, challenges: challenges.changes, audit: audit.changes }
  }

  // --------------------------- limitation de débit ---------------------------
  async loginWait(key, max, windowMs = 15 * 60000) {
    const now = this.now()
    const row = await this.sql.one('SELECT count,reset FROM login_attempts WHERE key=?', [key])
    if (!row) return 0
    if (Number(row.reset) <= now) { await this.sql.run('DELETE FROM login_attempts WHERE key=?', [key]); return 0 }
    return Number(row.count) >= max ? Math.max(1, Math.ceil((Number(row.reset) - now) / 1000)) : 0
  }

  async noteLoginFailure(key, max, windowMs = 15 * 60000) {
    const now = this.now()
    const row = await this.sql.one('SELECT count,reset FROM login_attempts WHERE key=?', [key])
    if (!row || Number(row.reset) <= now) {
      await this.sql.run('INSERT INTO login_attempts(key,count,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,reset=excluded.reset', [key, now + windowMs])
      return 1
    }
    await this.sql.run('UPDATE login_attempts SET count=count+1 WHERE key=?', [key])
    return Number(row.count) + 1
  }

  async clearLoginFailures(key) { await this.sql.run('DELETE FROM login_attempts WHERE key=?', [key]) }

  async audit(actor, action, target) {
    await this.sql.run('INSERT INTO auth_audit(id,actor,action,target,at) VALUES(?,?,?,?,?)', [randomUUID(), actor || null, action, target || null, this.now()])
  }

  async importTrusted({ lots, users }) {
    if (await this.countAccounts()) throw new Error('Import allowed only into an empty auth database')
    return this.transaction(async () => {
      for (const lot of lots) {
        if (!lot.id) throw new Error('Missing lot id')
        await this.sql.run('INSERT INTO lots(id,profile) VALUES(?,?) ON CONFLICT(id) DO NOTHING', [lot.id, JSON.stringify(lot)])
      }
      const principals = new Map(), owners = new Map()
      for (const user of users) {
        if (!user.id || !user.username || !ROLES.has(user.role) || !user.pinHash || !user.salt) throw new Error('Invalid trusted user import')
        const key = `${user.username.toLowerCase()}:${user.pinHash}:${user.salt}`
        const principal = principals.get(key) || user.id
        principals.set(key, principal)
        const username = user.username.toLowerCase(), owner = owners.get(username)
        if (owner && owner !== principal) throw new Error(`Username ${username} is already used by another principal`)
        owners.set(username, principal)
        await this.sql.run(
          'INSERT INTO accounts(id,principal,username,name,role,lot_id,active,pin_hash,pin_salt,phone,email) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          [user.id, principal, username, user.name || user.username, user.role, user.lotId, user.active ? 1 : 0, user.pinHash, user.salt, String(user.phone || ''), String(user.email || '')]
        )
      }
    })
  }

  profile(row) {
    return {
      id: row.id, username: row.username, name: row.name, role: row.role, lotId: row.lot_id,
      active: !!row.active, phone: row.phone || '', email: row.email || '',
      mfaEnabled: !!row.totp_active, authVersion: row.generation, serverAuthenticated: true,
    }
  }

  async identity(row) {
    const members = await this.sql.all('SELECT * FROM accounts WHERE principal=? AND active=1', [row.principal])
    const lotOf = async (id) => JSON.parse((await this.sql.one('SELECT profile FROM lots WHERE id=?', [id])).profile)
    const memberships = []
    for (const member of members) memberships.push({ user: this.profile(member), lot: await lotOf(member.lot_id) })
    return { user: this.profile(row), mfa: this.mfaState(row), lot: await lotOf(row.lot_id), memberships }
  }

  async issue(row, oldToken) {
    if (oldToken) await this.sql.run('DELETE FROM sessions WHERE token_hash=?', [digest(oldToken)])
    const token = randomBytes(32).toString('base64url'), expires = this.now() + this.ttlMs
    await this.sql.run('INSERT INTO sessions(token_hash,account_id,generation,created,expires) VALUES(?,?,?,?,?)', [digest(token), row.id, row.generation, this.now(), expires])
    await this.audit(row.id, 'login', row.id)
    return { token, expires, ...(await this.identity(row)) }
  }

  async login(username, pin, oldToken, lotRef) {
    if (typeof username !== 'string' || username.length > 120) throw new AuthError(401, 'Identifiants incorrects.')
    const candidates = await this.sql.all('SELECT * FROM accounts WHERE lower(username)=?', [username.trim().toLowerCase()])
    if (!candidates.length) throw new AuthError(401, 'Identifiants incorrects.')
    if (new Set(candidates.map((a) => a.principal)).size > 1) throw new AuthError(409, 'Identifiant utilisé par plusieurs comptes : connexion refusée. Précisez le parking ou contactez votre administrateur.')
    let pool = candidates
    if (lotRef !== undefined && lotRef !== null && String(lotRef).trim()) {
      const wanted = String(lotRef).trim().toLowerCase()
      const filtered = []
      for (const account of candidates) {
        if (account.lot_id.toLowerCase() === wanted) { filtered.push(account); continue }
        const lot = await this.sql.one('SELECT profile FROM lots WHERE id=?', [account.lot_id])
        const profile = lot ? JSON.parse(lot.profile) : {}
        if (String(profile.code || '').toLowerCase() === wanted || String(profile.name || '').toLowerCase() === wanted) filtered.push(account)
      }
      pool = filtered
      if (!pool.length) throw new AuthError(401, 'Identifiants incorrects.')
    }
    let row = pool.find((account) => account.active) || pool[0]
    for (let n = 0; n < 3; n++) {
      if (!row.active) throw new AuthError(401, 'Identifiants incorrects.')
      if (Number(row.locked_until) > this.now()) {
        const error = new AuthError(429, 'Compte temporairement verrouillé. Réessayez plus tard.')
        error.retryAfter = Math.max(1, Math.ceil((Number(row.locked_until) - this.now()) / 1000))
        throw error
      }
      if (!await verifyPin(pin, row)) {
        await this.sql.run('UPDATE accounts SET failures=failures+1,locked_until=CASE WHEN failures+1>=4 THEN ? ELSE locked_until END WHERE id=?', [this.now() + 60000, row.id])
        throw new AuthError(401, 'Identifiants incorrects.')
      }
      const upgrade = row.pin_hash.startsWith('pbkdf2-sha256$600000$') ? null : await hashServerPin(pin)
      await this.hooks.beforeLoginCommit?.(row)
      const result = await this.transaction(async () => {
        const current = await this.sql.one('SELECT * FROM accounts WHERE id=?', [row.id])
        if (!current?.active) throw new AuthError(401, 'Identifiants incorrects.')
        if (current.generation !== row.generation || current.pin_hash !== row.pin_hash || current.pin_salt !== row.pin_salt) return { retry: current }
        if (upgrade) {
          await this.sql.run('UPDATE accounts SET pin_hash=?,pin_salt=? WHERE principal=?', [upgrade.hash, upgrade.salt, current.principal])
          current.pin_hash = upgrade.hash; current.pin_salt = upgrade.salt
        }
        await this.sql.run('UPDATE accounts SET failures=0,locked_until=0 WHERE id=?', [current.id])
        return current.totp_active ? this.beginChallenge(current) : this.issue(current, oldToken)
      })
      if (!result.retry) return result
      row = result.retry
    }
    throw new AuthError(409, 'Identifiants modifiés pendant la connexion. Réessayez.')
  }

  async authenticate(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthError(401, 'Connexion requise.')
    const key = digest(token)
    const session = await this.sql.one('SELECT * FROM sessions WHERE token_hash=?', [key])
    if (session && Number(session.expires) <= this.now()) await this.sql.run('DELETE FROM sessions WHERE token_hash=?', [key])
    const row = session ? await this.sql.one('SELECT * FROM accounts WHERE id=?', [session.account_id]) : null
    if (!row?.active || !session || Number(session.expires) <= this.now() || session.generation !== row.generation) throw new AuthError(401, 'Session expirée ou révoquée.')
    return row
  }

  async logout(token) { if (typeof token === 'string') await this.sql.run('DELETE FROM sessions WHERE token_hash=?', [digest(token)]) }
  async revokePrincipal(principal) { await this.sql.run('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE principal=?)', [principal]) }

  async changePin(token, oldPin, newPin) {
    const row = await this.authenticate(token)
    if (Number(row.locked_until) > this.now()) throw new AuthError(429, 'Trop de tentatives. Réessayez plus tard.')
    if (!await verifyPin(oldPin, row)) {
      await this.sql.run('UPDATE accounts SET failures=failures+1,locked_until=CASE WHEN failures+1>=4 THEN ? ELSE locked_until END WHERE id=?', [this.now() + 60000, row.id])
      const after = Number((await this.sql.one('SELECT failures FROM accounts WHERE id=?', [row.id])).failures)
      throw new AuthError(after >= 4 ? 429 : 403, after >= 4 ? 'Trop de tentatives de PIN. Réessayez dans une minute.' : 'PIN actuel incorrect.')
    }
    const credentials = await hashServerPin(newPin)
    await this.transaction(async () => {
      const current = await this.authenticate(token)
      if (current.pin_hash !== row.pin_hash || current.pin_salt !== row.pin_salt) throw new AuthError(409, 'Compte modifié entre-temps. Reconnectez-vous.')
      await this.sql.run('UPDATE accounts SET pin_hash=?,pin_salt=?,generation=generation+1,failures=0,locked_until=0 WHERE principal=?', [credentials.hash, credentials.salt, current.principal])
      await this.revokePrincipal(current.principal)
      await this.audit(current.id, 'pin-change', current.id)
    })
    return { ok: true }
  }

  async updateUser(token, id, patch) {
    const actor = await this.authenticate(token)
    const target = await this.sql.one('SELECT * FROM accounts WHERE id=?', [id])
    if (actor.role !== 'admin' || !target || target.lot_id !== actor.lot_id) throw new AuthError(403, 'Accès refusé.')
    if (Object.keys(patch).some((k) => !['pin', 'name', 'role', 'active', 'phone', 'email'].includes(k))) throw new AuthError(400, 'Champ refusé.')
    if (patch.role !== undefined && !ROLES.has(patch.role)) throw new AuthError(400, 'Rôle inconnu.')
    const nextActive = patch.active === undefined ? undefined : parseActive(patch.active)
    const credentials = patch.pin !== undefined ? await hashServerPin(patch.pin) : null
    return this.transaction(async () => {
      const a = await this.authenticate(token)
      const u = await this.sql.one('SELECT * FROM accounts WHERE id=?', [id])
      if (a.role !== 'admin' || !u || u.lot_id !== a.lot_id) throw new AuthError(403, 'Accès refusé.')
      const active = nextActive === undefined ? !!u.active : nextActive, role = patch.role ?? u.role
      if (u.role === 'admin' && u.active && (!active || role !== 'admin')) {
        const others = Number((await this.sql.one("SELECT COUNT(*) AS n FROM accounts WHERE lot_id=? AND role='admin' AND active=1 AND id<>?", [u.lot_id, id])).n)
        if (others < 1) throw new AuthError(409, 'Dernier administrateur actif protégé.')
      }
      const phone = patch.phone === undefined ? String(u.phone || '') : String(patch.phone || '').trim()
      if (phone.length > 40) throw new AuthError(400, 'Téléphone trop long (40 caractères maximum).')
      const email = patch.email === undefined ? String(u.email || '') : String(patch.email || '').trim()
      if (email.length > 160 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new AuthError(400, 'Adresse e-mail invalide.')
      if (credentials) {
        await this.sql.run("UPDATE accounts SET pin_hash=?,pin_salt=?,generation=generation+1,totp_secret='',totp_active=0,totp_backup='[]',totp_last_step=0,totp_failures=0,totp_locked_until=0 WHERE principal=?", [credentials.hash, credentials.salt, u.principal])
        await this.revokePrincipal(u.principal)
      }
      if (nextActive !== undefined || patch.role !== undefined) {
        await this.sql.run('UPDATE accounts SET generation=generation+1 WHERE id=?', [id])
        await this.sql.run('DELETE FROM sessions WHERE account_id=?', [id])
      }
      await this.sql.run('UPDATE accounts SET name=?,role=?,active=?,phone=?,email=? WHERE id=?', [String(patch.name ?? u.name), role, active ? 1 : 0, phone, email, id])
      await this.audit(a.id, 'account-update', id)
      return this.profile(await this.sql.one('SELECT * FROM accounts WHERE id=?', [id]))
    })
  }

  async createUser(token, body) {
    const actor = await this.authenticate(token)
    if (actor.role !== 'admin' || body.lotId !== actor.lot_id) throw new AuthError(403, 'Accès refusé.')
    if (!/^[a-z0-9._-]{3,120}$/i.test(body.username || '') || !String(body.name || '').trim() || !ROLES.has(body.role)) throw new AuthError(400, 'Compte invalide.')
    const existing = await this.sql.all('SELECT DISTINCT principal FROM accounts WHERE lower(username)=?', [String(body.username).toLowerCase()])
    if (existing.length) throw new AuthError(409, 'Cet identifiant est déjà utilisé.')
    const credentials = await hashServerPin(body.pin), id = randomUUID()
    return this.transaction(async () => {
      const a = await this.authenticate(token)
      if (a.role !== 'admin' || a.lot_id !== body.lotId) throw new AuthError(403, 'Accès refusé.')
      await this.sql.run('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt,phone,email) VALUES(?,?,?,?,?,?,?,?,?,?)', [id, id, String(body.username).toLowerCase(), body.name, body.role, body.lotId, credentials.hash, credentials.salt, String(body.phone || '').trim(), String(body.email || '').trim()])
      await this.audit(a.id, 'account-create', id)
      return this.profile(await this.sql.one('SELECT * FROM accounts WHERE id=?', [id]))
    })
  }

  async createLot(token, body) {
    return this.transaction(async () => {
      const a = await this.authenticate(token)
      if (a.role !== 'admin' || !String(body.name || '').trim()) throw new AuthError(403, 'Accès refusé.')
      const id = randomUUID()
      const profile = { id, name: body.name, city: body.city || '', currency: body.currency || 'XOF', code: String(body.name).slice(0, 4).toUpperCase(), logo: body.logo || null, active: true, hourlyRate: 500, dailyCap: 6000, graceMinutes: 15, invoiceNext: 1, receiptNext: 1, ticketNext: 1 }
      await this.sql.run('INSERT INTO lots(id,profile) VALUES(?,?)', [id, JSON.stringify(profile)])
      const clash = Number((await this.sql.one('SELECT COUNT(*) AS n FROM accounts WHERE lower(username)=? AND principal<>?', [a.username, a.principal])).n)
      if (clash) throw new AuthError(409, 'Identifiant déjà utilisé par un autre compte.')
      const uid = randomUUID()
      await this.sql.run('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt) VALUES(?,?,?,?,?,?,?,?)', [uid, a.principal, a.username, a.name, 'admin', id, a.pin_hash, a.pin_salt])
      await this.audit(a.id, 'lot-create', id)
      return { lot: profile, user: this.profile(await this.sql.one('SELECT * FROM accounts WHERE id=?', [uid])) }
    })
  }

  async switchLot(token, lotId) {
    return this.transaction(async () => {
      const a = await this.authenticate(token)
      const target = await this.sql.one('SELECT * FROM accounts WHERE principal=? AND lot_id=? AND active=1', [a.principal, lotId])
      if (!target) throw new AuthError(403, 'Parking non autorisé.')
      return this.issue(target, token)
    })
  }

  // ------------------------------- 2FA TOTP -------------------------------
  mfaPolicy() { const value = String(process.env.AUTH_2FA_POLICY || 'off').toLowerCase(); return ['off', 'admin', 'all'].includes(value) ? value : 'off' }
  mfaRequiredFor(row) { const policy = this.mfaPolicy(); return policy === 'all' || (policy === 'admin' && row.role === 'admin') }

  mfaState(row) {
    let backup = []
    try { backup = JSON.parse(row.totp_backup || '[]') } catch { backup = [] }
    return { enabled: !!row.totp_active, policy: this.mfaPolicy(), required: this.mfaRequiredFor(row), backupRemaining: Array.isArray(backup) ? backup.length : 0, digits: DIGITS, period: STEP_MS / 1000 }
  }

  async beginChallenge(row) {
    const token = randomBytes(32).toString('base64url'), expires = this.now() + 5 * 60000
    await this.sql.run('DELETE FROM login_challenges WHERE account_id=?', [row.id])
    await this.sql.run('INSERT INTO login_challenges(token_hash,account_id,principal,expires,attempts,created) VALUES(?,?,?,?,?,?)', [digest(token), row.id, row.principal, expires, 0, this.now()])
    await this.audit(row.id, 'mfa-challenge', row.id)
    return { mfaRequired: true, challenge: token, expires }
  }

  async completeMfa(challengeToken, code) {
    const invalid = new AuthError(401, 'Vérification expirée. Reconnectez-vous.')
    if (typeof challengeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challengeToken)) throw invalid
    const key = digest(challengeToken)
    const challenge = await this.sql.one('SELECT * FROM login_challenges WHERE token_hash=?', [key])
    if (!challenge) throw invalid
    if (Number(challenge.expires) <= this.now()) { await this.sql.run('DELETE FROM login_challenges WHERE token_hash=?', [key]); throw invalid }
    const row = await this.sql.one('SELECT * FROM accounts WHERE id=?', [challenge.account_id])
    if (!row?.active || !row.totp_active) throw invalid
    if (Number(row.totp_locked_until) > this.now()) {
      const error = new AuthError(429, 'Trop de codes erronés. Réessayez dans une minute.')
      error.retryAfter = Math.max(1, Math.ceil((Number(row.totp_locked_until) - this.now()) / 1000))
      throw error
    }
    if (Number(challenge.attempts) >= 5) {
      await this.sql.run('DELETE FROM login_challenges WHERE token_hash=?', [key])
      const error = new AuthError(429, 'Trop de codes erronés. Reconnectez-vous.')
      error.retryAfter = 60
      throw error
    }
    const clean = String(code ?? '').replace(/[\s-]/g, '')
    let check = verifyTotp(this.secretOf(row), clean, { now: this.now(), lastStep: Number(row.totp_last_step) })
    let backupHash = null
    if (!check.ok) {
      let list = []
      try { list = JSON.parse(row.totp_backup || '[]') } catch { list = [] }
      const hash = hashBackupCode(clean)
      if (hash && Array.isArray(list) && list.some((stored) => safeEqual(String(stored), hash))) { backupHash = hash; check = { ok: true } }
    }
    if (!check.ok) {
      await this.sql.run('UPDATE login_challenges SET attempts=attempts+1 WHERE token_hash=?', [key])
      const failures = Number(row.totp_failures || 0) + 1
      if (failures >= 5) await this.sql.run('UPDATE accounts SET totp_failures=?,totp_locked_until=? WHERE id=?', [failures, this.now() + 60000, row.id])
      else await this.sql.run('UPDATE accounts SET totp_failures=? WHERE id=?', [failures, row.id])
      const error = new AuthError(failures >= 5 ? 429 : 401, failures >= 5 ? 'Trop de codes erronés. Réessayez dans une minute.' : 'Code de vérification incorrect.')
      if (failures >= 5) error.retryAfter = 60
      throw error
    }
    return this.transaction(async () => {
      const current = await this.sql.one('SELECT * FROM accounts WHERE id=?', [row.id])
      if (!current?.active || !current.totp_active || current.generation !== row.generation) throw invalid
      await this.sql.run('DELETE FROM login_challenges WHERE token_hash=?', [key])
      if (backupHash) {
        let list = []
        try { list = JSON.parse(current.totp_backup || '[]') } catch { list = [] }
        await this.sql.run('UPDATE accounts SET totp_backup=? WHERE id=?', [JSON.stringify(list.filter((h) => h !== backupHash)), current.id])
      } else {
        await this.sql.run('UPDATE accounts SET totp_last_step=?,totp_failures=0,totp_locked_until=0 WHERE id=?', [check.step, current.id])
      }
      await this.audit(current.id, backupHash ? 'mfa-backup' : 'mfa-ok', current.id)
      return this.issue(current, null)
    })
  }

  async enrollTotp(token) {
    const row = await this.authenticate(token)
    if (row.totp_active) throw new AuthError(409, 'La double authentification est déjà active : désactivez-la avant de réenrôler.')
    const secret = generateSecret()
    await this.sql.run('UPDATE accounts SET totp_secret=?,totp_last_step=0,totp_failures=0,totp_locked_until=0 WHERE id=?', [this.sealSecret(secret), row.id])
    await this.audit(row.id, 'mfa-enroll-start', row.id)
    return { secret, otpauth: otpauthUrl({ secret, account: row.username, issuer: 'MON PARKING' }), digits: DIGITS, period: STEP_MS / 1000, issuer: 'MON PARKING' }
  }

  async activateTotp(token, code) {
    const row = await this.authenticate(token)
    if (row.totp_active) throw new AuthError(409, 'La double authentification est déjà active.')
    if (!this.secretOf(row)) throw new AuthError(409, 'Aucun enrôlement en cours : demandez d’abord un secret.')
    if (Number(row.totp_locked_until || 0) > this.now()) {
      const error = new AuthError(429, 'Trop de codes erronés. Réessayez dans une minute.')
      error.retryAfter = Math.max(1, Math.ceil((Number(row.totp_locked_until) - this.now()) / 1000))
      throw error
    }
    const check = verifyTotp(this.secretOf(row), String(code ?? ''), { now: this.now(), lastStep: 0 })
    if (!check.ok) {
      const failures = Number(row.totp_failures || 0) + 1
      if (failures >= 5) await this.sql.run('UPDATE accounts SET totp_failures=?,totp_locked_until=? WHERE id=?', [failures, this.now() + 60000, row.id])
      else await this.sql.run('UPDATE accounts SET totp_failures=? WHERE id=?', [failures, row.id])
      const error = new AuthError(failures >= 5 ? 429 : 401, failures >= 5 ? 'Trop de codes erronés. Réessayez dans une minute.' : 'Code incorrect : vérifiez l’heure de votre téléphone, puis réessayez.')
      if (failures >= 5) error.retryAfter = 60
      throw error
    }
    const codes = generateBackupCodes()
    return this.transaction(async () => {
      const current = await this.authenticate(token)
      if (current.totp_active) throw new AuthError(409, 'La double authentification est déjà active.')
      await this.sql.run('UPDATE accounts SET totp_active=1,totp_last_step=?,totp_backup=?,totp_failures=0,totp_locked_until=0 WHERE id=?', [check.step, JSON.stringify(codes.map(hashBackupCode)), current.id])
      await this.audit(current.id, 'mfa-activate', current.id)
      return { ok: true, backupCodes: codes }
    })
  }

  async disableTotp(token, pin) {
    const row = await this.authenticate(token)
    if (!row.totp_active) throw new AuthError(409, 'La double authentification n’est pas active.')
    if (!await verifyPin(pin, row)) throw new AuthError(403, 'PIN incorrect.')
    await this.transaction(async () => {
      const current = await this.authenticate(token)
      if (!current.totp_active) throw new AuthError(409, 'La double authentification n’est pas active.')
      await this.sql.run("UPDATE accounts SET totp_active=0,totp_secret='',totp_backup='[]',totp_last_step=0,totp_failures=0,totp_locked_until=0,generation=generation+1 WHERE principal=?", [current.principal])
      await this.revokePrincipal(current.principal)
      await this.audit(current.id, 'mfa-disable', current.id)
    })
    return { ok: true }
  }

  // ---------------------- scellement des secrets TOTP ----------------------
  sealSecret(secret) {
    if (!secret) return ''
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.secretKey, iv)
    const ct = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()])
    return `${SECRET_PREFIX}${iv.toString('base64')}:${ct.toString('base64')}:${cipher.getAuthTag().toString('base64')}`
  }

  openSecret(value) {
    if (!value) return ''
    const text = String(value)
    if (!text.startsWith(SECRET_PREFIX)) return text
    const [iv, ct, tag] = text.slice(SECRET_PREFIX.length).split(':')
    if (!iv || !ct || !tag) return ''
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.secretKey, Buffer.from(iv, 'base64'))
      decipher.setAuthTag(Buffer.from(tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
    } catch { return '' }
  }

  secretOf(row) { return this.openSecret(row?.totp_secret) }

  async reencryptTotpSecrets() {
    let rows = []
    try { rows = await this.sql.all("SELECT id,totp_secret FROM accounts WHERE totp_secret<>''") } catch { return 0 }
    let migrated = 0
    for (const row of rows) {
      if (String(row.totp_secret).startsWith(SECRET_PREFIX)) continue
      await this.sql.run('UPDATE accounts SET totp_secret=? WHERE id=?', [this.sealSecret(row.totp_secret), row.id])
      migrated++
    }
    return migrated
  }

  async close() { await this._close() }
}
