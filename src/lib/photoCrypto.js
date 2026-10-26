// Chiffrement des photos de véhicules — AES-256-GCM, WebCrypto.
//
// MODÈLE DE CLÉ (et ses limites, dites franchement)
// ---------------------------------------------------------------------------
// 1. Chaque parking possède une clé de données (DEK) aléatoire de 256 bits.
// 2. La DEK n'est JAMAIS stockée en clair : elle est emballée (AES-GCM, IV
//    aléatoire) par une clé dérivée (KEK) de la phrase de coffre de
//    l'opérateur — PBKDF2-SHA256, 310 000 itérations, sel aléatoire de 16 octets.
//    La base ne contient donc que {sel, iv, DEK emballée} : sans la phrase de
//    coffre, le contenu est inexploitable, même pour qui lit IndexedDB.
// 3. Chaque image (photo ET vignette) est chiffrée séparément avec la DEK et un
//    IV aléatoire de 96 bits : deux photos identiques donnent deux chiffrés
//    différents, et une vignette ne fuit pas l'image pleine.
//
// CE QUE CELA NE PROTÈGE PAS
// - Quand le coffre est déverrouillé, la DEK vit dans le tas JavaScript de
//   l'onglet : un script injecté (XSS) ou une extension malveillante peut la
//   lire. Le chiffrement protège les données AU REPOS (vol de disque, copie de
//   la base, sauvegarde), pas un appareil déverrouillé avec l'application
//   ouverte. Verrouillage automatique par défaut : 10 minutes d'inactivité.
// - Une phrase de coffre faible est attaquable hors ligne (PBKDF2 ralentit
//   seulement l'attaque). Exiger 12 caractères et le dire à l'utilisateur.
// - Le serveur Node ne voit jamais ces images : elles ne quittent pas le
//   navigateur, donc aucune clé côté serveur, mais aucune récupération possible
//   si la phrase de coffre est perdue. C'est un choix, pas un oubli.
import { useEffect, useState } from 'react'
import { db, nowIso } from './db.js'

export const ENC_PREFIX = 'enc1:'
export const VAULT_VERSION = 1
export const DEFAULT_ITERATIONS = 310000
export const AUTO_LOCK_MINUTES = 10
const KEY_CACHE = new Map()
let autoLockMs = AUTO_LOCK_MINUTES * 60000
let lastActivity = Date.now()
const listeners = new Set()

// Vignette de remplacement : jamais l'image réelle quand le coffre est fermé.
export const LOCKED_TILE =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">' +
      '<rect width="320" height="240" fill="#0b1017"/>' +
      '<g fill="none" stroke="#3b4759" stroke-width="6" stroke-linecap="round">' +
      '<rect x="128" y="112" width="64" height="48" rx="8"/><path d="M140 112v-14a20 20 0 0 1 40 0v14"/></g>' +
      '<text x="160" y="196" font-family="sans-serif" font-size="14" fill="#6b7789" text-anchor="middle">Coffre verrouillé</text>' +
      '</svg>',
  )

