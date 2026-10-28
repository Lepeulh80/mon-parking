import Dexie from 'dexie'
import { hasPermission } from './permissions.js'
import { money, bookReceipt } from './cashLedger.js'
import { authRequest } from './authSession.js'
import { pushSale } from './apiData.js'

export const db = new Dexie('monparking')

db.version(1).stores({
  lots: 'id, name, code, createdAt',
  users: 'id, username, lotId, role, [lotId+role], active',
  vehicles: 'id, lotId, plate, status, brand, category, [lotId+status], createdAt',
  clients: 'id, lotId, name, phone, createdAt',
  sales: 'id, lotId, ref, type, status, vehicleId, clientId, userId, date, invoiceNumber, [lotId+type], [lotId+status]',
  payments: 'id, lotId, saleId, date, method',
  expenses: 'id, lotId, date, category',
  stockMoves: 'id, lotId, vehicleId, date, type',
  audit: 'id, lotId, at, userId, action',
  meta: 'key',
})

db.version(2).stores({
  lots: 'id, name, code, createdAt',
  users: 'id, username, lotId, role, [lotId+role], active',
  vehicles: 'id, lotId, plate, status, brand, category, [lotId+status], createdAt',
  clients: 'id, lotId, name, phone, createdAt',
  sales: 'id, lotId, ref, type, status, vehicleId, clientId, userId, date, invoiceNumber, [lotId+type], [lotId+status]',
  payments: 'id, lotId, saleId, date, method',
  expenses: 'id, lotId, date, category',
  stockMoves: 'id, lotId, vehicleId, date, type',
  audit: 'id, lotId, at, userId, action',
  spots: 'id, lotId, code, zone, status, [lotId+status], [lotId+zone]',
  tickets: 'id, lotId, ref, plate, spotId, status, entryAt, [lotId+status]',
  reservations: 'id, lotId, spotId, plate, status, startAt, [lotId+status]',
  meta: 'key',
})

db.version(3).stores({
  // Apprentissage local des confusions OCR (une ligne par confirmation d'opérateur).
  ocrFeedback: 'id, lotId, at, source, [lotId+at]',
})

db.version(4).stores({
  // Réplication : `uuid` est la clé distante (Supabase), `synced` sert de file
  // d'attente locale (0 = à pousser). Migration additive, aucune donnée perdue.
  ocrFeedback: 'id, lotId, at, source, uuid, synced, [lotId+at], [lotId+synced]',
}).upgrade((tx) => tx.table('ocrFeedback').toCollection().modify((row) => {
  row.synced = row.synced ?? 0
}))

// V8: additive operational schema; existing sales/OCR records are untouched.
db.version(5).stores({
  staffShifts: 'id, lotId, userId, startAt, status, [lotId+userId]',
  attendance: 'id, lotId, userId, inAt, [lotId+userId]',
  cashSessions: 'id, lotId, userId, status, openedAt, [lotId+userId]',
  cashMovements: 'id, lotId, sessionId, source, at',
  incidents: 'id, lotId, status, severity, createdAt',
  ratePlans: 'id, lotId, active',
  parkingPasses: 'id, lotId, plateKey, status, [lotId+plateKey]',
})

db.version(6).stores({
  parkingSyncEvents: 'id, lotId, status, sequence, createdAt',
  plateCorrections: 'id, lotId, ticketId, at',
})

db.version(7).stores({
 notifications:'id, lotId, userId, kind, at, [lotId+userId]',
 bankAccounts:'id, lotId, provider', bankTransactions:'id, lotId, accountId, date, source',
 budgets:'id, lotId, userId, month', ocrObservations:'id, lotId, userId, zone, at',
})

// v17 : galerie photos + séquence 360° des véhicules. Migration purement
// additive : aucune table existante n'est touchée, les véhicules déjà saisis
// (dont `photo` en data URL) restent lisibles tels quels.
db.version(8).stores({
  vehiclePhotos: 'id, lotId, vehicleId, kind, sort, [vehicleId+kind], [lotId+kind], createdAt',
}).upgrade((tx) => tx.table('vehicles').toCollection().modify((row) => {
  // Compteurs dérivés pour les cartes de stock, sans requête par véhicule.
  row.photoCount = row.photoCount ?? (row.photo ? 1 : 0)
  row.frameCount = row.frameCount ?? 0
}))

