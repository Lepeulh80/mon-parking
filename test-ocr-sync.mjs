/**
 * Réplication de l'apprentissage OCR — test hors ligne.
 *
 * Aucune connexion Supabase réelle : un client simulé sert de « table
 * partagée ». Deux postes y écrivent, un troisième relit, et l'on vérifie que
 * les coûts de substitution fusionnés changent le classement.
 */
import 'fake-indexeddb/auto'
import { db } from './src/lib/db.js'
import { aggregate } from './src/lib/learning.js'
import { plateScore } from './src/lib/match.js'
import { recordFeedback, resetLearning } from './src/lib/learningStore.js'
import {
  setPosteId, getPosteId, newUuid, stableUuid, toRemote, fromRemote,
  pushOutbox, pullRemote, syncFeedback, mergedLearning, pendingFeedback,
} from './src/lib/ocrSync.js'

let ok = 0
let ko = 0
const pass = (m, extra = '') => { ok += 1; console.log('OK  ', m, extra) }
const fail = (m, extra = '') => { ko += 1; console.log('KO  ', m, extra) }
const check = (m, cond, extra = '') => (cond ? pass(m, extra) : fail(m, extra))

/* ------------------------- faux client Supabase ------------------------- */
function mockRemote() {
  const rows = new Map()
  let tick = 0
  const builder = () => {
    const b = {
      _filters: [], _orders: [], _offset: 0, _limit: 1000,
      select() { return b },
      eq(c, v) { b._filters.push([c, (x) => x === v]); return b },
      gte(c, v) { b._filters.push([c, (x) => !v || String(x) >= String(v)]); return b },
      gt(c, v) { b._filters.push([c, (x) => !v || String(x) > String(v)]); return b },
      order(c, o) { b._orders.push([c, o?.ascending === false ? -1 : 1]); return b },
      range(a, z) { b._offset = a; b._limit = z - a + 1; return b },
      limit(n) { b._limit = n; return b },
      upsert(list) {
        let inserted = 0
        let skipped = 0
        for (const r of list) {
          if (rows.has(r.id)) { skipped += 1; continue } // ignoreDuplicates
          tick += 1
          rows.set(r.id, { ...r, created_at: new Date(Date.now() + tick).toISOString() })
          inserted += 1
        }
        return Promise.resolve({ error: null, data: { inserted, skipped } })
      },
      then(res, rej) {
        let out = [...rows.values()]
        for (const [c, fn] of b._filters) out = out.filter((r) => fn(r[c]))
        out.sort((x,y) => { for (const [c,dir] of b._orders) { if (x[c] !== y[c]) return (String(x[c]) < String(y[c]) ? -1 : 1) * dir }; return 0 })
        out = out.slice(b._offset, b._offset + b._limit)
        return Promise.resolve({ data: out, error: null }).then(res, rej)
      },
    }
    return b
  }
  return {
    rows,
    auth: { getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }) },
    from: () => builder(),
    seed(row) {
      tick += 1
      rows.set(row.id, { ...row, created_at: row.created_at || new Date(Date.now() + tick).toISOString() })
    },
  }
}

const LOT = '11111111-1111-4111-8111-111111111111'
const CANDIDATES = [
  { id: 't1', plate: 'CI AA71 AB', kind: 'ticket', label: 'Ticket TCK-2026-0042' },
  { id: 't2', plate: 'CI 4471 AB', kind: 'ticket', label: 'Ticket TCK-2026-0043' },
]
const rankBy = (input, learning) => CANDIDATES
  .map((c) => ({ plate: c.plate, ...plateScore(input, c.plate, learning) }))
  .sort((a, b) => b.score - a.score)

const RAW = '. C1 4A71 AB'   // lecture OCR : « 1 » au lieu de « I », « 4 » au lieu de « A »
const TRUTH = 'CI AA71 AB'

console.log('=== 1. Mode local : aucune configuration Supabase ===')
setPosteId('poste_AAAA1111')
const offline = await syncFeedback(LOT)
check('synchronisation sans client → mode local, sans exception', offline.mode === 'local', `mode=${offline.mode}`)

