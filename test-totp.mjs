// Tests TOTP (RFC 6238 / RFC 4226) et du parcours 2FA complet côté serveur.
// Exécution : node test-totp.mjs
import assert from 'node:assert/strict'
import {
  base32Encode, base32Decode, hotp, totp, verifyTotp, generateSecret,
  otpauthUrl, generateBackupCodes, hashBackupCode, normalizeBackupCode, STEP_MS,
} from './server/totp.mjs'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore, hashServerPin } from './server/auth-store.mjs'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK  ', name) }
  catch (error) { failed++; console.log('FAIL', name, '→', error.message) }
}
const eq = (a, b, label) => assert.deepEqual(a, b, `${label} : attendu ${JSON.stringify(b)}, reçu ${JSON.stringify(a)}`)

// Secret de l'annexe B des RFC : « 12345678901234567890 » en ASCII.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

/* ---------------------------- 1. Vecteurs RFC ---------------------------- */
await check('t1 : HOTP/TOTP reproduisent les vecteurs de la RFC 6238 (SHA-1)', () => {
  eq(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'encodage base32 du secret RFC')
  const vectors = [
    [59, '287082', '94287082'],
    [1111111109, '081804', '07081804'],
    [1111111111, '050471', '14050471'],
    [1234567890, '005924', '89005924'],
    [2000000000, '279037', '69279037'],
    [20000000000, '353130', '65353130'],
  ]
  for (const [seconds, six, eight] of vectors) {
    const at = seconds * 1000
    eq(totp(RFC_SECRET, at), six, `TOTP 6 chiffres à T=${seconds}`)
    eq(hotp(RFC_SECRET, Math.floor(seconds / 30), 8), eight, `HOTP 8 chiffres à T=${seconds}`)
  }
})

await check('t2 : le pas de temps est de 30 s et change exactement au bon moment', () => {
  const base = 1700000000000
  const boundary = Math.floor(base / STEP_MS) * STEP_MS
  assert.notEqual(totp(RFC_SECRET, boundary - 1), totp(RFC_SECRET, boundary), 'le code doit changer au pas suivant')
  eq(totp(RFC_SECRET, boundary), totp(RFC_SECRET, boundary + STEP_MS - 1), 'code stable dans le même pas')
})

await check('t3 : base32 fait un aller-retour fidèle et rejette les caractères invalides', () => {
  for (const text of ['A', 'MON PARKING', 'ÿþü']) {
    eq(base32Decode(base32Encode(Buffer.from(text, 'utf8'))).toString('utf8'), text, `aller-retour « ${text} »`)
  }
  // Un secret vide est refusé plutôt que décodé en clé vide (sinon tout code
  // calculé avec une clé nulle serait accepté).
  assert.throws(() => base32Decode(''), /Secret base32 vide/)
  assert.throws(() => base32Decode('ABC1'), /Caractère base32 invalide/)
})

await check('t4 : generateSecret produit 160 bits (32 caractères base32) distincts', () => {
  const a = generateSecret(), b = generateSecret()
  eq(a.length, 32, 'longueur base32')
  assert.notEqual(a, b, 'deux secrets doivent différer')
  assert.match(a, /^[A-Z2-7]{32}$/)
})

/* --------------------------- 2. Vérification ---------------------------- */
await check('t5 : la tolérance d’horloge accepte ±1 pas et refuse ±2', () => {
  const now = 1700000000000
  const previous = totp(RFC_SECRET, now - STEP_MS)
  const current = totp(RFC_SECRET, now)
  const next = totp(RFC_SECRET, now + STEP_MS)
  const tooFar = totp(RFC_SECRET, now + 2 * STEP_MS)
  eq(verifyTotp(RFC_SECRET, previous, { now }).ok, true, 'pas précédent accepté')
  eq(verifyTotp(RFC_SECRET, current, { now }).ok, true, 'pas courant accepté')
  eq(verifyTotp(RFC_SECRET, next, { now }).ok, true, 'pas suivant accepté')
  eq(verifyTotp(RFC_SECRET, tooFar, { now }).ok, false, 'deux pas plus tard refusé')
})

