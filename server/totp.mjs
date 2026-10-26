// TOTP (RFC 6238) pour le serveur d'authentification de MON PARKING.
//
// Pourquoi pas Supabase Auth MFA : dans ce projet, la connexion n'est PAS
// gérée par Supabase (aucun appel supabase.auth.*) mais par ce serveur Node
// + SQLite, qui émet le cookie HttpOnly de session. Brancher `mfa.enroll()`
// de Supabase produirait un second facteur sur une identité que l'application
// n'utilise jamais : le code serait mort. Le secret est donc stocké ici, et
// la vérification est faite côté serveur, jamais dans le navigateur.
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEP_MS = 30000
export const DIGITS = 6
export const BACKUP_CODE_COUNT = 8

export function base32Encode(input) {
  const bytes = Buffer.from(input)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '')
  if (!clean) throw new Error('Secret base32 vide.')
  let bits = 0
  let value = 0
  const out = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) throw new Error(`Caractère base32 invalide : ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

// 160 bits = 32 caractères base32, recommandation RFC 4226 §4.
export function generateSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes))
}

export function hotp(key, counter, digits = DIGITS) {
  if (!Number.isFinite(Number(counter)) || Number(counter) < 0) throw new Error('Compteur HOTP invalide.')
  const material = Buffer.isBuffer(key) ? key : base32Decode(key)
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', material).update(buffer).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

export const stepAt = (ms, stepMs = STEP_MS) => Math.floor(Number(ms) / stepMs)

export function totp(secret, at = Date.now(), { stepMs = STEP_MS, digits = DIGITS } = {}) {
  return hotp(secret, stepAt(at, stepMs), digits)
}

// Vérifie un code à ±`window` pas (tolérance d'horloge de 30 s par défaut) et
// REFUSE tout pas déjà consommé : sans cela, un code observé (épaule, journal
// proxy) resterait valable 90 s et rejouable à l'infini pendant cette fenêtre.
export function verifyTotp(secret, code, { now = Date.now(), window = 1, stepMs = STEP_MS, digits = DIGITS, lastStep = 0 } = {}) {
  const clean = String(code ?? '').replace(/[\s-]/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) return { ok: false, reason: 'format' }
  if (!secret) return { ok: false, reason: 'no-secret' }
  const current = stepAt(now, stepMs)
  let replay = false
  for (let drift = -window; drift <= window; drift++) {
    const step = current + drift
    const expected = hotp(secret, step, digits)
    const match = timingSafeEqual(Buffer.from(expected), Buffer.from(clean))
    if (step <= Number(lastStep || 0)) { if (match) replay = true; continue }
    if (match) return { ok: true, step, drift }
  }
  // Motif distinct : un code VALIDE mais déjà consommé n'est pas un « code faux ».
  return { ok: false, reason: replay ? 'replay' : 'code' }
}

export function otpauthUrl({ secret, account, issuer = 'MON PARKING', digits = DIGITS, period = 30 }) {
  if (!secret) throw new Error('Secret requis pour le QR code.')
  const label = encodeURIComponent(`${issuer}:${account || 'compte'}`)
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) })
  return `otpauth://totp/${label}?${params.toString()}`
}

// Codes de secours : 8 codes de 10 caractères base32 (50 bits), affichés une
// seule fois, stockés uniquement sous forme de SHA-256.
export function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(8)).slice(0, 10)
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
}

export const normalizeBackupCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '')

export function hashBackupCode(code) {
  const clean = normalizeBackupCode(code)
  return clean ? createHash('sha256').update(clean).digest('hex') : ''
}
