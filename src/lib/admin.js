import { db, uid, nowIso, hashPin, docNumber, authorize } from './db.js'
import { authRequest, notifyAuthChange } from './authSession.js'

export async function createAdditionalLot(currentUser, { name, logo, city, currency }) {
  currentUser = await authorize(currentUser, currentUser.lotId, 'staff.manage')
  name=String(name||'').trim()
  if(!name) throw new Error('Nom du parking requis.')
  if(typeof window!=='undefined'){
    const result=await authRequest('/api/admin/lots',{method:'POST',body:{name,logo,city,currency}})
    await db.transaction('rw',db.users,db.lots,async()=>{await db.users.put(result.user);await db.lots.put(result.lot)})
    notifyAuthChange();return result.lot
  }
  const lotId = uid('lot')
  const lot = {
    id: lotId, name, code: name.slice(0, 4).toUpperCase(), logo: logo || null,
    address: city || '', city: city || '', phone: '', email: '', taxId: '',
    currency: currency || 'XOF', vatRate: 18, invoicePrefix: 'FAC', receiptPrefix: 'REC',
    invoiceNext: 1, receiptNext: 1, tagline: 'Vente & location de véhicules',
    footerNote: 'Merci de votre confiance.', ownerKey: currentUser.username,
    createdAt: nowIso(), active: true,
  }
  await db.transaction('rw', db.lots, db.users, async () => {
    await db.lots.add(lot)
    await db.users.add({
      ...currentUser, id: uid('usr'), lotId, createdAt: nowIso(), active: true,
    })
  })
  return lot
}

export async function updateLot(lotId, patch) {
  await db.lots.update(lotId, patch)
}

export async function createEmployee(lotId, { name, username, pin, role = 'employe', phone = '', email = '' }, actor) {
  await authorize(actor, lotId, 'staff.manage')
  if (!['admin','responsable','caissier','agent','employe'].includes(role)) throw new Error('Rôle inconnu.')
  if (!String(name).trim() || !String(username).trim() || !/^\d{4,12}$/.test(String(pin))) throw new Error('Nom, identifiant et PIN de 4 à 12 chiffres requis.')
  const exists = await db.users.where('username').equalsIgnoreCase(username.trim()).first()
  if (exists) throw new Error('Cet identifiant est déjà utilisé.')
  if(typeof window!=='undefined'){
    const profile=await authRequest('/api/admin/users',{method:'POST',body:{lotId,name,username,pin,role,phone,email}})
    await db.users.put(profile);notifyAuthChange();return profile
  }
  const { hash, salt } = await hashPin(pin)
  const user = {
    id: uid('usr'), lotId, username: username.trim().toLowerCase(), name, role,
    pinHash: hash, salt, active: true, phone, email, createdAt: nowIso(),
  }
  await db.users.add(user)
  return user
}

export async function updateEmployee(id, patch, actor) {
  const existing = await db.users.get(id)
  if (!existing) throw new Error('Employé introuvable.')
  const a = await authorize(actor, existing.lotId, 'staff.manage')
  if(typeof window!=='undefined'){
    const profile=await authRequest(`/api/admin/users/${encodeURIComponent(id)}`,{method:'PATCH',body:patch})
    await db.users.put(profile);notifyAuthChange();return profile
  }
  if (patch.role && !['admin','responsable','caissier','agent','employe'].includes(patch.role)) throw new Error('Rôle inconnu.')
  if (patch.pin) {
    if (!/^\d{4,12}$/.test(String(patch.pin))) throw new Error('PIN de 4 à 12 chiffres requis.')
    const { hash, salt } = await hashPin(patch.pin)
    patch = { ...patch, pinHash: hash, salt }; delete patch.pin
  }
  const allowed = ['name','phone','email','role','active','pinHash','salt']
  if (Object.keys(patch).some((k) => !allowed.includes(k))) throw new Error('Champ non modifiable.')
  return db.transaction('rw', db.users, db.audit, async () => {
    const u = await db.users.get(id)
    if (u.role === 'admin' && u.active && (patch.active === false || (patch.role && patch.role !== 'admin'))) {
      const admins = await db.users.where('lotId').equals(u.lotId).filter((x) => x.active && x.role === 'admin').count()
      if (admins < 2) throw new Error('Le dernier administrateur actif ne peut pas être désactivé ou rétrogradé.')
    }
    await db.users.update(id, { ...patch, updatedAt: nowIso() })
    const safe = { ...patch }; delete safe.pinHash; delete safe.salt
    await db.audit.add({ id: uid('log'), lotId: u.lotId, userId: a.id, userName: a.name, action: 'personnel-modification', target: id, at: nowIso(), details: JSON.stringify({ changes: safe, pinChanged: !!patch.pinHash }) })
  })
}
export async function deleteEmployee(id, actor) {
  // Never erase historical attribution of receipts and attendance.
  return updateEmployee(id, { active: false }, actor)
}

export async function saveVehicle(lotId, data, id) {
  const saved = await saveVehicleLocal(lotId, data, id)
  try{ await pushVehicle(lotId, { ...data, price: Number(data.price) || 0 }, id) }
  catch(error){ console.warn('Enregistrement serveur différé :', error.message) }
  return saved
}

