import { pushTicket, closeTicketRemote } from './apiMirror.js'
import { notifyLocal } from './experience.js'
import { db, uid, nowIso, authorize } from './db.js'
import { compact } from './plate.js'
import { bookReceipt, money } from './cashLedger.js'
import { calculateParkingFee, validateFees, DEFAULT_FEES } from './feeEngine.js'
import { enqueueParking, ticketCloudEnabled } from './parkingSync.js'
import { subscriptionCovers } from './operations.js'

export const SPOT_TYPES = [
  { value: 'standard', label: 'Standard', color: '#c6f24e' },
  { value: 'pmr', label: 'PMR', color: '#4cc9f0' },
  { value: 'moto', label: 'Moto', color: '#a78bfa' },
  { value: 'camion', label: 'Camion', color: '#ffb347' },
  { value: 'electrique', label: 'Électrique', color: '#2ee6a8' },
]

export const SPOT_STATUS = {
  libre: { label: 'Libre', tone: 'ok', color: '#2ee6a8' },
  occupe: { label: 'Occupée', tone: 'danger', color: '#ff5c7a' },
  reserve: { label: 'Réservée', tone: 'warn', color: '#ffb347' },
  hs: { label: 'Hors service', tone: 'default', color: '#5d6981' },
}

export const RESA_STATUS = {
  confirmee: { label: 'Confirmée', tone: 'info' },
  'en-cours': { label: 'En cours', tone: 'warn' },
  terminee: { label: 'Terminée', tone: 'ok' },
  annulee: { label: 'Annulée', tone: 'danger' },
}

/* ---------------- tarification ---------------- */
export function computeParkingCharge({ entryAt, exitAt, hourlyRate, dailyCap, graceMinutes }) {
  return calculateParkingFee({ entryAt, exitAt, hourlyRate: hourlyRate ?? 0, dailyCap: dailyCap ?? 0, graceMinutes: graceMinutes ?? 15, ...arguments[0] })
}

/* ---------------- places ---------------- */
export async function ensureParkingSetup(lot) {
  const count = await db.spots.where('lotId').equals(lot.id).count()
  if (count > 0) return count
  const zones = [
    ['A', 8, 'standard'], ['B', 6, 'standard'], ['C', 4, 'pmr'], ['D', 4, 'moto'], ['E', 2, 'camion'],
  ]
  const rows = []
  for (const [zone, n, type] of zones) {
    for (let i = 1; i <= n; i++) {
      rows.push({
        id: uid('spot'), lotId: lot.id, code: `${zone}${String(i).padStart(2, '0')}`,
        zone, type, status: 'libre', note: '', createdAt: nowIso(),
      })
    }
  }
  await db.spots.bulkAdd(rows)
  return rows.length
}

export async function addZone(lotId, { zone, count, type }) {
  const n = Math.max(1, Math.min(50, Number(count) || 1))
  const existing = await db.spots.where('lotId').equals(lotId).toArray()
  const start = existing.filter((s) => s.zone === zone).length
  const rows = []
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: uid('spot'), lotId, code: `${zone}${String(start + i).padStart(2, '0')}`,
      zone: zone.toUpperCase(), type, status: 'libre', note: '', createdAt: nowIso(),
    })
  }
  await db.spots.bulkAdd(rows)
  return rows.length
}

export async function setSpotStatus(spotId, status) {
  if(!['libre','occupe','reserve','hs'].includes(status)) throw new Error('État de place invalide.')
  return db.transaction('rw',db.spots,db.tickets,async()=>{
    const open=await db.tickets.where('spotId').equals(spotId).filter((t)=>t.status==='ouvert').count()
    if(open && status!=='occupe') throw new Error('Clôturez le ticket avant de libérer cette place.')
    if(!open && status==='occupe') throw new Error('Ouvrez un ticket pour occuper cette place.')
    await db.spots.update(spotId,{status})
  })
}

export async function deleteSpot(spotId) {
  const open = await db.tickets.where('spotId').equals(spotId).filter((t) => t.status === 'ouvert').count()
  if (open) throw new Error('Cette place a un ticket en cours : clôturez-le avant de la supprimer.')
  await db.spots.delete(spotId)
}

