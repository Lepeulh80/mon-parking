import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import assert from 'node:assert/strict'
import { db } from './src/lib/db.js'
import { pushOutbox, pullRemote, uuidOf, pendingFeedback } from './src/lib/ocrSync.js'
// Create a real Dexie v3 database before the current v7 instance is opened.
const old = new Dexie('monparking')
old.version(3).stores({
  lots: 'id, name, code, createdAt', users: 'id, username, lotId, role, [lotId+role], active',
  vehicles: 'id, lotId, plate, status, brand, category, [lotId+status], createdAt',
  clients: 'id, lotId, name, phone, createdAt',
  sales: 'id, lotId, ref, type, status, vehicleId, clientId, userId, date, invoiceNumber, [lotId+type], [lotId+status]',
  payments: 'id, lotId, saleId, date, method', expenses: 'id, lotId, date, category',
  stockMoves: 'id, lotId, vehicleId, type, at', audit: 'id, lotId, userId, action, at',
  spots: 'id, lotId, code, zone, status', tickets: 'id, lotId, plate, status',
  reservations: 'id, lotId, plate, status', meta: 'key',
  ocrFeedback: 'id, lotId, at, source, [lotId+at]',
})
const lotId = '11111111-1111-4111-8111-111111111111'
const event = { id: 'ocrfb_legacy', lotId, raw: 'CI 4A71 AB', rawCompact: 'CI4A71AB',
  chosen: 'CI AA71 AB', chosenCompact: 'CIAA71AB', at: new Date().toISOString(), pairs: ['4>A'] }
await old.ocrFeedback.add(event)
await old.tickets.add({ id: 'ticket-preserved', lotId })
old.close()
await db.open()
assert.equal(db.verno, 9)  // v19 : v8 vehiclePhotos, v9 coffre (vaults)
for (const name of ['staffShifts','attendance','cashSessions','cashMovements','incidents','ratePlans','parkingPasses']) assert(db.tables.some((t) => t.name === name))
assert.equal((await db.ocrFeedback.get(event.id)).synced, 0)
assert.equal((await db.tickets.get('ticket-preserved')).lotId, lotId)
assert.equal((await pendingFeedback(lotId)).length, 1)
console.log('OK migration v3 → v8 : confirmation ancienne en attente, ticket conservé, nouvelles tables présentes')
let remote
const sb = {
  auth: { getSession: async () => ({ data: { session: { user: { id: 'test' } } } }) },
  from: () => ({
    upsert: async (rows) => { remote = { ...rows[0], created_at: new Date().toISOString() }; return { error: null } },
    select() { return this }, eq() { return this }, gte() { return this }, order() { return this },
    range: async () => ({ data: [remote], error: null }),
  }),
}
await pushOutbox(lotId, { sb })
assert.equal(remote.id, uuidOf(event))
assert.equal((await pendingFeedback(lotId)).length, 0)
const pull = await pullRemote(lotId, { sb, since: null })
assert.equal(pull.pulled, 0)
assert.equal(await db.ocrFeedback.count(), 1)
console.log('OK réimport de l’UUID distant : aucun double comptage de l’ancien identifiant local')
db.close()