await check('t6 : un même code ne peut pas être rejoué (anti-rejeu)', () => {
  const now = 1700000000000
  const code = totp(RFC_SECRET, now)
  const first = verifyTotp(RFC_SECRET, code, { now })
  eq(first.ok, true, 'première utilisation acceptée')
  const replay = verifyTotp(RFC_SECRET, code, { now: now + 1000, lastStep: first.step })
  eq(replay.ok, false, 'rejeu refusé')
  eq(replay.reason, 'replay', 'motif explicite pour l’interface')
})

await check('t7 : formats invalides et secrets absents sont refusés sans exception', () => {
  eq(verifyTotp(RFC_SECRET, '12345', {}).reason, 'format', '5 chiffres')
  eq(verifyTotp(RFC_SECRET, 'abcdef', {}).reason, 'format', 'lettres')
  eq(verifyTotp('', '123456', {}).reason, 'no-secret', 'secret vide')
  eq(verifyTotp(RFC_SECRET, '123456', {}).ok, false, 'code faux')
})

/* --------------------------- 3. Enrôlement ------------------------------ */
await check('t8 : l’URL otpauth est conforme et échappée', () => {
  const secret = generateSecret()
  const url = new URL(otpauthUrl({ secret, account: 'admin', issuer: 'MON PARKING' }))
  eq(url.protocol, 'otpauth:', 'schéma')
  eq(url.host, 'totp', 'type')
  eq(decodeURIComponent(url.pathname), '/MON PARKING:admin', 'libellé')
  eq(url.searchParams.get('secret'), secret, 'secret')
  eq(url.searchParams.get('algorithm'), 'SHA1', 'algorithme')
  eq(url.searchParams.get('digits'), '6', 'chiffres')
  eq(url.searchParams.get('period'), '30', 'période')
  assert(url.toString().includes('issuer=MON+PARKING') || url.toString().includes('issuer=MON%20PARKING'), 'issuer encodé')
})

await check('t9 : les codes de secours sont uniques, normalisables et hachés', () => {
  const codes = generateBackupCodes()
  eq(codes.length, 8, 'nombre de codes')
  eq(new Set(codes.map(normalizeBackupCode)).size, 8, 'tous distincts')
  for (const code of codes) assert.match(code, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/, `format de ${code}`)
  eq(hashBackupCode('abcde-fghij'), hashBackupCode('ABCDE FGHIJ'), 'normalisation avant hachage')
  eq(hashBackupCode(codes[0]).length, 64, 'empreinte SHA-256')
  assert.notEqual(hashBackupCode(codes[0]), codes[0].replace('-', ''), 'jamais stocké en clair')
})

/* ------------------- 4. Parcours serveur complet (AuthStore) ------------ */
function makeStore(nowRef = { t: 1700000000000 }) {
  const store = new AuthStore(':memory:', { now: () => nowRef.t })
  const lot = { id: 'lot-1', name: 'Parc Test', code: 'PARC' }
  store.sql.prepare('INSERT INTO lots VALUES(?,?)').run(lot.id, JSON.stringify(lot))
  return { store, nowRef }
}

async function seed(store, username = 'admin', role = 'admin') {
  const pin = '1234'
  const credentials = await hashServerPin(pin)
  store.sql.prepare('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt) VALUES(?,?,?,?,?,?,?,?)')
    .run(`acc-${username}`, `acc-${username}`, username, 'Compte Test', role, 'lot-1', credentials.hash, credentials.salt)
  return { pin, id: `acc-${username}` }
}