// v19 : coffre de chiffrement des médias. Une ligne par parking, contenant
// UNIQUEMENT la clé emballée (sel + IV + clé chiffrée par la phrase de coffre).
// La clé de données en clair n'est jamais écrite sur disque.
db.version(9).stores({
  vaults: 'id, lotId, createdAt',
}).upgrade((tx) => tx.table('vehiclePhotos').toCollection().modify((row) => {
  // Les médias antérieurs restent lisibles : `enc` absent = image en clair.
  if (row.enc === undefined) row.enc = false
}))

export async function authorize(actor, lotId, permission) {
  if(typeof window!=='undefined'){
    const request=authRequest('/api/auth/authorize',{method:'POST',body:{lotId,permission}})
    const user=await (Dexie.currentTransaction?Dexie.waitFor(request):request)
    if(user.id!==actor?.id)throw new Error('Identité de session incohérente.')
    return user
  }
  const user = actor?.id ? await db.users.get(actor.id) : null
  if (!user || user.lotId !== lotId || !hasPermission(user, permission)) throw new Error('Action non autorisée pour ce compte ou ce parking.')
  return user
}

export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export const nowIso = () => new Date().toISOString()
export const today = () => new Date().toISOString().slice(0, 10)

/* ---------------- auth ---------------- */
const enc = new TextEncoder()


const PIN_ITERATIONS=310000
const PIN_PREFIX='pbkdf2-sha256$310000$'
export async function hashPin(pin, salt) {
  if(!globalThis.crypto?.subtle)throw new Error('HTTPS ou localhost requis pour protéger les codes PIN.')
  const s=salt||[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('')
  const key=await crypto.subtle.importKey('raw',enc.encode(String(pin)),'PBKDF2',false,['deriveBits'])
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:enc.encode(s),iterations:PIN_ITERATIONS},key,256)
  return {hash:PIN_PREFIX+[...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,'0')).join(''),salt:s}
}


/* ---------------- numbering ---------------- */
async function nextNumber(lotId, field) {
  const lot = await db.lots.get(lotId)
  const n = lot[field] || 1
  await db.lots.update(lotId, { [field]: n + 1 })
  return n
}

