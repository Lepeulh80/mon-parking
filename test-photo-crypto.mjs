// Tests du chiffrement des photos (AES-256-GCM, WebCrypto réel de Node 22).
// Aucun DOM : photoCrypto.js est volontairement sans dépendance navigateur.
// Exécution : node test-photo-crypto.mjs
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  createVault, readVault, unlockVault, lockVault, isUnlocked, vaultStatus,
  encryptText, decryptText, openMedia, resolveThumb, isEncryptedValue,
  assertPassphrase, checkAutoLock, setAutoLockMinutes, LOCKED_TILE, ENC_PREFIX,
  onVaultLock, clearMediaCache,
} from './src/lib/photoCrypto.js'
import { db } from './src/lib/db.js'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK  ', name) }
  catch (error) { failed++; console.log('FAIL', name, '→', error.message) }
}
const eq = (a, b, label) => assert.deepEqual(a, b, `${label} : attendu ${JSON.stringify(b)}, reçu ${JSON.stringify(a)}`)

const LOT = 'lot-crypto'
const PHRASE = 'phrase de coffre solide 2026'

// Image factice : un JPEG minimal encodé en data URL, comme le produit photos.js.
const IMAGE = 'data:image/jpeg;base64,' + Buffer.from('FAKE-JPEG-CONTENT-'.repeat(40)).toString('base64')
const THUMB = 'data:image/jpeg;base64,' + Buffer.from('FAKE-THUMB'.repeat(10)).toString('base64')

/* --------------------------- 1. Création du coffre --------------------------- */
await check('c1 : une phrase de coffre trop courte est refusée', async () => {
  assert.throws(() => assertPassphrase('court'), /12 caractères minimum/)
  assert.throws(() => assertPassphrase(''), /12 caractères minimum/)
  eq(assertPassphrase(PHRASE), PHRASE, 'phrase valide conservée telle quelle')
})

await check('c2 : le coffre ne contient AUCUNE clé en clair', async () => {
  const status = await vaultStatus(LOT)
  eq([status.exists, status.unlocked], [false, false], 'aucun coffre au départ')
  await createVault(LOT, PHRASE)
  const vault = await readVault(LOT)
  assert(vault, 'ligne de coffre créée')
  eq(Object.keys(vault).sort(), ['createdAt', 'id', 'iterations', 'iv', 'lotId', 'salt', 'version', 'wrapped'].sort(), 'champs attendus')
  eq(vault.iterations, 310000, 'PBKDF2-SHA256 310 000 itérations')
  eq(vault.version, 1, 'version du format')
  // Le sel, l'IV et la clé emballée sont en base64 de longueurs attendues ; la
  // phrase de coffre n'apparaît nulle part dans l'enregistrement.
  assert(!JSON.stringify(vault).includes(PHRASE), 'la phrase de coffre ne doit pas être stockée')
  assert(!JSON.stringify(vault).includes(Buffer.from(PHRASE).toString('base64')), 'ni son encodage base64')
  eq(isUnlocked(LOT), true, 'créer un coffre le laisse déverrouillé pour la session')
})

await check('c3 : verrouiller puis déverrouiller avec la bonne phrase', async () => {
  lockVault(LOT)
  eq(isUnlocked(LOT), false, 'verrouillé après lockVault')
  await assert.rejects(unlockVault(LOT, 'mauvaise phrase de coffre'), /Phrase de coffre incorrecte/, 'phrase erronée refusée')
  eq(isUnlocked(LOT), false, 'toujours verrouillé après un échec')
  await unlockVault(LOT, PHRASE)
  eq(isUnlocked(LOT), true, 'déverrouillé avec la bonne phrase')
})

/* ------------------------- 2. Chiffrement des images ------------------------ */
await check('c4 : aller-retour image pleine et vignette', async () => {
  const sealed = await encryptText(LOT, IMAGE)
  assert(sealed.startsWith(ENC_PREFIX), 'préfixe de version présent')
  eq(await decryptText(LOT, sealed), IMAGE, 'image restituée à l’identique')
  const sealedThumb = await encryptText(LOT, THUMB)
  assert.notEqual(sealedThumb, sealed, 'la vignette a son propre chiffré')
  eq(await decryptText(LOT, sealedThumb), THUMB, 'vignette restituée')
})

await check('c5 : le clair n’apparaît pas dans le chiffré et deux chiffrements diffèrent', async () => {
  const a = await encryptText(LOT, IMAGE)
  const b = await encryptText(LOT, IMAGE)
  assert.notEqual(a, b, 'IV aléatoire : deux chiffrés du même clair diffèrent')
  const payload = a.slice(ENC_PREFIX.length).split(':')[1]
  const raw = Buffer.from(payload, 'base64').toString('latin1')
  assert(!raw.includes('FAKE-JPEG'), 'aucun fragment du clair dans le chiffré')
  assert(a.length > IMAGE.length * 0.6, 'le chiffré a une taille plausible (pas une troncature)')
})