await check('t10 : PIN seul → défi MFA, puis code TOTP → session réelle', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store)
  const first = await store.login('admin', pin)
  assert(first.token, 'une session doit être ouverte avant l’activation')
  const enrollment = store.enrollTotp(first.token)
  assert.match(enrollment.secret, /^[A-Z2-7]{32}$/, 'secret renvoyé une seule fois')
  assert(enrollment.otpauth.startsWith('otpauth://totp/'), 'URI otpauth fournie pour le QR code')

  const activation = store.activateTotp(first.token, totp(enrollment.secret, nowRef.t))
  eq(activation.backupCodes.length, 8, 'codes de secours affichés à l’activation')

  const second = await store.login('admin', pin)
  eq(second.mfaRequired, true, 'le PIN seul n’ouvre plus de session')
  assert(!second.token, 'aucun cookie de session avant le second facteur')
  const row = store.sql.prepare("SELECT token_hash FROM sessions").all()
  eq(row.length, 1, 'la session existante reste la seule (aucune nouvelle émise)')

  nowRef.t += STEP_MS // le pas précédent est consommé : on attend le suivant
  const session = store.completeMfa(second.challenge, totp(enrollment.secret, nowRef.t))
  assert(session.token, 'session émise après le second facteur')
  eq(store.authenticate(session.token).username, 'admin', 'le jeton est utilisable')
})

await check('t11 : un code déjà consommé est refusé avec un motif explicite', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'agent1')
  const first = await store.login('agent1', pin)
  const { secret } = store.enrollTotp(first.token)
  store.activateTotp(first.token, totp(secret, nowRef.t))
  const challenge = await store.login('agent1', pin)
  const code = totp(secret, nowRef.t)
  assert.throws(() => store.completeMfa(challenge.challenge, code), /vient d’être utilisé|incorrect/)
  nowRef.t += STEP_MS
  assert(store.completeMfa(challenge.challenge, totp(secret, nowRef.t)).token, 'le pas suivant passe')
})

await check('t12 : cinq codes faux verrouillent le second facteur une minute', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'agent2')
  const first = await store.login('agent2', pin)
  const { secret } = store.enrollTotp(first.token)
  store.activateTotp(first.token, totp(secret, nowRef.t))
  const challenge = await store.login('agent2', pin)
  for (let i = 0; i < 5; i++) {
    // Les 4 premiers essais renvoient « incorrect », le 5e verrouille (429).
    assert.throws(() => store.completeMfa(challenge.challenge, '000000'), /incorrect|Trop de codes/)
  }
  let locked = null
  try { store.completeMfa(challenge.challenge, totp(secret, nowRef.t + STEP_MS)) } catch (error) { locked = error }
  assert(locked, 'une fois verrouillé, même un code valide échoue')
  assert(/Trop de codes/.test(locked.message), `message de verrouillage, reçu : ${locked.message}`)
  eq(locked.status, 429, 'statut 429 attendu')
  assert(locked.retryAfter > 0, 'Retry-After renseigné')
  // Le défi a été invalidé au 5e échec : on repart d'une connexion PIN neuve.
  nowRef.t += 61000
  const fresh = await store.login('agent2', pin)
  assert(fresh.challenge, 'nouveau défi après le verrouillage')
  assert(store.completeMfa(fresh.challenge, totp(secret, nowRef.t + STEP_MS)).token, 'déverrouillé après une minute')
})

await check('t13 : un code de secours fonctionne une seule fois et décrémente le stock', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'agent3')
  const first = await store.login('agent3', pin)
  const { secret } = store.enrollTotp(first.token)
  const { backupCodes } = store.activateTotp(first.token, totp(secret, nowRef.t))
  const challenge = await store.login('agent3', pin)
  const session = store.completeMfa(challenge.challenge, backupCodes[0])
  assert(session.token, 'le code de secours ouvre une session')
  eq(store.identity(store.authenticate(session.token)).mfa.backupRemaining, 7, 'stock décrémenté')
  const again = await store.login('agent3', pin)
  assert.throws(() => store.completeMfa(again.challenge, backupCodes[0]), /incorrect/, 'rejeu du code de secours refusé')
})

await check('t14 : le défi expire après 5 minutes et un seul défi vit par compte', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'agent4')
  const first = await store.login('agent4', pin)
  const { secret } = store.enrollTotp(first.token)
  store.activateTotp(first.token, totp(secret, nowRef.t))
  const c1 = await store.login('agent4', pin)
  const c2 = await store.login('agent4', pin)
  assert.notEqual(c1.challenge, c2.challenge, 'nouveau défi')
  assert.throws(() => store.completeMfa(c1.challenge, totp(secret, nowRef.t + STEP_MS)), /expirée/, 'ancien défi invalidé')
  nowRef.t += 5 * 60000 + 1
  assert.throws(() => store.completeMfa(c2.challenge, totp(secret, nowRef.t + STEP_MS)), /expirée/, 'défi expiré')
})