async function saveVehicleLocal(lotId, data, id) {
  if (id) {
    await db.vehicles.update(id, data)
    return id
  }
  const vid = uid('veh')
  await db.vehicles.add({
    id: vid, lotId, status: 'stock', photo: null, createdAt: nowIso(),
    ...data, price: Number(data.price) || 0, purchasePrice: Number(data.purchasePrice) || 0,
    rentPriceDaily: Number(data.rentPriceDaily) || 0, mileage: Number(data.mileage) || 0,
    year: Number(data.year) || new Date().getFullYear(),
  })
  await db.stockMoves.add({
    id: uid('mv'), lotId, vehicleId: vid, plate: data.plate, type: 'entrée',
    date: nowIso(), userId: 'system', userName: 'Système',
    note: `Entrée en stock ${data.brand} ${data.model}`,
  })
  return vid
}

export async function deleteVehicle(id) {
  try{ await removeVehicle(id) }catch(error){ console.warn('Suppression serveur différée :', error.message) }
  await db.transaction('rw', db.vehicles, db.stockMoves, async () => {
    await db.vehicles.delete(id)
    await db.stockMoves.where('vehicleId').equals(id).delete()
  })
}

export async function saveClient(lotId, data, id) {
  const saved = await saveClientLocal(lotId, data, id)
  if(!id){ try{ await pushClient({ ...data, name: String(data.name||'').trim() }) }catch(error){ console.warn('Client non synchronisé :', error.message) } }
  return saved
}

async function saveClientLocal(lotId, data, id) {
  if (id) {
    await db.clients.update(id, data)
    return id
  }
  const cid = uid('cli')
  await db.clients.add({ id: cid, lotId, createdAt: nowIso(), type: 'particulier', ...data })
  return cid
}

export async function deleteClient(id) {
  await db.clients.delete(id)
}

export async function addExpense(lotId, data, userId) {
  const id = uid('exp')
  await db.expenses.add({
    id, lotId, createdAt: nowIso(), userId,
    label: data.label, category: data.category, amount: Number(data.amount) || 0,
    date: data.date ? new Date(`${data.date}T12:00:00`).toISOString() : nowIso(),
    notes: data.notes || '',
  })
  return id
}

export async function deleteExpense(id) {
  await db.expenses.delete(id)
}

export const BACKUP_TABLES = ['lots','users','vehicles','clients','sales','payments','expenses','stockMoves','audit','spots','tickets','reservations','ocrFeedback','staffShifts','attendance','cashSessions','cashMovements','incidents','ratePlans','parkingPasses','parkingSyncEvents','plateCorrections','notifications','bankAccounts','bankTransactions','budgets','ocrObservations', 'vehiclePhotos', 'vaults' ]
export async function exportBackup(lotId) {
  // v19.2 : version 4. La v3 omettait vehiclePhotos et vaults : une sauvegarde
  // « complète » restaurait les fiches véhicules SANS leurs photos, en silence.
  const out = { version: 4, exportedAt: nowIso(), lotId, data: {}, media: { encrypted: false, vault: false } }
  await db.transaction('r', BACKUP_TABLES.map((t) => db.table(t)), async () => {
    for (const t of BACKUP_TABLES) {
      const rows = t === 'lots' ? [await db.lots.get(lotId)].filter(Boolean) : await db.table(t).where('lotId').equals(lotId).toArray()
      out.data[t] = rows.map((r) => {
        if (t !== 'users') return r
        const { pinHash: _pinHash, salt: _salt, ...safe } = r; return safe
      })
    }
  })
  out.media.encrypted = (out.data.vehiclePhotos || []).some((row) => row.enc)
  out.media.vault = (out.data.vaults || []).length > 0
  return out
}
export async function importBackup(payload) {
  if (!payload?.data || !payload.lotId) throw new Error('Sauvegarde invalide ou identifiant de parking absent.')
  const unknown = Object.keys(payload.data).filter((t) => !BACKUP_TABLES.includes(t))
  if (unknown.length) throw new Error('Tables non autorisées dans la sauvegarde.')
  for (const [t, rows] of Object.entries(payload.data)) {
    if (!Array.isArray(rows) || rows.length > 100000) throw new Error('Contenu de sauvegarde invalide.')
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || (t === 'lots' ? row.id !== payload.lotId : row.lotId !== payload.lotId)) throw new Error('Sauvegarde contenant des données d’un autre parking.')
    }
  }
  await db.transaction('rw', BACKUP_TABLES.map((t) => db.table(t)), async () => {
    for (const t of BACKUP_TABLES) for (const original of payload.data[t] || []) {
      const before = await db.table(t).get(original.id)
      if (before && (t === 'lots' ? before.id !== payload.lotId : before.lotId !== payload.lotId)) throw new Error('Collision d’identifiant avec un autre parking.')
      if (t === 'users') {
        if (before) continue // Never replace credentials, roles or activation.
        const safe = { ...original, active: false, role: 'employe' }; delete safe.pinHash; delete safe.salt
        await db.users.put(safe)
      } else if (t === 'ocrFeedback') {
        if (!before) await db.ocrFeedback.put({ ...original, synced: 0 })
      } else await db.table(t).put(original)
    }
  })
  return true
}

export async function nextDocPreview(lot, kind) {
  const n = kind === 'invoice' ? lot.invoiceNext : lot.receiptNext
  return docNumber(lot, kind, n || 1)
}
