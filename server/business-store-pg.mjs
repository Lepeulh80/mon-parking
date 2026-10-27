// MON PARKING — données métier sur PostgreSQL (véhicules, clients, ventes,
// paiements, tickets, photos). Chaque méthode reçoit `lotId` : le filtrage par
// parking est fait ici, après vérification du jeton de session en amont. Un
// employé du parking A ne peut donc pas lire une ligne du parking B.
import { randomUUID } from 'node:crypto'
import { openSql } from './sql.mjs'

const num = (v) => Number(v ?? 0)
const toVehicle = (r) => ({
  ...(r.data || {}),
  id: r.id, lotId: r.lot_id, plate: r.plate, status: r.status, brand: r.brand, model: r.model,
  year: r.year, category: r.category, price: num(r.price), cost: num(r.cost), mileage: r.mileage,
  fuel: r.fuel, gearbox: r.gearbox, color: r.color,
  photoCount: r.photo_count, frameCount: r.frame_count,
  createdAt: num(r.created_at), updatedAt: num(r.updated_at),
})

export class PgBusinessStore {
  static async open({ connectionString, autoMigrate = true } = {}) {
    const { sql, close } = await openSql({ connectionString })
    const store = new PgBusinessStore(sql, close)
    if (autoMigrate) await store.ensureSchema()
    return store
  }

  constructor(sql, close = async () => {}) { this.sql = sql; this._close = close }

  async ensureSchema() {
    const { readFileSync, existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const here = dirname(new URL(import.meta.url).pathname)
    const file = join(here, '..', 'supabase', 'migrations', '20261027120000_server_business.sql')
    if (!existsSync(file)) return
    await this.sql.exec(readFileSync(file, 'utf8'))
  }

  async close() { await this._close() }

  // ------------------------------- véhicules -------------------------------
  async listVehicles(lotId, { status, search, limit = 500 } = {}) {
    const where = ['lot_id=?'], params = [lotId]
    if (status) { where.push('status=?'); params.push(status) }
    if (search) { where.push('(lower(plate) LIKE ? OR lower(brand) LIKE ? OR lower(model) LIKE ?)'); const q = `%${String(search).toLowerCase()}%`; params.push(q, q, q) }
    params.push(Math.min(Math.max(Number(limit) || 500, 1), 2000))
    const rows = await this.sql.all(`SELECT * FROM vehicles WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, params)
    return rows.map(toVehicle)
  }

  async getVehicle(lotId, id) {
    const row = await this.sql.one('SELECT * FROM vehicles WHERE id=? AND lot_id=?', [id, lotId])
    return row ? toVehicle(row) : null
  }

  async createVehicle(lotId, input) {
    const now = Date.now()
    const id = input.id || randomUUID()
    const plate = String(input.plate || '').trim()
    if (!plate) { const error = new Error('Plaque obligatoire.'); error.status = 400; throw error }
    const price = Number(input.price ?? 0)
    if (!Number.isFinite(price) || price < 0) { const error = new Error('Prix invalide.'); error.status = 400; throw error }
    const known = ['id', 'lotId', 'plate', 'status', 'brand', 'model', 'year', 'category', 'price', 'cost', 'mileage', 'fuel', 'gearbox', 'color', 'photoCount', 'frameCount', 'createdAt', 'updatedAt']
    const extra = Object.fromEntries(Object.entries(input).filter(([k]) => !known.includes(k)))
    try {
      await this.sql.run(
        `INSERT INTO vehicles(id,lot_id,plate,status,brand,model,year,category,price,cost,mileage,fuel,gearbox,color,photo_count,frame_count,data,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, lotId, plate, input.status || 'disponible', input.brand || '', input.model || '', Number(input.year) || 0,
          input.category || '', price, Number(input.cost) || 0, Number(input.mileage) || 0, input.fuel || '',
          input.gearbox || '', input.color || '', Number(input.photoCount) || 0, Number(input.frameCount) || 0,
          JSON.stringify(extra), Number(input.createdAt) || now, now]
      )
    } catch (error) {
      // 23505 = violation d'unicité : la plaque existe déjà sur ce parking.
      if (error.code === '23505') { const e = new Error('Cette plaque existe déjà sur ce parking.'); e.status = 409; throw e }
      throw error
    }
    return this.getVehicle(lotId, id)
  }

