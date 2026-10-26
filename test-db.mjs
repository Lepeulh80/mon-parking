import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db, seedDemo, createSale, nowIso, addPayment, returnRental } from './src/lib/db.js'

const run = async () => {
  await seedDemo()
  const lot = (await db.lots.toArray())[0]
  const user = await db.users.where('username').equals('admin').first()
  const v = await db.vehicles.where('lotId').equals(lot.id).filter(x => x.status === 'stock').first()
  console.log('stock avant:', (await db.vehicles.where('lotId').equals(lot.id).toArray()).filter(x=>x.status==='stock').length)
  const sale = await createSale({
    lotId: lot.id, type: 'vente', vehicleId: v.id,
    vehicleSnapshot: { brand: v.brand, model: v.model, year: v.year, plate: v.plate, vin: v.vin, mileage: v.mileage, category: v.category, purchasePrice: v.purchasePrice },
    clientId: null, clientSnapshot: { name: 'Client comptant' },
    userId: user.id, userName: user.name, date: nowIso(),
    price: v.price, discount: 0, vatRate: 18, subtotal: v.price, vatAmount: Math.round(v.price*0.18), total: v.price + Math.round(v.price*0.18), paid: v.price, paymentMethod: 'espèces',
    notes: '', rentalStart: null, rentalEnd: null, rentalDays: 0, deposit: 0,
  })
  console.log('sale:', sale.invoiceNumber, sale.total, sale.status)
  const v2 = await db.vehicles.get(v.id)
  console.log('vehicule statut apres vente:', v2.status)
  console.log('stock apres:', (await db.vehicles.where('lotId').equals(lot.id).toArray()).filter(x=>x.status==='stock').length)
  const pay = await addPayment(sale.id, 1000, 'espèces', { id: user.id, name: user.name })
  console.log('paiement:', pay)
  await assert.rejects(() => createSale({ lotId:lot.id, userId:user.id, vehicleId:v2.id, type:'vente', total:100, paid:100 }), /indisponible/)
  const rentalVehicle = await db.vehicles.where('lotId').equals(lot.id).filter(x => x.status === 'stock').first()
  const loc = await createSale({
    lotId: lot.id, type: 'location', vehicleId: rentalVehicle.id,
    vehicleSnapshot: { brand: v2.brand, model: v2.model, plate: v2.plate }, clientSnapshot: { name: 'X' },
    userId: user.id, userName: user.name, date: nowIso(), price: 100000, discount: 0, vatRate: 18,
    subtotal: 100000, vatAmount: 18000, total: 118000, paid: 118000, paymentMethod: 'espèces',
    rentalDays: 2, rentalStart: nowIso(), rentalEnd: nowIso(), deposit: 5000,
  })
  console.log('location:', loc.invoiceNumber)
  await returnRental(loc.id, 5000, { id: user.id, name: user.name })
  const v3 = await db.vehicles.get(rentalVehicle.id)
  assert.equal(v3.status, 'stock')
  assert.equal((await db.sales.get(loc.id)).status, 'partielle')
  assert.equal(v3.mileage, rentalVehicle.mileage)
  console.log('statut apres retour:', v3.status)
  console.log('lots compteurs:', (await db.lots.get(lot.id)).invoiceNext, (await db.lots.get(lot.id)).receiptNext)
  console.log('DB OK')
}
run().catch(e => { console.error('DB FAIL', e); process.exit(1) })