/* ---------------- tickets ---------------- */
async function createTicketCore({ lot, plate, spotId, entryAt, clientId, vehicleId, user, notes, hourlyRate, ratePlanId }) {
  const actor = await authorize(user, lot.id, 'parking.entry')
  const clean = String(plate || '').trim().toUpperCase()
  if (!clean) throw new Error('L’immatriculation est requise.')
  if (!spotId) throw new Error('Sélectionnez une place.')
  return db.transaction('rw', db.tickets, db.spots, db.lots, db.audit, db.ratePlans, db.parkingPasses, db.parkingSyncEvents, db.meta, async () => {
    const spot = await db.spots.get(spotId)
    if (!spot || spot.lotId !== lot.id) throw new Error('Place introuvable dans ce parking.')
    if (spot.status !== 'libre') throw new Error(`La place ${spot.code} n’est pas libre.`)
    const l = await db.lots.get(lot.id)
    const duplicate = await db.tickets.where('lotId').equals(lot.id).filter((t) => t.status === 'ouvert' && compact(t.plate) === compact(clean)).count()
    if (duplicate) throw new Error('Un ticket ouvert existe déjà pour cette plaque.')
    const at = entryAt || nowIso()
    if (!Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now()) throw new Error('Date d’entrée invalide ou future.')
    if (entryAt && Math.abs(Date.now() - Date.parse(entryAt)) > 120000 && !['admin', 'responsable'].includes(actor.role)) throw new Error('Seul un responsable peut antidater une entrée.')
    const plan = ratePlanId ? await db.ratePlans.get(ratePlanId) : null
    if (ratePlanId && (!plan || plan.lotId !== lot.id || !plan.active || (plan.spotType && plan.spotType !== spot.type))) throw new Error('Tarif non applicable à cette place.')
    const standardRate = Number(plan?.hourlyRate ?? spot.hourlyRate ?? l.hourlyRate ?? 500)
    const selectedRate = hourlyRate === undefined ? standardRate : money(hourlyRate)
    if (selectedRate !== standardRate && !['admin', 'responsable'].includes(actor.role)) throw new Error('Seul un responsable peut modifier le tarif.')
    const pass = await db.parkingPasses.where('[lotId+plateKey]').equals([lot.id, compact(clean)]).filter((p) => p.status === 'actif' && p.startAt <= at && p.endAt >= at).first()
    const n = l.ticketNext || 1
    await db.lots.update(lot.id, { ticketNext: n + 1 })
    const id = crypto.randomUUID()
    const policy={...DEFAULT_FEES,...l.parkingPolicy,...Object.fromEntries(Object.keys(DEFAULT_FEES).filter((k)=>plan?.[k]!==undefined).map((k)=>[k,plan[k]])),hourlyRate:selectedRate,dailyCap:Number(plan?.dailyCap ?? l.dailyCap ?? 6000),graceMinutes:Number(plan?.graceMinutes ?? l.graceMinutes ?? 15)}
    const frozen=validateFees(policy)
    const ticket = {
      ...frozen, version:1, syncStatus:ticketCloudEnabled(lot.id)?'pending':'local',
      id, lotId: lot.id, ref: `TCK-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`,
      plate: clean, vehicleId: vehicleId || null, clientId: clientId || null,
      spotId, spotCode: spot.code, spotType: spot.type,
      entryAt: at, exitAt: null,
      ratePlanId: plan?.id || null, ratePlanName: plan?.name || null,
      passId: pass?.id || null, passSnapshot: pass || null,
      hourlyRate: selectedRate,
      dailyCap: Number(plan?.dailyCap ?? l.dailyCap ?? 6000), graceMinutes: Number(plan?.graceMinutes ?? l.graceMinutes ?? 15),
      amount: 0, status: 'ouvert', paymentMethod: null, notes: notes || '',
      userId: user?.id || 'system', userName: user?.name || 'Système', createdAt: nowIso(),
    }
    await db.tickets.add(ticket)
    await enqueueParking(db,lot.id,'entry',ticket)
    await db.spots.update(spotId, { status: 'occupe', currentTicketId: id })
    await db.audit.add({
      id: uid('log'), lotId: lot.id, userId: ticket.userId, userName: ticket.userName,
      action: 'ticket-ouverture', at: nowIso(), details: `${ticket.ref} · ${clean} · place ${spot.code}`,
    })
    return ticket
  })
}