  async updateVehicle(lotId, id, patch) {
    const current = await this.getVehicle(lotId, id)
    if (!current) { const error = new Error('Véhicule introuvable.'); error.status = 404; throw error }
    const merged = { ...current, ...patch }
    const extra = Object.fromEntries(Object.entries(merged).filter(([k]) => !['id', 'lotId', 'plate', 'status', 'brand', 'model', 'year', 'category', 'price', 'cost', 'mileage', 'fuel', 'gearbox', 'color', 'photoCount', 'frameCount', 'createdAt', 'updatedAt'].includes(k)))
    await this.sql.run(
      `UPDATE vehicles SET plate=?,status=?,brand=?,model=?,year=?,category=?,price=?,cost=?,mileage=?,fuel=?,gearbox=?,color=?,photo_count=?,frame_count=?,data=?,updated_at=? WHERE id=? AND lot_id=?`,
      [merged.plate, merged.status, merged.brand || '', merged.model || '', Number(merged.year) || 0, merged.category || '',
        Number(merged.price) || 0, Number(merged.cost) || 0, Number(merged.mileage) || 0, merged.fuel || '',
        merged.gearbox || '', merged.color || '', Number(merged.photoCount) || 0, Number(merged.frameCount) || 0,
        JSON.stringify(extra), Date.now(), id, lotId]
    )
    return this.getVehicle(lotId, id)
  }

  // La suppression est refusée dès qu'une vente référence le véhicule :
  // ON DELETE RESTRICT protège l'historique comptable.
  async deleteVehicle(lotId, id) {
    try { await this.sql.run('DELETE FROM vehicles WHERE id=? AND lot_id=?', [id, lotId]) }
    catch (error) {
      if (error.code === '23503') { const e = new Error('Véhicule lié à une vente : suppression impossible.'); e.status = 409; throw e }
      throw error
    }
    return { ok: true }
  }

  // -------------------------------- clients --------------------------------
  async listClients(lotId) {
    const rows = await this.sql.all('SELECT * FROM clients WHERE lot_id=? ORDER BY created_at DESC', [lotId])
    return rows.map((r) => ({ ...(r.data || {}), id: r.id, lotId: r.lot_id, name: r.name, phone: r.phone, email: r.email, address: r.address, createdAt: num(r.created_at) }))
  }

  async createClient(lotId, input) {
    const id = input.id || randomUUID()
    await this.sql.run('INSERT INTO clients(id,lot_id,name,phone,email,address,data,created_at) VALUES(?,?,?,?,?,?,?,?)',
      [id, lotId, String(input.name || '').trim(), input.phone || '', input.email || '', input.address || '', JSON.stringify({}), Date.now()])
    return { ...input, id, lotId }
  }

  // --------------------------------- ventes --------------------------------
  async listSales(lotId, { type, limit = 500 } = {}) {
    const params = [lotId], where = ['lot_id=?']
    if (type) { where.push('type=?'); params.push(type) }
    params.push(Math.min(Number(limit) || 500, 2000))
    const rows = await this.sql.all(`SELECT * FROM sales WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT ?`, params)
    return rows.map((r) => ({ ...(r.data || {}), id: r.id, lotId: r.lot_id, ref: r.ref, type: r.type, status: r.status, vehicleId: r.vehicle_id, clientId: r.client_id, userId: r.user_id, total: num(r.total), paid: num(r.paid), invoiceNumber: r.invoice_number, date: num(r.date) }))
  }