await check('c6 : toute altération du chiffré est rejetée (intégrité GCM)', async () => {
  const sealed = await encryptText(LOT, IMAGE)
  const [iv, ct] = sealed.slice(ENC_PREFIX.length).split(':')
  const bytes = Buffer.from(ct, 'base64')
  bytes[10] ^= 0xff // un seul bit modifié
  const tampered = `${ENC_PREFIX}${iv}:${bytes.toString('base64')}`
  await assert.rejects(decryptText(LOT, tampered), /operation failed|too small|décrypt|Unsupported|auth/i, 'chiffré altéré refusé')
  const wrongIv = `${ENC_PREFIX}${Buffer.alloc(12).toString('base64')}:${ct}`
  await assert.rejects(decryptText(LOT, wrongIv), /operation failed|too small|décrypt|Unsupported|auth/i, 'IV altéré refusé')
  // La troncature du tag d'authentification doit aussi échouer.
  const shortCt = Buffer.from(ct, 'base64').subarray(0, 12).toString('base64')
  await assert.rejects(decryptText(LOT, `${ENC_PREFIX}${iv}:${shortCt}`), /operation failed|too small|décrypt|Unsupported|auth/i, 'chiffré tronqué refusé')
})

await check('c7 : coffre verrouillé → aucune image lisible, remplacée par la tuile', async () => {
  const row = { data: await encryptText(LOT, IMAGE), thumb: await encryptText(LOT, THUMB), enc: true }
  lockVault(LOT)
  const locked = await openMedia(LOT, row)
  eq([locked.data, locked.thumb, locked.locked], [LOCKED_TILE, LOCKED_TILE, true], 'tuile de remplacement')
  assert(!locked.data.includes('FAKE'), 'jamais de fuite du contenu')
  eq(await resolveThumb(LOT, row.thumb), LOCKED_TILE, 'vignette de carte elle aussi verrouillée')
  await assert.rejects(encryptText(LOT, IMAGE), /Coffre verrouillé/, 'impossible de chiffrer coffre fermé')
})

await check('c8 : déverrouillé → images et vignettes restituées, cache invalidé au verrouillage', async () => {
  await unlockVault(LOT, PHRASE)
  const row = { data: await encryptText(LOT, IMAGE), thumb: await encryptText(LOT, THUMB), enc: true }
  const open = await openMedia(LOT, row)
  eq([open.data, open.thumb, open.locked], [IMAGE, THUMB, false], 'tout est déchiffré')
  const thumb = await resolveThumb(LOT, row.thumb)
  eq(thumb, THUMB, 'vignette renvoyée')
  eq(await resolveThumb(LOT, row.thumb), THUMB, 'seconde lecture servie par le cache')
  lockVault(LOT)
  clearMediaCache()
  eq(await resolveThumb(LOT, row.thumb), LOCKED_TILE, 'après verrouillage, plus aucune vignette en clair')
})

await check('c9 : les médias antérieurs en clair restent lisibles', async () => {
  const legacy = { data: IMAGE, thumb: THUMB, enc: false }
  const open = await openMedia(LOT, legacy)
  eq([open.data, open.thumb], [IMAGE, THUMB], 'aucun déchiffrement tenté')
  eq(await resolveThumb(LOT, THUMB), THUMB, 'vignette en clair renvoyée telle quelle')
})

/* -------------------------- 3. Cloisonnement par parking ------------------- */
await check('c10 : la clé d’un parking n’ouvre pas les images d’un autre', async () => {
  await unlockVault(LOT, PHRASE)
  const other = 'lot-autre'
  await createVault(other, 'autre phrase de coffre 42')
  const sealed = await encryptText(other, IMAGE)
  await assert.rejects(decryptText(LOT, sealed), /operation failed|too small|décrypt|Unsupported|auth/i, 'clé étrangère refusée')
  eq(await decryptText(other, sealed), IMAGE, 'la bonne clé fonctionne')
  lockVault(other)
})

await check('c11 : le verrouillage notifie les abonnés', async () => {
  let calls = 0
  const off = onVaultLock(() => { calls++ })
  await unlockVault(LOT, PHRASE)
  lockVault()
  eq(calls, 1, 'un seul appel par verrouillage global')
  off()
  await unlockVault(LOT, PHRASE)
  lockVault()
  eq(calls, 1, 'désabonnement effectif')
})

await check('c12 : verrouillage automatique après inactivité', async () => {
  await unlockVault(LOT, PHRASE)
  setAutoLockMinutes(10)
  eq(checkAutoLock(Date.now()), false, 'activité récente : pas de verrouillage')
  eq(checkAutoLock(Date.now() + 11 * 60000), true, 'au-delà de 10 min : verrouillé')
  eq(isUnlocked(LOT), false, 'clé retirée')
  setAutoLockMinutes(0)
  await unlockVault(LOT, PHRASE)
  eq(checkAutoLock(Date.now() + 365 * 86400000), false, 'délai 0 = jamais')
  setAutoLockMinutes(10)
})

await check('c13 : la base ne conserve que des charges « enc1: » pour les médias scellés', async () => {
  const row = {
    id: 'pho-test', lotId: LOT, vehicleId: 'veh-1', kind: 'photo', sort: 1,
    data: await encryptText(LOT, IMAGE), thumb: await encryptText(LOT, THUMB), enc: true,
    bytes: 1000, createdAt: new Date().toISOString(),
  }
  await db.vehiclePhotos.put(row)
  const stored = await db.vehiclePhotos.get('pho-test')
  assert(isEncryptedValue(stored.data) && isEncryptedValue(stored.thumb), 'les deux champs sont chiffrés')
  eq(stored.enc, true, 'drapeau de chiffrement présent')
  const dump = JSON.stringify(stored)
  assert(!dump.includes('FAKE-JPEG'), 'aucun clair dans la ligne IndexedDB')
  eq((await openMedia(LOT, stored)).data, IMAGE, 'lecture déchiffrée depuis la base')
  await db.vehiclePhotos.delete('pho-test')
})

console.log(`\nCHIFFREMENT PHOTOS : ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