const evA = await recordFeedback({
  lotId: LOT, userId: 'u_admin', userName: 'Awa',
  raw: RAW, chosen: TRUTH, rejected: ['CI 4471 AB'], source: 'suggestion',
})
check('confirmation enregistrée localement', !!evA?.id)
check('identifiant local = UUID (clé distante)', /^[0-9a-f-]{36}$/i.test(evA.id), evA.id)
check('ligne marquée en file d’attente', evA.synced === 0)
check('UUID stable pour une même ligne', stableUuid('x') === stableUuid('x') && stableUuid('x') !== stableUuid('y'))

let agg = await mergedLearning(LOT)
check('une seule confirmation → aucune paire active', agg.counts.pairsActive === 0, `paires=${agg.counts.pairsTotal}`)
let ranking = rankBy(RAW, agg)
check('sans apprentissage, les deux plaques sont à égalité',
  ranking[0].score === ranking[1].score, `${ranking[0].plate} ${ranking[0].score} / ${ranking[1].plate} ${ranking[1].score}`)

console.log('\n=== 2. Envoi du poste A ===')
const remote = mockRemote()
const p1 = await pushOutbox(LOT, { sb: remote })
check('une ligne poussée', p1.pushed === 1, `pushed=${p1.pushed}`)
check('table distante : 1 ligne', remote.rows.size === 1, `lignes=${remote.rows.size}`)
const remoteRow = [...remote.rows.values()][0]
check('clé primaire = UUID local', remoteRow.id === evA.id)
check('poste_id renseigné', remoteRow.poste_id === 'poste_AAAA1111', remoteRow.poste_id)
check('lot_id renseigné', remoteRow.lot_id === LOT)
check('paires transmises', JSON.stringify(remoteRow.pairs) === JSON.stringify(['1>I', '4>A']), JSON.stringify(remoteRow.pairs))

const p2 = await pushOutbox(LOT, { sb: remote })
check('rejouer l’envoi ne crée pas de doublon', p2.pushed === 0 && remote.rows.size === 1, `pushed=${p2.pushed} lignes=${remote.rows.size}`)
check('plus rien en file d’attente', (await pendingFeedback(LOT)).length === 0)

console.log('\n=== 3. Le poste B confirme la même confusion ===')
remote.seed({
  id: newUuid(), lot_id: LOT, poste_id: 'poste_BBBB2222', at: new Date().toISOString(),
  user_id: 'u_emp', user_name: 'Koffi',
  raw: RAW, raw_compact: 'C14A71AB', chosen: TRUTH, chosen_compact: 'CIAA71AB',
  rejected: ['CI 4471 AB'], source: 'suggestion', pairs: ['1>I', '4>A'],
})
check('table distante : 2 lignes, 2 postes', remote.rows.size === 2,
  [...new Set([...remote.rows.values()].map((r) => r.poste_id))].join(' + '))

const beforePull = await mergedLearning(LOT)
check('avant réception, la paire reste inactive', beforePull.counts.pairsActive === 0)

const pull1 = await pullRemote(LOT, { sb: remote })
check('ligne du poste B reçue', pull1.pulled === 1, `pulled=${pull1.pulled}`)

agg = await mergedLearning(LOT)
check('deux confirmations fusionnées', agg.counts.events === 2, `events=${agg.counts.events}`)
check('la paire 4>A devient active', agg.costs['4>A'] === 0.45, JSON.stringify(agg.costs))
check('plaque mémorisée', agg.counts.platesActive === 1 && agg.counts.platesKnown === 1,
  `actives=${agg.counts.platesActive}/${agg.counts.platesKnown}`)

const pull2 = await pullRemote(LOT, { sb: remote })
check('réception rejouée : aucun doublon', pull2.pulled === 0 && agg.counts.events === 2, `pulled=${pull2.pulled}`)

console.log('\n=== 4. Le classement change réellement ===')
const ranked = rankBy(RAW, agg)
console.log('   avant :', rankBy(RAW, null).map((r) => `${r.plate} ${(r.score * 100).toFixed(1)}%`).join(' | '))
console.log('   après :', ranked.map((r) => `${r.plate} ${(r.score * 100).toFixed(1)}%`).join(' | '))
check('la plaque confirmée passe en tête', ranked[0].plate === TRUTH, ranked[0].plate)
check('son score progresse', ranked[0].score > rankBy(RAW, null)[0].score,
  `${rankBy(RAW, null)[0].score} → ${ranked[0].score}`)
check('le concurrent recule ou stagne', ranked[1].score <= 0.875, `${ranked[1].score}`)