  // Vente en une transaction : numéro de facture attribué sous verrou, véhicule
  // marqué vendu, ligne de vente et encaissement créés ensemble. Si une étape
  // échoue, rien n'est écrit — c'est le point que SQLite ne garantissait pas
  // au-delà d'une seule connexion.
  async createSale(lotId, input) {
    return this.sql.transaction(async (tx) => {
      const now = Date.now()
      const vehicle = input.vehicleId ? await tx.one('SELECT * FROM vehicles WHERE id=? AND lot_id=?', [input.vehicleId, lotId]) : null
      if (input.vehicleId && !vehicle) { const e = new Error('Véhicule introuvable sur ce parking.'); e.status = 404; throw e }
      if (vehicle && vehicle.status === 'vendu' && input.type === 'vente') { const e = new Error('Véhicule déjà vendu.'); e.status = 409; throw e }

      // Numéro de facture séquentiel par parking, sous verrou consultatif :
      // deux caisses simultanées ne peuvent pas obtenir le même numéro.
      await tx.exec(`SELECT pg_advisory_xact_lock(hashtext('mp_invoice:${lotId.replace(/'/g, "''")}'))`)
      const last = await tx.one("SELECT invoice_number FROM sales WHERE lot_id=? AND invoice_number IS NOT NULL ORDER BY invoice_number DESC LIMIT 1", [lotId])
      const nextNo = (last ? Number(String(last.invoice_number).replace(/\D/g, '')) : 0) + 1
      const year = new Date(now).getUTCFullYear()
      const invoiceNumber = `FAC-${year}-${String(nextNo).padStart(4, '0')}`
      const total = Number(input.total ?? (vehicle ? num(vehicle.price) : 0))
      const paid = Number(input.paid ?? total)
      if (!Number.isFinite(total) || total < 0) { const e = new Error('Montant total invalide.'); e.status = 400; throw e }
      if (!Number.isFinite(paid) || paid < 0) { const e = new Error('Montant encaissé invalide.'); e.status = 400; throw e }
      if (paid > total) { const e = new Error('Encaissement supérieur au total.'); e.status = 400; throw e }

      const id = input.id || randomUUID()
      const ref = input.ref || `VTE-${year}-${String(nextNo).padStart(4, '0')}`
      await tx.run(`INSERT INTO sales(id,lot_id,ref,type,status,vehicle_id,client_id,user_id,total,paid,invoice_number,date,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, lotId, ref, input.type || 'vente', input.status || (paid >= total ? 'payee' : 'partielle'), input.vehicleId || null,
          input.clientId || null, input.userId || null, total, paid, invoiceNumber, now, JSON.stringify({ clientName: input.clientName || '' })])

      if (input.vehicleId && input.type !== 'location') await tx.run("UPDATE vehicles SET status='vendu',updated_at=? WHERE id=? AND lot_id=?", [now, input.vehicleId, lotId])
      if (paid > 0) await tx.run('INSERT INTO payments(id,lot_id,sale_id,amount,method,date,data) VALUES(?,?,?,?,?,?,?)',
        [randomUUID(), lotId, id, paid, input.method || 'espece', now, JSON.stringify({})])

      return { id, ref, invoiceNumber, total, paid, type: input.type || 'vente', date: now, status: paid >= total ? 'payee' : 'partielle' }
    })
  }

  async listPayments(lotId) {
    const rows = await this.sql.all('SELECT * FROM payments WHERE lot_id=? ORDER BY date DESC LIMIT 1000', [lotId])
    return rows.map((r) => ({ id: r.id, lotId: r.lot_id, saleId: r.sale_id, amount: num(r.amount), method: r.method, date: num(r.date) }))
  }

  // -------------------------------- tickets --------------------------------
  async listTickets(lotId, { status } = {}) {
    const params = [lotId], where = ['lot_id=?']
    if (status) { where.push('status=?'); params.push(status) }
    const rows = await this.sql.all(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY entry_at DESC LIMIT 1000`, params)
    return rows.map((r) => ({ ...(r.data || {}), id: r.id, lotId: r.lot_id, ref: r.ref, plate: r.plate, spot: r.spot_code, status: r.status, entryAt: num(r.entry_at), exitAt: num(r.exit_at), amount: num(r.amount) }))
  }

  async openTicket(lotId, input) {
    return this.sql.transaction(async (tx) => {
      const now = Date.now()
      await tx.exec(`SELECT pg_advisory_xact_lock(hashtext('mp_ticket:${lotId.replace(/'/g, "''")}'))`)
      const last = await tx.one('SELECT ref FROM tickets WHERE lot_id=? ORDER BY ref DESC LIMIT 1', [lotId])
      const nextNo = (last ? Number(String(last.ref).replace(/\D/g, '')) : 0) + 1
      const ref = `TCK-${new Date(now).getUTCFullYear()}-${String(nextNo).padStart(4, '0')}`
      const id = input.id || randomUUID()
      await tx.run('INSERT INTO tickets(id,lot_id,ref,plate,spot_code,status,entry_at,exit_at,amount,data) VALUES(?,?,?,?,?,?,?,?,?,?)',
        [id, lotId, ref, String(input.plate || '').toUpperCase(), input.spot || '', 'ouvert', now, 0, 0, JSON.stringify({ currency: input.currency || 'XOF' })])
      return { id, ref, plate: String(input.plate || '').toUpperCase(), spot: input.spot || '', status: 'ouvert', entryAt: now, exitAt: 0, amount: 0 }
    })
  }

  async closeTicket(lotId, id, { amount = 0, method = 'espece' } = {}) {
    return this.sql.transaction(async (tx) => {
      const ticket = await tx.one('SELECT * FROM tickets WHERE id=? AND lot_id=?', [id, lotId])
      if (!ticket) { const e = new Error('Ticket introuvable.'); e.status = 404; throw e }
      if (ticket.status === 'clos') { const e = new Error('Ticket déjà clôturé.'); e.status = 409; throw e }
      const value = Number(amount)
      if (!Number.isFinite(value) || value < 0) { const e = new Error('Montant invalide.'); e.status = 400; throw e }
      await tx.run("UPDATE tickets SET status='clos',exit_at=?,amount=? WHERE id=? AND lot_id=?", [Date.now(), value, id, lotId])
      return { ...ticket, status: 'clos', exitAt: Date.now(), amount: value, method }
    })
  }

  // ------------------------------ statistiques -----------------------------
  async stats(lotId) {
    const sales = await this.sql.one(`SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(paid),0) paid FROM sales WHERE lot_id=?`, [lotId])
    const stock = await this.sql.one(`SELECT COUNT(*) n, COALESCE(SUM(price),0) value FROM vehicles WHERE lot_id=? AND status<>'vendu'`, [lotId])
    const open = await this.sql.one(`SELECT COUNT(*) n FROM tickets WHERE lot_id=? AND status='ouvert'`, [lotId])
    return {
      salesCount: Number(sales.n), revenue: num(sales.total), collected: num(sales.paid),
      stockCount: Number(stock.n), stockValue: num(stock.value), openTickets: Number(open.n),
    }
  }
}