await check('t15 : le défi est stocké haché, jamais en clair', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'agent5')
  const first = await store.login('agent5', pin)
  const { secret } = store.enrollTotp(first.token)
  store.activateTotp(first.token, totp(secret, nowRef.t))
  const challenge = await store.login('agent5', pin)
  const rows = store.sql.prepare('SELECT token_hash FROM login_challenges').all()
  eq(rows.length, 1, 'un défi enregistré')
  assert.notEqual(rows[0].token_hash, challenge.challenge, 'valeur stockée différente du jeton')
  eq(rows[0].token_hash.length, 64, 'empreinte SHA-256')
})

await check('t16 : désactivation exige le PIN, révoque les sessions et efface le secret', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'agent6')
  const first = await store.login('agent6', pin)
  const { secret } = store.enrollTotp(first.token)
  store.activateTotp(first.token, totp(secret, nowRef.t))
  await assert.rejects(store.disableTotp(first.token, '9999'), /PIN incorrect/, 'mauvais PIN refusé')
  await store.disableTotp(first.token, pin)
  const row = store.sql.prepare("SELECT totp_secret,totp_active,totp_backup,generation FROM accounts WHERE username='agent6'").get()
  eq([row.totp_secret, row.totp_active, row.totp_backup], ['', 0, '[]'], 'secret et codes de secours effacés')
  eq(store.sql.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0, 'sessions révoquées')
  const plain = await store.login('agent6', pin)
  assert(plain.token, 'retour à une connexion PIN seule')
})

await check('t17 : une réinitialisation de PIN par l’admin annule la 2FA', async () => {
  const { store, nowRef } = makeStore()
  const { pin, id } = await seed(store, 'agent7')
  const admin = await store.login('agent7', pin)
  const { secret } = store.enrollTotp(admin.token)
  store.activateTotp(admin.token, totp(secret, nowRef.t))
  // L'admin réinitialise son propre PIN : le second facteur ne doit pas rester
  // accroché à un secret que l'attaquant aurait pu enrôler.
  await store.updateUser(admin.token, id, { pin: '5678' })
  const row = store.sql.prepare("SELECT totp_active,totp_secret FROM accounts WHERE id=?").get(id)
  eq([row.totp_active, row.totp_secret], [0, ''], '2FA remise à zéro')
  assert((await store.login('agent7', '5678')).token, 'connexion avec le nouveau PIN, sans second facteur')
})

await check('t18 : la politique AUTH_2FA_POLICY est exposée sans verrouiller la connexion', async () => {
  const { store } = makeStore()
  await seed(store, 'admin', 'admin')
  await seed(store, 'vendeur', 'employe')
  const read = (username) => store.identity(store.sql.prepare('SELECT * FROM accounts WHERE username=?').get(username)).mfa
  const previous = process.env.AUTH_2FA_POLICY
  try {
    process.env.AUTH_2FA_POLICY = 'admin'
    eq(read('admin').required, true, 'admin soumis à la politique')
    eq(read('vendeur').required, false, 'employé non concerné')
    process.env.AUTH_2FA_POLICY = 'all'
    eq(read('vendeur').required, true, 'tous concernés')
    process.env.AUTH_2FA_POLICY = 'n_importe_quoi'
    eq(read('admin').policy, 'off', 'valeur inconnue → politique désactivée')
    eq(store.mfaState(store.sql.prepare("SELECT * FROM accounts WHERE username='admin'").get()).enabled, false, 'aucun enrôlement par défaut')
  } finally {
    if (previous === undefined) delete process.env.AUTH_2FA_POLICY
    else process.env.AUTH_2FA_POLICY = previous
  }
})