export function docNumber(lot, kind, n) {
  const year = new Date().getFullYear()
  const prefix = kind === 'invoice' ? lot.invoicePrefix || 'FAC' : lot.receiptPrefix || 'REC'
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`
}

/* ---------------- mutations ---------------- */
async function createSaleLocal(payload) {
  const actor = await authorize({ id: payload.userId }, payload.lotId, 'sales.write')
  if(!['vente','location'].includes(payload.type)) throw new Error('Type de document invalide.')
  payload={...payload,total:money(payload.total),paid:money(payload.paid),price:payload.price===undefined?money(payload.total):money(payload.price),discount:money(payload.discount??0),subtotal:payload.subtotal===undefined?money(payload.total):money(payload.subtotal),vatAmount:money(payload.vatAmount??0),deposit:money(payload.deposit??0)}
  if (Number(payload.paid) > Number(payload.total)) throw new Error('Encaissement supérieur au total.')
  return db.transaction('rw', db.cashSessions, db.cashMovements, db.sales, db.vehicles, db.payments, db.clients, db.stockMoves, db.audit, db.lots, async () => {
    const lot = await db.lots.get(payload.lotId)
    const vehicle = await db.vehicles.get(payload.vehicleId)
    if (!vehicle || vehicle.lotId !== payload.lotId || vehicle.status !== 'stock') throw new Error('Véhicule indisponible ou extérieur au parking.')
    const invoiceN = await nextNumber(payload.lotId, 'invoiceNext')
    const receiptN = await nextNumber(payload.lotId, 'receiptNext')
    const invoiceNumber = docNumber(lot, 'invoice', invoiceN)
    const receiptNumber = docNumber(lot, 'receipt', receiptN)
    const id = uid('sale')
    const sale = {
      id,
      lotId: payload.lotId,
      ref: invoiceNumber,
      type: payload.type, // vente | location
      status: payload.paid >= payload.total ? 'payee' : payload.paid > 0 ? 'partielle' : 'impayee',
      vehicleId: payload.vehicleId,
      vehicleSnapshot: payload.vehicleSnapshot,
      clientId: payload.clientId || null,
      clientSnapshot: payload.clientSnapshot,
      userId: payload.userId,
      userName: payload.userName,
      date: payload.date || nowIso(),
      price: payload.price,
      discount: payload.discount || 0,
      vatRate: payload.vatRate || 0,
      subtotal: payload.subtotal,
      vatAmount: payload.vatAmount || 0,
      total: payload.total,
      paid: payload.paid || 0,
      paymentMethod: payload.paymentMethod || 'espèces',
      dueDate: payload.dueDate || null,
      invoiceNumber,
      receiptNumber,
      notes: payload.notes || '',
      rentalStart: payload.rentalStart || null,
      rentalEnd: payload.rentalEnd || null,
      rentalDays: payload.rentalDays || 0,
      deposit: payload.deposit || 0,
      returnedAt: null,
      extraFees: 0,
      createdAt: nowIso(),
    }
    await db.sales.add(sale)
    const initialPaymentId = uid('pay')
    const cashSessionId = await bookReceipt(db, { lotId: payload.lotId, user: actor, source: `payment:${initialPaymentId}`, amount: Number(payload.paid), method: payload.paymentMethod || 'espèces', at: payload.date || nowIso() })
    if (payload.paid > 0) {
      await db.payments.add({
        id: initialPaymentId, cashSessionId, lotId: payload.lotId, saleId: id, amount: Number(payload.paid),
        date: payload.date || nowIso(), method: payload.paymentMethod || 'espèces',
        userId: payload.userId, userName: payload.userName, ref: receiptNumber,
      })
    }
    const veh = await db.vehicles.get(payload.vehicleId)
    if (veh) {
      await db.vehicles.update(payload.vehicleId, {
        status: payload.type === 'vente' ? 'vendu' : 'loue',
        soldAt: payload.type === 'vente' ? nowIso() : null,
        soldPrice: payload.type === 'vente' ? payload.total : null,
      })
      await db.stockMoves.add({
        id: uid('mv'), lotId: payload.lotId, vehicleId: payload.vehicleId,
        plate: veh.plate, type: payload.type === 'vente' ? 'vente' : 'location',
        date: payload.date || nowIso(), userId: payload.userId, userName: payload.userName,
        note: `${payload.type === 'vente' ? 'Vente' : 'Location'} ${invoiceNumber}`,
      })
    }
    await db.audit.add({
      id: uid('log'), lotId: payload.lotId, userId: payload.userId, userName: payload.userName,
      action: payload.type === 'vente' ? 'vente' : 'location', at: nowIso(),
      details: `${invoiceNumber} · ${payload.vehicleSnapshot?.plate || ''} · ${payload.total}`,
    })
    return { ...sale, invoiceNumber, receiptNumber }
  })
}

export async function addPayment(saleId, amount, method, user) {
  return db.transaction('rw', db.sales, db.payments, db.audit, db.users, db.lots, db.cashSessions, db.cashMovements, async () => {
    const sale = await db.sales.get(saleId)
    if (!sale) throw new Error('Document introuvable')
    const actor = await authorize(user, sale.lotId, 'sales.collect')
    const value = money(amount, { zero: false })
    if (value > sale.total - (sale.paid || 0)) throw new Error('Le règlement dépasse le solde restant.')
    const paid = money(Number(sale.paid || 0) + value)
    const paymentId = uid('pay')
    const cashSessionId = await bookReceipt(db, { lotId: sale.lotId, user: actor, source: `payment:${paymentId}`, amount: value, method, at: nowIso() })
    const status = paid >= sale.total ? 'payee' : paid > 0 ? 'partielle' : 'impayee'
    await db.sales.update(saleId, { paid, status })
    await db.payments.add({
      id: paymentId, cashSessionId, lotId: sale.lotId, saleId, amount: value, date: nowIso(),
      method, userId: user.id, userName: user.name, ref: `REG-${sale.invoiceNumber}`,
    })
    await db.audit.add({
      id: uid('log'), lotId: sale.lotId, userId: user.id, userName: user.name,
      action: 'paiement', at: nowIso(), details: `${sale.invoiceNumber} · +${amount}`,
    })
    return { paid, status }
  })
}

export async function returnRental(saleId, extraFees, user) {
  return db.transaction('rw', db.sales, db.vehicles, db.stockMoves, db.audit, db.users, async () => {
    const sale = await db.sales.get(saleId)
    if (!sale || sale.type!=='location') throw new Error('Location introuvable ou document non locatif.')
    await authorize(user,sale.lotId,'sales.write')
    const fees = money(extraFees || 0)
    if (sale.returnedAt) throw new Error('Location déjà retournée.')
    await db.sales.update(saleId, {
      returnedAt: nowIso(),
      extraFees: fees,
      total: money(Number(sale.total) + fees),
      status: Number(sale.paid || 0) >= money(Number(sale.total) + fees) ? 'payee' : (sale.paid || 0) > 0 ? 'partielle' : 'impayee',
    })
    const veh = await db.vehicles.get(sale.vehicleId)
    if (veh) {
      await db.vehicles.update(sale.vehicleId, {
        status: 'stock',
        mileage: veh.mileage || 0, // Never invent kilometres.
      })
      await db.stockMoves.add({
        id: uid('mv'), lotId: sale.lotId, vehicleId: sale.vehicleId, plate: veh.plate,
        type: 'retour', date: nowIso(), userId: user.id, userName: user.name,
        note: `Retour location ${sale.invoiceNumber}`,
      })
    }
    await db.audit.add({
      id: uid('log'), lotId: sale.lotId, userId: user.id, userName: user.name,
      action: 'retour-location', at: nowIso(), details: `${sale.invoiceNumber} · frais ${fees}`,
    })
  })
}

export async function deleteSale(saleId, user) {
  return db.transaction('rw', db.sales, db.vehicles, db.payments, db.audit, db.users, async () => {
    const sale = await db.sales.get(saleId)
    if (!sale) return
    const actor=await authorize(user,sale.lotId,'sales.delete')
    const payments=await db.payments.where('saleId').equals(saleId).count()
    if(Number(sale.paid)>0 || payments) throw new Error('Document encaissé : suppression interdite. Un avoir et un remboursement contrôlé sont nécessaires.')
    await db.sales.delete(saleId)
    const other=await db.sales.where('vehicleId').equals(sale.vehicleId).filter(s=>s.id!==saleId && (s.type==='vente'||(s.type==='location'&&!s.returnedAt))).count()
    if(!other) await db.vehicles.update(sale.vehicleId,{status:'stock',soldAt:null,soldPrice:null})
    await db.audit.add({id:uid('log'),lotId:sale.lotId,userId:actor.id,userName:actor.name,action:'annulation',at:nowIso(),details:`Annulation document sans règlement ${sale.invoiceNumber}`})
  })
}


export async function logAction(user, action, details, lotId) {
  await db.audit.add({ id: uid('log'), lotId: lotId || user.lotId, userId: user.id, userName: user.name, action, at: nowIso(), details })
}

/* ---------------- selectors ---------------- */
export async function saleStats(lotId) {
  const sales = await db.sales.where('lotId').equals(lotId).toArray()
  return sales
}

export function sum(arr, key) {
  return arr.reduce((a, b) => a + (Number(b[key]) || 0), 0)
}

export function monthBuckets(n = 6) {
  const out = []
  const d = new Date()
  d.setDate(1)
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1)
    out.push({ key: x.toISOString().slice(0, 7), label: x.toLocaleDateString('fr-FR', { month: 'short' }) })
  }
  return out
}

/* ---------------- seed ---------------- */
const DEMO_LOGO = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#0d1420"/><circle cx="100" cy="100" r="78" fill="none" stroke="#c6f24e" stroke-width="6"/><path d="M52 118h96M64 118l10-30h52l10 30" stroke="#c6f24e" stroke-width="7" fill="none" stroke-linecap="round"/><circle cx="76" cy="126" r="9" fill="#c6f24e"/><circle cx="124" cy="126" r="9" fill="#c6f24e"/><text x="100" y="62" font-family="Arial" font-size="22" font-weight="bold" fill="#c6f24e" text-anchor="middle">MP</text></svg>`)}`

const VEHICLES = [
  ['Toyota', 'Corolla', 2022, 'AB 1234 CI', 9200000, 12500000, 45000, 'Berline', 'Essence', 'Automatique', 42000, '#dfe4ea'],
  ['Toyota', 'RAV4', 2021, 'CD 5678 CI', 14500000, 18900000, 65000, 'SUV', 'Hybride', 'Automatique', 58000, '#26313f'],
  ['Hyundai', 'Tucson', 2023, 'EF 9012 CI', 13800000, 17500000, 55000, 'SUV', 'Diesel', 'Automatique', 21000, '#3b4a5c'],
  ['Kia', 'Sportage', 2022, 'GH 3456 CI', 12900000, 16800000, 52000, 'SUV', 'Diesel', 'Automatique', 34000, '#7c8794'],
  ['Mercedes-Benz', 'C 300', 2020, 'IJ 7890 CI', 16800000, 22500000, 85000, 'Berline', 'Essence', 'Automatique', 71000, '#111318'],
  ['BMW', 'X5', 2021, 'KL 2345 CI', 24500000, 32000000, 120000, 'SUV', 'Diesel', 'Automatique', 89000, '#1c2532'],
  ['Peugeot', '3008', 2022, 'MN 6789 CI', 11200000, 14900000, 48000, 'SUV', 'Diesel', 'Automatique', 47000, '#a9b2bd'],
  ['Renault', 'Duster', 2021, 'OP 1122 CI', 6800000, 9500000, 32000, 'SUV', 'Essence', 'Manuelle', 96000, '#c9ccd1'],
  ['Nissan', 'Qashqai', 2020, 'QR 3344 CI', 8900000, 12200000, 40000, 'SUV', 'Essence', 'Automatique', 83000, '#2e3b4b'],
  ['Ford', 'Ranger', 2022, 'ST 5566 CI', 15200000, 19800000, 70000, 'Pick-up', 'Diesel', 'Manuelle', 52000, '#4a535f'],
  ['Suzuki', 'Swift', 2023, 'UV 7788 CI', 5900000, 7900000, 28000, 'Citadine', 'Essence', 'Manuelle', 18000, '#e8eaee'],
  ['Volkswagen', 'Golf 8', 2022, 'WX 9900 CI', 11900000, 15500000, 46000, 'Compacte', 'Essence', 'Automatique', 39000, '#1b3a5c'],
  ['Toyota', 'Hilux', 2021, 'YZ 2211 CI', 13400000, 17900000, 58000, 'Pick-up', 'Diesel', 'Manuelle', 74000, '#5b6470'],
  ['Honda', 'Civic', 2023, 'BC 4433 CI', 10800000, 14200000, 42000, 'Berline', 'Essence', 'Automatique', 15000, '#8f1f2e'],
  ['Mitsubishi', 'Pajero', 2019, 'DE 6655 CI', 12800000, 16900000, 62000, 'SUV', 'Diesel', 'Automatique', 118000, '#d8d4c8'],
  ['Audi', 'A4', 2021, 'FG 8877 CI', 15900000, 21000000, 78000, 'Berline', 'Essence', 'Automatique', 63000, '#20262e'],
]

export async function seedDemo() {
  const already = await db.meta.get('seeded')
  if (already) return
  // Stable demo data IDs are not credentials; the server never auto-provisions them.
  const lotId = 'demo-lot-apa'
  const lot = {
    id: lotId, name: 'Auto Prestige Abidjan', code: 'APA', logo: DEMO_LOGO,
    address: 'Boulevard VGE, Zone 4, Abidjan', city: 'Abidjan', phone: '+225 27 22 44 88 90',
    email: 'contact@autoprestige.ci', taxId: 'CI-2019-B-44821',
    currency: 'XOF', vatRate: 18, invoicePrefix: 'FAC', receiptPrefix: 'REC',
    invoiceNext: 1, receiptNext: 1, tagline: 'Vente & location de véhicules d’occasion premium',
    hourlyRate: 500, dailyCap: 6000, graceMinutes: 15, ticketNext: 1,
    footerNote: 'Merci de votre confiance. Tout véhicule vendu bénéficie d’une garantie de 3 mois.',
    createdAt: nowIso(), active: true,
  }
  await db.lots.add(lot)

  const staff = []
  for (const [username, name, role, pin] of [
    ['admin', 'Kouadio Yao', 'admin', '1234'],
    ['vendeur', 'Aminata Diallo', 'employe', '1111'],
    ['vendeur2', 'Serge Konan', 'employe', '2222'],
  ]) {
    const { hash, salt } = await hashPin(pin)
    const u = {
      id: `demo-user-${username}`, lotId, username, name, role, pinHash: hash, salt, active: true,
      phone: '', createdAt: nowIso(),
    }
    await db.users.add(u)
    staff.push(u)
  }

  const vehicles = []
  for (const [brand, model, year, plate, purchase, price, rent, category, fuel, gearbox, km, color] of VEHICLES) {
    const v = {
      id: uid('veh'), lotId, plate, brand, model, year, vin: `VF${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
      mileage: km, fuel, gearbox, color, category, condition: km > 80000 ? 'occasion' : 'très bon état',
      purchasePrice: purchase, price, rentPriceDaily: rent, status: 'stock', photo: null,
      supplier: 'Import Auto Dubai', acquisitionDate: new Date(Date.now() - Math.random() * 9e10).toISOString().slice(0, 10),
      description: `${brand} ${model} ${year} · ${fuel} · ${gearbox} · ${category}`,
      createdAt: nowIso(),
    }
    vehicles.push(v)
    await db.vehicles.add(v)
  }

  const clientNames = [
    ['Société Ivoire BTP', 'entreprise', '+225 07 08 11 22 33'],
    ['Fatou Bamba', 'particulier', '+225 05 44 55 66 77'],
    ['Koffi Aboua', 'particulier', '+225 01 23 45 67 89'],
    ['Groupe Sifca', 'entreprise', '+225 27 20 30 40 50'],
    ['Mariam Touré', 'particulier', '+225 07 99 88 77 66'],
    ['Yao Serge', 'particulier', '+225 05 12 34 56 78'],
  ]
  const clients = []
  for (const [name, type, phone] of clientNames) {
    const c = {
      id: uid('cli'), lotId, name, type, phone, email: `${name.split(' ')[0].toLowerCase()}@mail.ci`,
      address: 'Abidjan, Côte d’Ivoire', taxId: type === 'entreprise' ? 'CI-2018-B-1122' : '',
      createdAt: nowIso(),
    }
    clients.push(c)
    await db.clients.add(c)
  }

  // historic sales spread over 6 months
  const methods = ['espèces', 'mobile money', 'virement', 'chèque']
  const soldIdx = [0, 2, 4, 6, 8, 10, 12]
  let saleCount = 0
  for (let i = 0; i < soldIdx.length; i++) {
    const veh = vehicles[soldIdx[i]]
    const client = clients[i % clients.length]
    const seller = staff[1 + (i % 2)]
    const d = new Date()
    d.setMonth(d.getMonth() - (5 - (i % 6)))
    d.setDate(3 + ((i * 5) % 22))
    const gross = veh.price
    const discount = i % 3 === 0 ? Math.round(gross * 0.02) : 0
    const subtotal = gross - discount
    const vatAmount = Math.round(subtotal * 0.18)
    const total = subtotal + vatAmount
    const paid = i % 5 === 4 ? Math.round(total * 0.6) : total
    const invoiceNumber = docNumber(lot, 'invoice', ++saleCount)
    const receiptNumber = docNumber(lot, 'receipt', saleCount)
    const sid = uid('sale')
    await db.sales.add({
      id: sid, lotId, ref: invoiceNumber, type: 'vente',
      status: paid >= total ? 'payee' : 'partielle', vehicleId: veh.id,
      vehicleSnapshot: { brand: veh.brand, model: veh.model, year: veh.year, plate: veh.plate, vin: veh.vin, mileage: veh.mileage, category: veh.category },
      clientId: client.id, clientSnapshot: { name: client.name, phone: client.phone, email: client.email, address: client.address, taxId: client.taxId },
      userId: seller.id, userName: seller.name, date: d.toISOString(),
      price: gross, discount, vatRate: 18, subtotal, vatAmount, total, paid,
      paymentMethod: methods[i % methods.length], dueDate: null,
      invoiceNumber, receiptNumber, notes: '', rentalStart: null, rentalEnd: null,
      rentalDays: 0, deposit: 0, returnedAt: null, extraFees: 0, createdAt: d.toISOString(),
    })
    await db.payments.add({
      id: uid('pay'), lotId, saleId: sid, amount: paid, date: d.toISOString(),
      method: methods[i % methods.length], userId: seller.id, userName: seller.name, ref: receiptNumber,
    })
    await db.vehicles.update(veh.id, { status: 'vendu', soldAt: d.toISOString(), soldPrice: total })
    await db.stockMoves.add({
      id: uid('mv'), lotId, vehicleId: veh.id, plate: veh.plate, type: 'vente',
      date: d.toISOString(), userId: seller.id, userName: seller.name, note: `Vente ${invoiceNumber}`,
    })
  }

  // one active rental
  const rentalVeh = vehicles[1]
  const start = new Date(Date.now() - 3 * 86400000)
  const end = new Date(Date.now() + 4 * 86400000)
  const days = 7
  const rentTotal = rentalVeh.rentPriceDaily * days
  const rentInvoice = docNumber(lot, 'invoice', ++saleCount)
  const rentReceipt = docNumber(lot, 'receipt', saleCount)
  const rentalId = uid('sale')
  await db.sales.add({
    id: rentalId, lotId, ref: rentInvoice, type: 'location', status: 'payee',
    vehicleId: rentalVeh.id,
    vehicleSnapshot: { brand: rentalVeh.brand, model: rentalVeh.model, year: rentalVeh.year, plate: rentalVeh.plate, vin: rentalVeh.vin, mileage: rentalVeh.mileage, category: rentalVeh.category },
    clientId: clients[1].id, clientSnapshot: { name: clients[1].name, phone: clients[1].phone, email: clients[1].email, address: clients[1].address, taxId: '' },
    userId: staff[1].id, userName: staff[1].name, date: start.toISOString(),
    price: rentTotal, discount: 0, vatRate: 18, subtotal: rentTotal,
    vatAmount: Math.round(rentTotal * 0.18), total: rentTotal + Math.round(rentTotal * 0.18),
    paid: rentTotal + Math.round(rentTotal * 0.18), paymentMethod: 'mobile money',
    dueDate: end.toISOString(), invoiceNumber: rentInvoice, receiptNumber: rentReceipt, notes: 'Location 7 jours',
    rentalStart: start.toISOString(), rentalEnd: end.toISOString(), rentalDays: days, deposit: 500000,
    returnedAt: null, extraFees: 0, createdAt: start.toISOString(),
  })
  await db.payments.add({
    id: uid('pay'), lotId, saleId: rentalId, amount: rentTotal + Math.round(rentTotal * 0.18),
    date: start.toISOString(), method: 'mobile money', userId: staff[1].id, userName: staff[1].name, ref: rentReceipt,
  })
  await db.vehicles.update(rentalVeh.id, { status: 'loue' })
  await db.stockMoves.add({
    id: uid('mv'), lotId, vehicleId: rentalVeh.id, plate: rentalVeh.plate, type: 'location',
    date: start.toISOString(), userId: staff[1].id, userName: staff[1].name, note: `Location ${rentInvoice}`,
  })

  await db.lots.update(lotId, { invoiceNext: saleCount + 1, receiptNext: saleCount + 1 })

  const expenses = [
    ['Loyer du showroom', 'loyer', 1200000], ['Salaires équipe', 'salaires', 2400000],
    ['Carburant & lavage', 'logistique', 320000], ['Publicité Facebook/Instagram', 'marketing', 250000],
    ['Entretien véhicules', 'maintenance', 480000], ['Électricité & eau', 'charges', 190000],
    ['Taxes et impôts', 'taxes', 650000], ['Commissions vendeurs', 'commissions', 540000],
  ]
  for (let i = 0; i < expenses.length; i++) {
    const d = new Date()
    d.setMonth(d.getMonth() - (i % 4))
    d.setDate(5 + i * 2)
    await db.expenses.add({
      id: uid('exp'), lotId, label: expenses[i][0], category: expenses[i][1],
      amount: expenses[i][2], date: d.toISOString(), userId: staff[0].id,
      notes: '', createdAt: d.toISOString(),
    })
  }

  await db.audit.add({
    id: uid('log'), lotId, userId: staff[0].id, userName: staff[0].name,
    action: 'initialisation', at: nowIso(), details: 'Parking de démonstration créé',
  })

  await db.meta.put({ key: 'seeded', value: true })
}

// Enveloppe : la vente est d'abord écrite localement (l'interface reste
// utilisable hors ligne), puis répliquée sur le serveur PostgreSQL. Un échec
// réseau n'annule pas la vente locale mais il est signalé.
export async function createSale(payload) {
  const sale = await createSaleLocal(payload)
  try {
    await pushSale({ type: sale.type, vehicleId: sale.vehicleId, clientId: sale.clientId, total: sale.total, paid: sale.paid, method: sale.method || 'espece', clientName: sale.clientName })
  } catch (error) { console.warn('Vente non répliquée sur le serveur :', error.message) }
  return sale
}