const subtle = () => {
  const webcrypto = globalThis.crypto
  if (!webcrypto?.subtle) throw new Error('WebCrypto indisponible : utilisez HTTPS ou localhost.')
  return webcrypto.subtle
}

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text) {
  const binary = atob(String(text || ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const isEncryptedValue = (value) => typeof value === 'string' && value.startsWith(ENC_PREFIX)

async function deriveKek(passphrase, salt, iterations = DEFAULT_ITERATIONS) {
  const material = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const newIv = () => globalThis.crypto.getRandomValues(new Uint8Array(12))

export function assertPassphrase(passphrase) {
  const text = String(passphrase || '')
  if (text.length < 12) throw new Error('Phrase de coffre : 12 caractères minimum.')
  if (text.length > 256) throw new Error('Phrase de coffre trop longue (256 caractères maximum).')
  return text
}

/* ------------------------------- coffre ---------------------------------- */

export async function readVault(lotId) {
  const rows = await db.vaults.where('lotId').equals(lotId).toArray()
  return rows[0] || null
}

export async function vaultStatus(lotId) {
  const vault = await readVault(lotId)
  return { exists: !!vault, unlocked: KEY_CACHE.has(lotId), createdAt: vault?.createdAt || null, version: vault?.version || null }
}

export async function createVault(lotId, passphrase) {
  const text = assertPassphrase(passphrase)
  if (await readVault(lotId)) throw new Error('Un coffre existe déjà pour ce parking.')
  const dek = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = newIv()
  const kek = await deriveKek(text, salt)
  const wrapped = await subtle().encrypt({ name: 'AES-GCM', iv }, kek, dek)
  const row = {
    id: `vault:${lotId}`, lotId, version: VAULT_VERSION,
    salt: toBase64(salt), iv: toBase64(iv), wrapped: toBase64(wrapped),
    iterations: DEFAULT_ITERATIONS, createdAt: nowIso(),
  }
  await db.vaults.put(row)
  const key = await subtle().importKey('raw', dek, 'AES-GCM', false, ['encrypt', 'decrypt'])
  KEY_CACHE.set(lotId, key)
  dek.fill(0)
  touch()
  return { created: true }
}

export async function unlockVault(lotId, passphrase) {
  const vault = await readVault(lotId)
  if (!vault) throw new Error('Aucun coffre configuré pour ce parking.')
  const kek = await deriveKek(String(passphrase || ''), fromBase64(vault.salt), vault.iterations || DEFAULT_ITERATIONS)
  let dek
  try {
    dek = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(vault.iv) }, kek, fromBase64(vault.wrapped))
  } catch {
    // Message unique : ne pas distinguer « mauvaise phrase » d'« enregistrement
    // altéré » évite de donner un oracle à une attaque par essais.
    throw new Error('Phrase de coffre incorrecte.')
  }
  const key = await subtle().importKey('raw', dek, 'AES-GCM', false, ['encrypt', 'decrypt'])
  KEY_CACHE.set(lotId, key)
  new Uint8Array(dek).fill(0)
  touch()
  return { unlocked: true }
}

export function lockVault(lotId) {
  if (lotId) KEY_CACHE.delete(lotId)
  else KEY_CACHE.clear()
  for (const listener of listeners) { try { listener(lotId) } catch { /* un abonné fautif ne bloque pas */ } }
}

export const isUnlocked = (lotId) => KEY_CACHE.has(lotId)
export const onVaultLock = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
export const setAutoLockMinutes = (minutes) => { autoLockMs = Math.max(0, Number(minutes) || 0) * 60000 }

export function touch() {
  lastActivity = Date.now()
}

// Verrouillage automatique : appelé par l'interface (et testable).
export function checkAutoLock(now = Date.now()) {
  if (!autoLockMs) return false
  if (now - lastActivity < autoLockMs) return false
  if (!KEY_CACHE.size) return false
  lockVault()
  return true
}

/* ------------------------- chiffrement des images ------------------------- */

export async function encryptText(lotId, plaintext) {
  const key = KEY_CACHE.get(lotId)
  if (!key) throw new Error('Coffre verrouillé : déverrouillez-le pour chiffrer.')
  const iv = newIv()
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(String(plaintext)))
  return `${ENC_PREFIX}${toBase64(iv)}:${toBase64(ct)}`
}

export async function decryptText(lotId, payload) {
  const key = KEY_CACHE.get(lotId)
  if (!key) throw new Error('Coffre verrouillé.')
  const raw = String(payload || '')
  if (!isEncryptedValue(raw)) return raw
  const [ivPart, ctPart] = raw.slice(ENC_PREFIX.length).split(':')
  if (!ivPart || !ctPart) throw new Error('Charge chiffrée illisible.')
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(ivPart) }, key, fromBase64(ctPart))
  return new TextDecoder().decode(plain)
}

export const looksLikeImage = (value) => typeof value === 'string' && (/^data:image\//.test(value) || /^blob:/.test(value))

// Renvoie une ligne affichable : déchiffrée si possible, tuile verrouillée sinon.
// Ne lève jamais : une vignette manquante ne doit pas casser la fiche véhicule.
export async function openMedia(lotId, row) {
  if (!row) return row
  if (!row.enc && !isEncryptedValue(row.data) && !isEncryptedValue(row.thumb)) return row
  if (!KEY_CACHE.has(lotId)) return { ...row, data: LOCKED_TILE, thumb: LOCKED_TILE, locked: true }
  try {
    const [data, thumb] = await Promise.all([
      isEncryptedValue(row.data) ? decryptText(lotId, row.data) : row.data,
      isEncryptedValue(row.thumb) ? decryptText(lotId, row.thumb) : row.thumb,
    ])
    return { ...row, data, thumb, locked: false }
  } catch (error) {
    return { ...row, data: LOCKED_TILE, thumb: LOCKED_TILE, locked: true, error: error.message }
  }
}

const THUMB_CACHE = new Map()
export function clearMediaCache() { THUMB_CACHE.clear() }
onVaultLock(() => THUMB_CACHE.clear())

// Vignette de carte de stock : déchiffrement mémorisé, jamais l'image brute
// relue à chaque rendu (une liste de 40 véhicules ferait 40 déchiffrements).
export async function resolveThumb(lotId, value) {
  if (!value) return null
  if (!isEncryptedValue(value)) return value
  if (!KEY_CACHE.has(lotId)) return LOCKED_TILE
  const cached = THUMB_CACHE.get(value)
  if (cached) return cached
  try {
    const plain = await decryptText(lotId, value)
    THUMB_CACHE.set(value, plain)
    return plain
  } catch { return LOCKED_TILE }
}

// Hook d'affichage : renvoie la vignette déchiffrée, ou la tuile verrouillée.
export function useResolvedThumb(lotId, value) {
  const [src, setSrc] = useState(() => (value && !isEncryptedValue(value) ? value : null))
  useEffect(() => {
    let alive = true
    if (!value) { setSrc(null); return undefined }
    if (!isEncryptedValue(value)) { setSrc(value); return undefined }
    resolveThumb(lotId, value).then((next) => { if (alive) setSrc(next) })
    return () => { alive = false }
  }, [lotId, value])
  return src
}

export function mediaDigest(row) {
  // Empreinte non réversible utile aux tests : jamais l'image en clair.
  return String(row?.data || '').slice(0, 24)
}