async function closeTicketCore(ticketId, { user, paymentMethod = 'espèces', amount, notes }) {
  const ticketBefore = await db.tickets.get(ticketId)
  if (!ticketBefore) throw new Error('Ticket introuvable.')
  const actor = await authorize(user, ticketBefore.lotId, 'parking.close')
  return db.transaction('rw', db.tickets, db.spots, db.audit, db.cashSessions, db.cashMovements, db.lots, db.parkingPasses, db.parkingSyncEvents, db.meta, async () => {
    const t = await db.tickets.get(ticketId)
    if (!t) throw new Error('Ticket introuvable.')
    if (t.status !== 'ouvert') throw new Error('Ce ticket est déjà clôturé.')
    const exitAt = nowIso()
    const pass = t.passId ? await db.parkingPasses.get(t.passId) : null
    const covered = subscriptionCovers(pass, t, exitAt)
    const charge=calculateParkingFee({...t,exitAt,subscriber:covered})
    const expected = charge.amount
    const final = amount === undefined || amount === '' ? expected : money(amount)
    if (Math.abs(final - expected) > 0.01) {
      if (!['admin', 'responsable'].includes(actor.role)) throw new Error('Seul un responsable peut modifier le montant calculé.')
      if (!String(notes || '').trim()) throw new Error('Motif de remise ou de majoration obligatoire.')
    }
    if (paymentMethod === 'abonnement' && (!covered || final !== 0)) throw new Error('Abonnement valide requis (aucun encaissement simulé).')
    const cashSessionId = await bookReceipt(db, { lotId: t.lotId, user: actor, source: `ticket:${t.id}`, amount: final, method: paymentMethod, at: exitAt })
    await db.tickets.update(ticketId, {
      exitAt, amount: final, status: 'cloture', paymentMethod, notes: notes || t.notes,
      version:(t.version||1)+1, feeBreakdown:charge, syncStatus:ticketCloudEnabled(t.lotId)?'pending':'local',
      cashSessionId, expectedAmount: expected, adjustmentReason: final !== expected ? notes : null, subscriptionCovered: covered, closedById: actor.id,
      billedMinutes: charge.minutes, billedHours: charge.hours,
      closedBy: user?.name || 'Système',
    })
    if (t.spotId) await db.spots.update(t.spotId, { status: 'libre', currentTicketId: null })
    await enqueueParking(db,t.lotId,'exit',{ticketId:t.id,expectedVersion:t.version||1,exitAt,amount:final,paymentMethod,reason:notes,spotCode:t.spotCode})
    await db.audit.add({
      id: uid('log'), lotId: t.lotId, userId: user?.id || 'system', userName: user?.name || 'Système',
      action: 'ticket-cloture', at: exitAt, details: `${t.ref} · ${t.plate} · ${final}`,
    })
    return { ...t, version:(t.version||1)+1, feeBreakdown:charge, exitAt, amount: final, paymentMethod, cashSessionId, subscriptionCovered: covered, status: 'cloture', billedMinutes: charge.minutes, billedHours: charge.hours }
  })
}

export async function cancelTicket(ticketId, user) {
  const row = await db.tickets.get(ticketId)
  if (!row) throw new Error('Ticket introuvable.')
  await authorize(user, row.lotId, 'parking.override')
  return db.transaction('rw', db.tickets, db.spots, db.audit, db.parkingSyncEvents, db.meta, async () => {
    const t = await db.tickets.get(ticketId)
    if (!t || t.status !== 'ouvert') throw new Error('Seul un ticket ouvert peut être annulé.')
    await db.tickets.update(ticketId, { status: 'annule', exitAt: nowIso(), amount: 0, version:(t.version||1)+1 })
    await enqueueParking(db,t.lotId,'cancel',{ticketId,expectedVersion:t.version||1,reason:'Annulation responsable',spotCode:t.spotCode})
    if (t.spotId) await db.spots.update(t.spotId, { status: 'libre', currentTicketId: null })
    await db.audit.add({
      id: uid('log'), lotId: t.lotId, userId: user?.id || 'system', userName: user?.name || 'Système',
      action: 'ticket-annulation', at: nowIso(), details: `${t.ref} · ${t.plate}`,
    })
  })
}