/* ------------------ 5. Revue de sécurité v19.1 (correctifs) -------------- */
await check('t19 : le secret TOTP est scellé (AES-256-GCM) et absent de la base', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'sec1')
  const first = await store.login('sec1', pin)
  const { secret } = store.enrollTotp(first.token)
  const stored = store.sql.prepare("SELECT totp_secret FROM accounts WHERE username='sec1'").get().totp_secret
  assert(stored.startsWith('v1:'), `préfixe de scellement attendu, reçu « ${stored.slice(0, 6)} »`)
  assert(!stored.includes(secret), 'le secret base32 ne doit pas apparaître en clair dans la base')
  eq(stored.split(':').length, 4, 'format v1:iv:chiffré:tag')
  eq(store.secretOf({ totp_secret: stored }), secret, 'le déchiffrement restitue le secret exact')
  // Un enregistrement falsifié ne doit jamais produire un secret utilisable.
  const [head, iv, ct, tag] = stored.split(':')
  const tampered = [head, iv, ct, Buffer.alloc(16).toString('base64')].join(':')
  eq(store.secretOf({ totp_secret: tampered }), '', 'tag GCM invalide → chaîne vide (échec fermé)')
  const activated = store.activateTotp(first.token, totp(store.secretOf({ totp_secret: stored }), nowRef.t))
  eq(activated.ok, true, 'l’activation fonctionne avec le secret scellé')
})

await check('t20 : l’activation est limitée à 5 essais (brute-force du code bloquée)', async () => {
  const { store, nowRef } = makeStore()
  const { pin } = await seed(store, 'sec2')
  const first = await store.login('sec2', pin)
  const { secret } = store.enrollTotp(first.token)
  for (let i = 0; i < 4; i++) {
    assert.throws(() => store.activateTotp(first.token, '000000'), /Code incorrect/)
  }
  // 5e essai : verrouillage
  let locked = null
  try { store.activateTotp(first.token, '000000') } catch (error) { locked = error }
  assert(locked, 'le 5e échec doit lever')
  eq(locked.status, 429, 'statut 429 attendu au 5e échec')
  assert(locked.retryAfter > 0, 'Retry-After renseigné')
  // Pendant le verrouillage, même le BON code est refusé : c'est le but.
  let blocked = null
  try { store.activateTotp(first.token, totp(secret, nowRef.t)) } catch (error) { blocked = error }
  eq(blocked?.status, 429, 'bon code refusé pendant le verrouillage')
  nowRef.t += 61000
  eq(store.activateTotp(first.token, totp(secret, nowRef.t)).ok, true, 'activation possible après une minute')
})

await check('t21 : un ancien secret en clair est scellé au démarrage suivant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mp-2fa-'))
  const file = join(dir, 'auth.sqlite')
  const secret = generateSecret()
  try {
    const first = new AuthStore(file)
    first.sql.prepare('INSERT INTO lots VALUES(?,?)').run('lot-1', JSON.stringify({ id: 'lot-1', name: 'Parc' }))
    const credentials = await hashServerPin('1234')
    first.sql.prepare('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt,totp_secret,totp_active) VALUES(?,?,?,?,?,?,?,?,?,1)')
      .run('a-legacy', 'p-legacy', 'legacy', 'Ancien compte', 'admin', 'lot-1', credentials.hash, credentials.salt, secret)
    eq(first.sql.prepare("SELECT totp_secret FROM accounts WHERE username='legacy'").get().totp_secret, secret, 'secret en clair avant migration')
    first.close()

    const second = new AuthStore(file)
    const migrated = second.sql.prepare("SELECT totp_secret FROM accounts WHERE username='legacy'").get().totp_secret
    assert(migrated.startsWith('v1:'), 'secret scellé après réouverture')
    assert(!migrated.includes(secret), 'plus aucun clair en base')
    eq(second.secretOf({ totp_secret: migrated }), secret, 'secret toujours exploitable')
    assert(existsSync(join(dir, 'auth-store.key')), 'clé de scellement créée à côté de la base')
    eq(statSync(join(dir, 'auth-store.key')).mode & 0o777, 0o600, 'clé en 0600')
    const login = await second.login('legacy', '1234')
    eq(login.mfaRequired, true, 'la 2FA reste exigée après migration')
    assert(second.completeMfa(login.challenge, totp(secret, Date.now())).token, 'le code de l’authentificateur existant fonctionne')
    second.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

console.log(`\nTOTP / 2FA : ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
