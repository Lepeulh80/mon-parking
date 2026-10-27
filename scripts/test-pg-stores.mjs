// Vérifie les deux magasins PostgreSQL sur une base RÉELLE.
//   DATABASE_URL=postgresql://… node scripts/test-pg-stores.mjs
// Sur une base vide, le schéma est créé automatiquement. Code de sortie 1 au
// premier échec : utilisable tel quel dans une CI.
import { PgAuthStore } from '../server/auth-store-pg.mjs'
import { PgBusinessStore } from '../server/business-store-pg.mjs'
import { bootstrapAdmin } from '../server/bootstrap.mjs'
import { totp } from '../server/totp.mjs'

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL manquant.'); process.exit(2) }
let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  OK  ' + label) } else { fail++; console.log('  KO  ' + label) } }

const auth = await PgAuthStore.open({ connectionString: url, autoMigrate: true })
ok(true, 'schéma appliqué (auth + métier)')

const boot = await bootstrapAdmin(auth, {}, { log: () => {} })
let lotId
if (boot.created) { lotId = boot.lotId; ok(true, 'base vide : administrateur amorcé') }
else {
  // Base déjà provisionnée : on se connecte avec les variables d'environnement.
  const username = process.env.ADMIN_USERNAME, pin = process.env.ADMIN_PIN
  if (!username || !pin) { console.error('Base déjà provisionnée : fournissez ADMIN_USERNAME et ADMIN_PIN.'); process.exit(2) }
  const session = await auth.login(username, pin)
  lotId = session.user.lotId
  ok(typeof session.token === 'string', 'base existante : connexion ' + username)
}
const session = await auth.login(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PIN || '1234')
ok(typeof session.token === 'string' && session.token.length === 43, 'login -> jeton de session (43 car.)')
let refused = false
try { await auth.login(session.user.username, '0000') } catch (e) { refused = e.status === 401 }
ok(refused, 'mauvais PIN refusé (401)')

const biz = new PgBusinessStore(auth._sql, async () => {})
const plate = `TEST-${Date.now() % 100000}`
const veh = await biz.createVehicle(lotId, { plate, brand: 'Kia', model: 'Sportage', price: 19824000, cost: 15000000, year: 2022 })
ok(veh.plate === plate && Number(veh.price) === 19824000, 'véhicule créé (prix exact en numeric)')
let dup = false
try { await biz.createVehicle(lotId, { plate: plate.toLowerCase(), brand: 'X', price: 1 }) } catch (e) { dup = e.status === 409 }
ok(dup, 'plaque dupliquée refusée (409, insensible à la casse)')

const sale = await biz.createSale(lotId, { type: 'vente', vehicleId: veh.id, total: 19824000, paid: 19824000 })
ok(/^FAC-\d{4}-\d{4}$/.test(sale.invoiceNumber), 'numéro de facture bien formé : ' + sale.invoiceNumber)
ok(!/FAC-\d{4}-\d{8}/.test(sale.invoiceNumber), 'numéro sans année dupliquée')

const a = await biz.createVehicle(lotId, { plate: plate + 'A', brand: 'A', price: 1000 })
const b = await biz.createVehicle(lotId, { plate: plate + 'B', brand: 'B', price: 1000 })
const [s1, s2] = await Promise.all([
  biz.createSale(lotId, { vehicleId: a.id, total: 1000, paid: 0 }),
  biz.createSale(lotId, { vehicleId: b.id, total: 1000, paid: 0 }),
])
ok(s1.invoiceNumber !== s2.invoiceNumber, `concurrence : ${s1.invoiceNumber} ≠ ${s2.invoiceNumber}`)
const n1 = Number(s1.invoiceNumber.match(/(\d+)$/)[1]), n2 = Number(s2.invoiceNumber.match(/(\d+)$/)[1])
ok(Math.abs(n1 - n2) === 1, `numéros consécutifs : ${n1} puis ${n2}`)

const ticket = await biz.openTicket(lotId, { plate: 'CI 8842 KB', spot: 'A01' })
ok(/^TCK-\d{4}-\d{4}$/.test(ticket.ref), 'ticket bien formé : ' + ticket.ref)
const closed = await biz.closeTicket(lotId, ticket.id, { amount: 1500 })
ok(closed.status === 'clos' && Number(closed.amount) === 1500, 'ticket clôturé avec montant')

const stats = await biz.stats(lotId)
ok(stats.salesCount >= 3, 'statistiques : ' + JSON.stringify(stats))

// Persistance : fermeture du pool puis relecture par une nouvelle instance.
await auth.close()
const again = await PgAuthStore.open({ connectionString: url, autoMigrate: false })
const relog = await again.login(process.env.ADMIN_USERNAME || 'admin', process.env.ADMIN_PIN || '1234')
ok(typeof relog.token === 'string', 'après fermeture/réouverture : connexion toujours possible')
const biz2 = new PgBusinessStore(again._sql, async () => {})
const back = await biz2.getVehicle(lotId, veh.id)
ok(back && back.plate === plate, 'véhicule relu après réouverture (données persistées)')
await again.close()

console.log(`\nPG STORES: ${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