/* ---------------- réservations ---------------- */
export async function saveReservation(lotId, data, id) {
  return db.transaction('rw', db.reservations, db.spots, async () => {
    if(!data.startAt||!data.endAt||!Number.isFinite(Date.parse(data.startAt))||!Number.isFinite(Date.parse(data.endAt))||Date.parse(data.endAt)<=Date.parse(data.startAt))throw new Error('Période de réservation invalide.')
    const existing=id?await db.reservations.get(id):null
    if(id&&(!existing||existing.lotId!==lotId))throw new Error('Réservation introuvable dans ce parking.')
    if(data.lotId&&data.lotId!==lotId)throw new Error('Parking incohérent.')
    if(data.spotId){const spot=await db.spots.get(data.spotId);if(!spot||spot.lotId!==lotId)throw new Error('Place d’un autre parking ou introuvable.')}
    if (data.spotId && data.startAt && data.endAt) {
      const clash = await db.reservations.where('lotId').equals(lotId).toArray()
      const conflict = clash.find((r) => r.id !== id && r.spotId === data.spotId &&
        r.status !== 'annulee' && r.status !== 'terminee' &&
        new Date(r.startAt) < new Date(data.endAt) && new Date(r.endAt) > new Date(data.startAt))
      if (conflict) throw new Error(`Conflit : la place est déjà réservée du ${new Date(conflict.startAt).toLocaleString('fr-FR')} au ${new Date(conflict.endAt).toLocaleString('fr-FR')}.`)
    }
    if (id) {
      await db.reservations.update(id, data)
      return id
    }
    const rid = uid('resa')
    await db.reservations.add({
      id: rid, lotId, status: 'confirmee', createdAt: nowIso(),
      deposit: 0, amount: 0, notes: '', ...data,
    })
    if (data.spotId) {
      const spot = await db.spots.get(data.spotId)
      if (spot && spot.status === 'libre') await db.spots.update(data.spotId, { status: 'reserve' })
    }
    return rid
  })
}

export async function cancelReservation(id) {
  return db.transaction('rw', db.reservations, db.spots, async () => {
    const r = await db.reservations.get(id)
    if (!r) return
    await db.reservations.update(id, { status: 'annulee' })
    if (r.spotId) {
      const spot = await db.spots.get(r.spotId)
      const stillHeld = await db.reservations.where('spotId').equals(r.spotId)
        .filter((x) => x.id !== id && (x.status === 'confirmee' || x.status === 'en-cours')).count()
      if (spot && spot.status === 'reserve' && !stillHeld) await db.spots.update(r.spotId, { status: 'libre' })
    }
  })
}

export async function deleteReservation(id) {
  await cancelReservation(id)
  await db.reservations.delete(id)
}

export async function checkInReservation(reservation, lot, user) {
  await authorize(user,lot.id,'parking.entry')
  return db.transaction('rw',db.reservations,db.tickets,db.spots,db.lots,db.audit,db.ratePlans,db.parkingPasses,db.parkingSyncEvents,db.meta,db.users,async()=>{
    const current=await db.reservations.get(reservation.id)
    if(!current||current.lotId!==lot.id||current.status!=='confirmee')throw new Error('Réservation confirmée de ce parking requise.')
    const now=Date.now()
    if(now<Date.parse(current.startAt)||now>=Date.parse(current.endAt))throw new Error('Réservation hors période de validité.')
    const spotId=current.spotId||(await db.spots.where('lotId').equals(lot.id).filter(s=>s.status==='libre').first())?.id
    if(!spotId)throw new Error('Aucune place libre disponible.')
    const spot=await db.spots.get(spotId)
    if(!spot||spot.lotId!==lot.id||!['libre','reserve'].includes(spot.status))throw new Error('Place indisponible.')
    if(spot.status==='reserve')await db.spots.update(spotId,{status:'libre'})
    const ticket=await createTicketCore({lot,plate:current.plate,spotId,clientId:current.clientId,vehicleId:current.vehicleId,user,notes:`Réservation ${current.ref||''}`.trim()})
    await db.reservations.update(current.id,{status:'en-cours',spotId,ticketId:ticket.id})
    return ticket
  })
}