console.log('\n=== 5. Un troisième poste hérite de l’apprentissage ===')
await db.ocrFeedback.clear()
const boot = await pullRemote(LOT, { sb: remote, since: null })
check('un poste vierge récupère les 2 lignes', boot.pulled === 2, `pulled=${boot.pulled}`)
const fresh = await mergedLearning(LOT)
check('il calcule les mêmes coûts', fresh.costs['4>A'] === 0.45, JSON.stringify(fresh.costs))
check('sans renvoyer les lignes reçues', (await pendingFeedback(LOT)).length === 0)

console.log('\n=== 6. Réinitialisation locale ===')
const removed = await resetLearning(LOT)
check('suppression locale', removed === 2, `supprimées=${removed}`)
const afterReset = await pullRemote(LOT, { sb: remote, since: null })
check('les lignes réinitialisées ne reviennent pas', afterReset.pulled === 0, `pulled=${afterReset.pulled}`)

console.log('\n=== 7. Panne réseau ===')
const broken = { auth: remote.auth, from: () => { throw new Error('réseau indisponible') } }
const boom = await syncFeedback(LOT, { sb: broken })
check('l’erreur est capturée, pas propagée', boom.mode === 'error' && /réseau/.test(boom.error || ''), boom.error)
check('identité du poste conservée', getPosteId() === 'poste_AAAA1111', getPosteId())
check('mapping aller-retour stable', fromRemote(toRemote(evA, 'poste_X')).id === evA.id)

console.log('\n=== 8. Authentification et isolation ===')
const noAuth = { auth: { getSession: async () => ({ data: { session: null } }) }, from: () => { throw new Error('NE DOIT PAS ETRE APPELE') } }
const denied = await syncFeedback(LOT, { sb: noAuth })
check('clé publique sans session : aucun accès aux plaques', denied.mode === 'error' && /Session Supabase/.test(denied.error))
const other = '22222222-2222-4222-8222-222222222222'
remote.seed({ ...remoteRow, id: newUuid(), lot_id: other })
const outside = await pullRemote(LOT, { sb: remote, since: null })
check('aucune importation depuis un autre parking', outside.pulled === 0)

console.log('\n=== 9. Reprise après accusé de réception perdu ===')
const retryEvent = await recordFeedback({ lotId: other, raw: RAW, chosen: TRUTH })
const lostAck = { auth: remote.auth, from: () => {
  const b = remote.from(); const send = b.upsert
  b.upsert = async (rows) => { await send(rows); return { error: { message: 'réponse perdue après insertion' } } }
  return b
} }
const interrupted = await syncFeedback(other, { sb: lostAck })
check('échec réseau signalé, confirmation conservée en attente', interrupted.mode === 'error' && (await pendingFeedback(other)).length === 1)
const retry = await syncFeedback(other, { sb: remote })
check('reprise réussie et outbox acquittée', retry.mode === 'cloud' && (await pendingFeedback(other)).length === 0)
check('un seul exemplaire distant après reprise', [...remote.rows.values()].filter((r) => r.id === retryEvent.id).length === 1)

console.log('\n=== 10. Pagination et timestamps identiques ===')
const bulkLot = '33333333-3333-4333-8333-333333333333'
const sameTime = new Date().toISOString()
for (let i = 0; i < 1201; i++) remote.seed({ ...remoteRow, id: newUuid(), lot_id: bulkLot, created_at: sameTime })
const bulk = await pullRemote(bulkLot, { sb: remote, since: null })
check('1201 événements reçus sur trois pages (sans saut à timestamp identique)', bulk.pulled === 1201, `reçus=${bulk.pulled}`)
const again = await pullRemote(bulkLot, { sb: remote })
check('relecture incrémentale idempotente', again.pulled === 0 && await db.ocrFeedback.where('lotId').equals(bulkLot).count() === 1201)
remote.seed({ ...remoteRow, id: newUuid(), lot_id: bulkLot, created_at: new Date(Date.parse(sameTime) + 120000).toISOString() })
const delta = await pullRemote(bulkLot, { sb: remote })
check('nouvel événement reçu après le curseur', delta.pulled === 1)

console.log(`\nRÉSULTAT : ${ok} OK / ${ko} KO`)
await db.close()
process.exit(ko ? 1 : 0)
