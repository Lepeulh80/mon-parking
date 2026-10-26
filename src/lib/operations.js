import { db, nowIso, authorize } from './db.js'
import { cashSummary, money, CASH_METHODS, bookReceipt } from './cashLedger.js'
import { enqueueParking, ticketCloudEnabled } from './parkingSync.js'
import { compact } from './plate.js'

export const OPS_TABLES = ['staffShifts', 'attendance', 'cashSessions', 'cashMovements', 'incidents', 'ratePlans', 'parkingPasses']
const id = () => crypto.randomUUID()
const text = (v) => String(v || '').trim()
function interval(start, end) {
  const a = Date.parse(start), b = Date.parse(end)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error('Période invalide : la fin doit suivre le début.')
  return [new Date(a).toISOString(), new Date(b).toISOString()]
}
async function audit(lotId, actor, action, target, details) {
  await db.audit.add({ id: id(), lotId, userId: actor.id, userName: actor.name, action, at: nowIso(), target, details: JSON.stringify(details) })
}
async function worker(lotId, userId) {
  const u = await db.users.get(userId)
  if (!u?.active || u.lotId !== lotId) throw new Error('Employé actif de ce parking requis.')
  return u
}
export async function saveShift(lotId, actor, data, shiftId) {
  const a = await authorize(actor, lotId, 'planning.manage')
  const employee = await worker(lotId, data.userId)
  const [startAt, endAt] = interval(data.startAt, data.endAt)
  if (Date.parse(endAt) - Date.parse(startAt) > 24 * 3600000) throw new Error('Une vacation ne peut pas dépasser 24 heures.')
  return db.transaction('rw', db.staffShifts, db.audit, async () => {
    const before = shiftId ? await db.staffShifts.get(shiftId) : null
    if (shiftId && (!before || before.lotId !== lotId)) throw new Error('Vacation introuvable.')
    const overlaps = await db.staffShifts.where('userId').equals(employee.id).filter((s) => s.id !== shiftId && s.status !== 'annule' && s.startAt < endAt && s.endAt > startAt).count()
    if (overlaps) throw new Error('Chevauchement avec une autre vacation de cet employé.')
    const row = { id: shiftId || id(), lotId, userId: employee.id, userName: employee.name, startAt, endAt,
      zone: text(data.zone), note: text(data.note), status: 'planifie', createdBy: a.id, updatedAt: nowIso() }
    await db.staffShifts.put(row); await audit(lotId, a, 'planning-enregistrement', row.id, { before, after: row }); return row
  })
}
export async function cancelShift(shiftId, actor, reason) {
  const row = await db.staffShifts.get(shiftId)
  if (!row) throw new Error('Vacation introuvable.')
  const a = await authorize(actor, row.lotId, 'planning.manage')
  if (!text(reason)) throw new Error('Motif obligatoire.')
  return db.transaction('rw', db.staffShifts, db.audit, async () => {
    if ((await db.staffShifts.get(shiftId)).status !== 'planifie') throw new Error('Vacation déjà annulée.')
    await db.staffShifts.update(shiftId, { status: 'annule', cancellationReason: reason })
    await audit(row.lotId, a, 'planning-annulation', shiftId, { reason })
  })
}
export function attendanceMinutes(row, at = Date.now()) {
  const end = row.outAt ? Date.parse(row.outAt) : Number(at)
  const gross = Math.max(0, end - Date.parse(row.inAt))
  const pauses = (row.breaks || []).reduce((n, b) => n + Math.max(0, (b.end ? Date.parse(b.end) : end) - Date.parse(b.start)), 0)
  return Math.max(0, Math.round((gross - pauses) / 60000))
}
export async function clockAttendance(lotId, actor, action) {
  const a = await authorize(actor, lotId, 'attendance.self')
  if (!['in', 'pause', 'resume', 'out'].includes(action)) throw new Error('Action de pointage invalide.')
  return db.transaction('rw', db.attendance, db.staffShifts, db.audit, async () => {
    const open = await db.attendance.where('[lotId+userId]').equals([lotId, a.id]).filter((r) => !r.outAt).first()
    const at = nowIso()
    if (action === 'in') {
      if (open) throw new Error('Vous êtes déjà pointé.')
      const shifts = await db.staffShifts.where('userId').equals(a.id).filter((s) => s.lotId === lotId && s.status === 'planifie' && s.startAt <= at && s.endAt > at).toArray()
      const row = { id: id(), lotId, userId: a.id, userName: a.name, inAt: at, outAt: null, breaks: [], shiftId: shifts[0]?.id || null }
      await db.attendance.add(row); await audit(lotId, a, 'pointage-in', row.id, { inAt: at }); return row
    }
    if (!open) throw new Error('Aucun pointage en cours.')
    const breaks = [...(open.breaks || [])]
    const last = breaks.at(-1)
    if (action === 'pause') {
      if (last && !last.end) throw new Error('Une pause est déjà en cours.')
      breaks.push({ start: at, end: null })
    } else if (action === 'resume') {
      if (!last || last.end) throw new Error('Aucune pause en cours.')
      breaks[breaks.length - 1] = { ...last, end: at }
    } else if (last && !last.end) breaks[breaks.length - 1] = { ...last, end: at }
    const row = { ...open, breaks, outAt: action === 'out' ? at : null }
    await db.attendance.put(row); await audit(lotId, a, `pointage-${action}`, row.id, { at }); return row
  })
}
export async function correctAttendance(entryId, actor, data) {
  const row = await db.attendance.get(entryId)
  if (!row) throw new Error('Pointage introuvable.')
  const a = await authorize(actor, row.lotId, 'attendance.manage')
  const [inAt, outAt] = interval(data.inAt, data.outAt)
  if (!text(data.reason)) throw new Error('Justification de correction obligatoire.')
  if (Date.parse(outAt) > Date.now()) throw new Error('Une sortie pointée ne peut pas être future.')
  if (Date.parse(outAt) - Date.parse(inAt) > 24 * 3600000) throw new Error('Pointage limité à 24 heures.')
  return db.transaction('rw', db.attendance, db.audit, async () => {
    const fresh = await db.attendance.get(entryId)
    const overlaps = await db.attendance.where('userId').equals(fresh.userId).filter((r) => r.id !== entryId && r.inAt < outAt && (!r.outAt || r.outAt > inAt)).count()
    if (overlaps) throw new Error('Correction en conflit avec un autre pointage.')
    const row2 = { ...fresh, inAt, outAt, breaks: (fresh.breaks || []).filter((b) => b.start >= inAt && b.end && b.end <= outAt), correctedBy: a.id, correctionReason: data.reason }
    await db.attendance.put(row2); await audit(fresh.lotId, a, 'pointage-correction', entryId, { before: fresh, after: row2, reason: data.reason }); return row2
  })
}
export async function openCash(lotId, actor, openingFloat) {
  const a = await authorize(actor, lotId, 'cash.open'), opening = money(openingFloat)
  return db.transaction('rw', db.cashSessions, db.audit, db.parkingSyncEvents, db.meta, async () => {
    const open = await db.cashSessions.where('[lotId+userId]').equals([lotId, a.id]).filter((r) => r.status === 'ouverte').count()
    if (open) throw new Error('Une session de caisse est déjà ouverte.')
    const row = { id: id(), lotId, userId: a.id, userName: a.name, cloudMode:ticketCloudEnabled(lotId), openingFloat: opening, openedAt: nowIso(), status: 'ouverte' }
    await db.cashSessions.add(row); await enqueueParking(db,lotId,'cash_open',row); await audit(lotId, a, 'caisse-ouverture', row.id, row); return row
  })
}
export async function moveCash(sessionId, actor, data) {
  const session = await db.cashSessions.get(sessionId)
  if (!session) throw new Error('Caisse introuvable.')
  const a = await authorize(actor, session.lotId, 'cash.move')
  if (ticketCloudEnabled(session.lotId)) throw new Error('Apports/retraits désactivés en mode cloud parking : séparez les caisses de vente locales.')
  if (session.userId !== a.id) throw new Error('Utilisez votre propre caisse.')
  if (!['apport', 'retrait'].includes(data.kind) || !text(data.reason)) throw new Error('Type et motif requis.')
  const amount = money(data.amount, { zero: false })
  return db.transaction('rw', db.cashSessions, db.cashMovements, db.audit, async () => {
    const fresh = await db.cashSessions.get(sessionId)
    if (fresh.status !== 'ouverte') throw new Error('Caisse clôturée.')
    const moves = await db.cashMovements.where('sessionId').equals(sessionId).toArray()
    if (data.kind === 'retrait' && amount > cashSummary(fresh, moves).expected) throw new Error('Retrait supérieur au solde théorique.')
    const row = { id: id(), lotId: session.lotId, sessionId, userId: a.id, kind: data.kind, amount, method: 'espèces', at: nowIso(), reason: data.reason }
    await db.cashMovements.add(row); await audit(session.lotId, a, 'caisse-mouvement', row.id, row); return row
  })
}
export async function closeCash(sessionId, actor, counted, reason = '') {
  const session = await db.cashSessions.get(sessionId)
  if (!session) throw new Error('Caisse introuvable.')
  const a = await authorize(actor, session.lotId, 'cash.open')
  if (session.userId !== a.id) throw new Error('Seul le titulaire peut clôturer sa caisse.')
  const amount = money(counted)
  return db.transaction('rw', db.cashSessions, db.cashMovements, db.audit, db.parkingSyncEvents, db.meta, async () => {
    const s = await db.cashSessions.get(sessionId)
    if (s.status !== 'ouverte') throw new Error('Caisse déjà clôturée.')
    const moves = await db.cashMovements.where('sessionId').equals(sessionId).toArray()
    const summary = cashSummary(s, moves)
    const variance = Math.round((amount - summary.expected) * 100) / 100
    if (variance && !text(reason)) throw new Error('Expliquez l’écart de caisse.')
    const row = { ...s, ...summary, status: 'cloturee', counted: amount, variance, reason, closedAt: nowIso(), reviewedAt: null }
    await db.cashSessions.put(row); await enqueueParking(db,s.lotId,'cash_close',{sessionId,counted:amount,reason}); await audit(s.lotId, a, 'caisse-cloture', sessionId, row); return row
  })
}
export async function reviewCash(sessionId, actor) {
  const s = await db.cashSessions.get(sessionId)
  if (!s) throw new Error('Caisse introuvable.')
  const a = await authorize(actor, s.lotId, 'cash.review')
  return db.transaction('rw', db.cashSessions, db.audit, async () => {
    const fresh = await db.cashSessions.get(sessionId)
    if (fresh.status !== 'cloturee' || fresh.reviewedAt) throw new Error('Caisse non clôturée ou déjà contrôlée.')
    if (fresh.userId === a.id) throw new Error('La revue requiert un autre responsable (séparation des tâches).')
    await db.cashSessions.update(sessionId, { reviewedAt: nowIso(), reviewedBy: a.id })
    await audit(s.lotId, a, 'caisse-revue', sessionId, { reviewedBy: a.id })
  })
}
export async function saveIncident(lotId, actor, data) {
  const a = await authorize(actor, lotId, 'incidents.report')
  if (!text(data.title) || !text(data.description)) throw new Error('Titre et description obligatoires.')
  if (!['faible', 'moyenne', 'haute', 'critique'].includes(data.severity)) throw new Error('Gravité invalide.')
  if (data.assignedTo) await worker(lotId, data.assignedTo)
  if (data.photo && (!/^data:image\/(jpeg|png|webp);base64,/.test(data.photo) || data.photo.length > 1400000)) throw new Error('Photo JPEG/PNG/WebP de 1 Mo maximum.')
  const row = { id: id(), lotId, title: text(data.title), description: text(data.description), plate: text(data.plate).toUpperCase(),
    severity: data.severity, assignedTo: data.assignedTo || null, photo: data.photo || null, status: 'ouvert',
    reportedBy: a.id, reportedName: a.name, createdAt: nowIso(), history: [] }
  return db.transaction('rw', db.incidents, db.audit, async () => {
    await db.incidents.add(row); await audit(lotId, a, 'incident-signalement', row.id, { title: row.title, severity: row.severity }); return row
  })
}
export async function transitionIncident(incidentId, actor, status, note) {
  const r = await db.incidents.get(incidentId)
  if (!r) throw new Error('Incident introuvable.')
  const a = await authorize(actor, r.lotId, 'incidents.manage')
  if (!text(note)) throw new Error('Commentaire de suivi obligatoire.')
  return db.transaction('rw', db.incidents, db.audit, async () => {
    const fresh = await db.incidents.get(incidentId)
    const transitions = { ouvert: ['en_cours'], en_cours: ['resolu'], resolu: ['en_cours'] }
    if (!transitions[fresh.status]?.includes(status)) throw new Error('Transition d’incident invalide.')
    const update = { status, resolvedAt: status === 'resolu' ? nowIso() : null,
      history: [...fresh.history, { at: nowIso(), userId: a.id, userName: a.name, from: fresh.status, to: status, note }] }
    await db.incidents.update(incidentId, update); await audit(r.lotId, a, 'incident-suivi', incidentId, { ...update, note }); return { ...fresh, ...update }
  })
}
export async function saveRatePlan(lotId, actor, data, rateId) {
  const a = await authorize(actor, lotId, 'rates.manage')
  if (!text(data.name)) throw new Error('Nom du tarif obligatoire.')
  const hourlyRate = money(data.hourlyRate), dailyCap = money(data.dailyCap)
  const graceMinutes = Number(data.graceMinutes)
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 1440) throw new Error('Franchise invalide (0–1440 minutes).')
  return db.transaction('rw', db.ratePlans, db.audit, async () => {
    const old = rateId ? await db.ratePlans.get(rateId) : null
    if (rateId && (!old || old.lotId !== lotId)) throw new Error('Tarif introuvable.')
    const row = { id: rateId || id(), lotId, name: text(data.name), hourlyRate, dailyCap, graceMinutes,
      spotType: data.spotType || '', active: data.active !== false, updatedAt: nowIso() }
    await db.ratePlans.put(row); await audit(lotId, a, 'tarif-modification', row.id, { before: old, after: row }); return row
  })
}
export async function issuePass(lotId, actor, data) {
  const a = await authorize(actor, lotId, 'passes.issue')
  if(ticketCloudEnabled(lotId))throw new Error('Émettez les abonnements avant la bascule puis actualisez la configuration cloud. Paiement d’abonnement sur caisse locale distincte.')
  const [startAt, endAt] = interval(data.startAt, data.endAt)
  const plateKey = compact(data.plate)
  if (plateKey.length < 4 || !text(data.holder)) throw new Error('Titulaire et plaque valides requis.')
  const amount = money(data.amount)
  const method = data.paymentMethod || 'espèces'
  if (amount && !CASH_METHODS.includes(method)) throw new Error('Mode de paiement invalide.')
  return db.transaction('rw', db.parkingPasses, db.cashSessions, db.cashMovements, db.lots, db.audit, async () => {
    const clash = await db.parkingPasses.where('[lotId+plateKey]').equals([lotId, plateKey]).filter((p) => p.status === 'actif' && p.startAt < endAt && p.endAt > startAt).count()
    if (clash) throw new Error('Un abonnement existe déjà pour cette plaque et cette période.')
    const row = { id: id(), lotId, holder: text(data.holder), plate: text(data.plate).toUpperCase(), plateKey,
      startAt, endAt, amount, paymentMethod: method, status: 'actif', issuedBy: a.id, createdAt: nowIso() }
    row.cashSessionId = await bookReceipt(db, { lotId, user: a, source: `pass:${row.id}`, amount, method, at: row.createdAt })
    await db.parkingPasses.add(row); await audit(lotId, a, 'abonnement-emission', row.id, { plate: row.plate, amount, startAt, endAt }); return row
  })
}
export async function revokePass(passId, actor, reason) {
  const p = await db.parkingPasses.get(passId)
  if (!p) throw new Error('Abonnement introuvable.')
  const a = await authorize(actor, p.lotId, 'rates.manage')
  if (!text(reason)) throw new Error('Motif de suspension obligatoire.')
  return db.transaction('rw', db.parkingPasses, db.audit, async () => {
    const fresh = await db.parkingPasses.get(passId)
    if (fresh.status !== 'actif') throw new Error('Abonnement déjà suspendu.')
    await db.parkingPasses.update(passId, { status: 'suspendu', revokedAt: nowIso(), reason })
    await audit(p.lotId, a, 'abonnement-suspension', passId, { reason })
  })
}
export function subscriptionCovers(pass, ticket, exitAt) {
  return !!pass && pass.status === 'actif' && pass.plateKey === compact(ticket.plate) && pass.lotId === ticket.lotId && pass.startAt <= ticket.entryAt && pass.endAt >= exitAt
}
export function operationalKPIs({ spots = [], tickets = [], attendance = [], incidents = [], cashSessions = [], shifts = [], passes = [], at = Date.now() }) {
  const now = new Date(at), current = now.toISOString(), day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const available = spots.filter((s) => s.status !== 'hs'), occupied = available.filter((s) => s.status === 'occupe').length
  const onSite = attendance.filter((a) => !a.outAt)
  const overdue = tickets.filter((t) => t.status === 'ouvert' && at - Date.parse(t.entryAt) > Number(t.maxStayHours || 24) * 3600000)
  const closed = tickets.filter((t) => t.status === 'cloture' && Date.parse(t.exitAt) >= day && Date.parse(t.exitAt) <= at)
  const noShows = shifts.filter((s) => s.status === 'planifie' && Date.parse(s.startAt) + 15 * 60000 < at && s.endAt > current && !attendance.some((a) => a.userId === s.userId && a.inAt <= s.endAt && (!a.outAt || a.outAt >= s.startAt)))
  const alerts = [
    ...overdue.map((t) => ({ severity: 'warn', text: `Séjour > 24 h : ${t.plate} (${t.ref})` })),
    ...noShows.map((s) => ({ severity: 'danger', text: `Absence/retard à vérifier : ${s.userName}` })),
    ...incidents.filter((i) => i.status !== 'resolu' && ['haute', 'critique'].includes(i.severity)).map((i) => ({ severity: 'danger', text: `Incident ${i.severity} : ${i.title}` })),
    ...cashSessions.filter((s) => s.status === 'cloturee' && s.variance && !s.reviewedAt).map((s) => ({ severity: 'warn', text: `Écart de caisse non contrôlé : ${s.userName} (${s.variance})` })),
  ]
  return { capacity: available.length, occupied, free: available.filter((s) => s.status === 'libre').length,
    occupancy: available.length ? occupied / available.length * 100 : 0, onSite: onSite.length,
    todayRevenue: closed.reduce((n, t) => n + Number(t.amount || 0), 0), todayExits: closed.length,
    openIncidents: incidents.filter((i) => i.status !== 'resolu').length, overdue: overdue.length,
    activePasses: passes.filter((p) => p.status === 'actif' && p.startAt <= current && p.endAt >= current).length,
    unlinkedReceipts: closed.filter((t) => t.amount > 0 && !t.cashSessionId).length,
    missingAttendance: noShows.length, alerts }
}
export function csvRows(headers, rows) {
  const escape = (v) => '"' + String(v ?? '').replace(/^[\s]*[=+@-]/, (s) => "'" + s).replace(/"/g, '""') + '"'
  return '\ufeff' + [headers, ...rows].map((r) => r.map(escape).join(';')).join('\r\n')
}