/* ---------------- statistiques stationnement ---------------- */
export function parkingStats({ spots = [], tickets = [], lot }) {
  const key=value=>{const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
  const today = key(new Date())
  const open = tickets.filter((t) => t.status === 'ouvert')
  const closed = tickets.filter((t) => t.status === 'cloture')
  const todayClosed = closed.filter((t) => t.exitAt && key(t.exitAt) === today)
  const total = spots.length
  const occupied = spots.filter((s) => s.status === 'occupe').length
  const reserved = spots.filter((s) => s.status === 'reserve').length
  const free = spots.filter((s) => s.status === 'libre').length
  return {
    total, occupied, reserved, free,
    outOfService: spots.filter((s) => s.status === 'hs').length,
    rate: total ? Math.round((occupied / total) * 100) : 0,
    openCount: open.length,
    openEstimate: open.reduce((a, t) => a + computeParkingCharge({ ...t, hourlyRate: t.hourlyRate ?? lot?.hourlyRate }).amount, 0),
    todayRevenue: todayClosed.reduce((a, t) => a + Number(t.amount || 0), 0),
    todayCount: todayClosed.length,
    monthRevenue: closed.filter((t) => t.exitAt && key(t.exitAt).slice(0,7) === today.slice(0, 7)).reduce((a, t) => a + Number(t.amount || 0), 0),
    avgTicket: closed.length ? Math.round(closed.reduce((a, t) => a + Number(t.amount || 0), 0) / closed.length) : 0,
  }
}

export async function seedParkingDemo(lot) {
  if (lot.code !== 'APA') return
  const tickets = await db.tickets.where('lotId').equals(lot.id).count()
  if (tickets > 0) return
  const spots = await db.spots.where('lotId').equals(lot.id).sortBy('code')
  const vehicles = await db.vehicles.where('lotId').equals(lot.id).toArray()
  const freeSpots = spots.filter((s) => s.status === 'libre')
  const demo = [
    { plate: 'CI 4471 AB', mins: 42, spot: 0 },
    { plate: 'CI 9920 KD', mins: 185, spot: 1 },
    { plate: vehicles[3]?.plate || 'CI 1183 QS', mins: 26, spot: 2 },
  ]
  let n = lot.ticketNext || 1
  for (const d of demo) {
    const spot = freeSpots[d.spot]
    if (!spot) continue
    const id = uid('tck')
    await db.tickets.add({
      id, lotId: lot.id, ref: `TCK-${new Date().getFullYear()}-${String(n++).padStart(4, '0')}`,
      plate: d.plate, vehicleId: null, clientId: null, spotId: spot.id, spotCode: spot.code,
      spotType: spot.type, entryAt: new Date(Date.now() - d.mins * 60000).toISOString(), exitAt: null,
      hourlyRate: 500, dailyCap: 6000, graceMinutes: 15, amount: 0, status: 'ouvert',
      paymentMethod: null, notes: '', userId: 'system', userName: 'Système', createdAt: nowIso(),
    })
    await db.spots.update(spot.id, { status: 'occupe', currentTicketId: id })
  }
  const resaSpot = freeSpots[4]
  if (resaSpot) {
    const client = await db.clients.where('lotId').equals(lot.id).first()
    await db.reservations.add({
      id: uid('resa'), lotId: lot.id, status: 'confirmee',
      clientId: client?.id || null,
      clientSnapshot: client ? { name: client.name, phone: client.phone } : { name: 'Client comptant' },
      plate: 'CI 7732 LM', vehicleId: null, spotId: resaSpot.id, spotCode: resaSpot.code,
      startAt: new Date(Date.now() + 3600000).toISOString(),
      endAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      amount: 12000, deposit: 3000, notes: 'Réservation 3 jours · parking couvert',
      userId: 'system', userName: 'Système', createdAt: nowIso(),
    })
    await db.spots.update(resaSpot.id, { status: 'reserve' })
  }
  await db.lots.update(lot.id, { ticketNext: n })
}

export async function createTicket(payload){const row=await createTicketCore(payload);try{await notifyLocal({lotId:row.lotId,userId:payload.user.id,kind:'validation',title:ticketCloudEnabled(row.lotId)?'Entrée enregistrée, confirmation cloud en attente':'Entrée de stationnement validée localement',body:`${row.ref} · ${row.spotCode}`,dedupe:`entry:${row.id}`})}catch(e){console.warn('notification',e.message)}try{await pushTicket({id:row.id,plate:row.plate,spot:row.spotCode,currency:payload?.lot?.currency})}catch(e){console.warn('Ticket non répliqué sur le serveur :',e.message)}return row}
export async function closeTicket(ticketId,options){const row=await closeTicketCore(ticketId,options);try{await notifyLocal({lotId:row.lotId,userId:options.user.id,kind:'validation',title:ticketCloudEnabled(row.lotId)?'Sortie enregistrée, confirmation cloud en attente':'Sortie de stationnement validée localement',body:row.ref,dedupe:`exit:${row.id}`})}catch(e){console.warn('notification',e.message)}try{await closeTicketRemote(row.id,{amount:row.amount,method:options?.paymentMethod})}catch(e){console.warn('Sortie non répliquée sur le serveur :',e.message)}return row}
