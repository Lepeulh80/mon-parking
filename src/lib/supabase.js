import { createClient } from '@supabase/supabase-js'
import { db } from './db.js'

const KEY = 'mp_supabase'
const env = import.meta.env || {}
const envConfig = () => env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY
  ? { url: env.VITE_SUPABASE_URL, anonKey: env.VITE_SUPABASE_ANON_KEY,
      ocrLotId: env.VITE_SUPABASE_OCR_LOT_ID || '' } : null

/* Remarque : la clé « anon » est publique par conception ; la sécurité repose
   sur les politiques Row Level Security du schéma fourni (supabase_schema.sql). */
export function getConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? JSON.parse(raw) : envConfig()
  } catch {
    return envConfig()
  }
}

export function setConfig(cfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg))
  // client() invalidates only if URL or key actually changes.
}

export function clearConfig() {
  localStorage.removeItem(KEY)
  cached = null
}

export const isConfigured = () => {
  const c = getConfig()
  return !!(c?.url && c?.anonKey)
}

let cached = null
let cachedKey = ''
export function client() {
  const c = getConfig()
  if (!c?.url || !c?.anonKey) return null
  const k = c.url + '|' + c.anonKey
  if (cached && cachedKey === k) return cached
  try {
    cached = createClient(c.url, c.anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
    cachedKey = k
    return cached
  } catch {
    return null
  }
}

/* ---------------- mapping camelCase <-> snake_case ---------------- */
const toSnake = (s) => s.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase())
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())

const convert = (obj, fn) => {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    out[fn(k)] = v
  }
  return out
}

export const TABLES = {
  lots: 'lots',
  vehicles: 'vehicles',
  clients: 'clients',
  sales: 'sales',
  payments: 'payments',
  expenses: 'expenses',
  stockMoves: 'stock_moves',
  audit: 'audit_log',
  spots: 'spots',
  tickets: 'tickets',
  reservations: 'reservations',
}

const SYNC_ORDER = ['lots', 'vehicles', 'clients', 'sales', 'payments', 'expenses', 'stockMoves', 'spots', 'tickets', 'reservations', 'audit']

const CHUNK = 150

export async function testConnection(url, anonKey) {
  if (!url || !anonKey) return { ok: false, error: 'URL et clé requises.' }
  try {
    const probe = createClient(url, anonKey)
    const { error } = await probe.from('lots').select('id').limit(1)
    if (error) {
      if (/does not exist|relation|schema/i.test(error.message)) {
        return { ok: false, error: 'Connexion établie, mais le schéma n’est pas installé. Exécutez supabase_schema.sql dans le SQL Editor.' }
      }
      return { ok: false, error: error.message }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message || 'Connexion impossible.' }
  }
}

export async function pushAll(lotId, onProgress) {
  const sb = client()
  if (!sb) throw new Error('Synchronisation non configurée.')
  const result = {}
  for (const localName of SYNC_ORDER) {
    const table = TABLES[localName]
    if (getConfig()?.ticketCloudLots?.[lotId] && ['tickets','spots'].includes(localName)) { result[table]=0; continue } // Dedicated v9 transactional RPCs own these records.
    const all = await db.table(localName === 'audit' ? 'audit' : localName).toArray()
    const rows = all
      .filter((r) => (localName === 'lots' ? r.id === lotId : r.lotId === lotId))
      .map((r) => {
        const clean = { ...r }
        delete clean.pinHash
        delete clean.salt
        return convert(clean, toSnake)
      })
    if (!rows.length) { result[table] = 0; continue }
    let sent = 0
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK)
      const { error } = await sb.from(table).upsert(slice, { onConflict: 'id' })
      if (error) throw new Error(`${table} : ${error.message}`)
      sent += slice.length
    }
    result[table] = sent
    onProgress?.({ table, count: sent })
  }
  await db.meta.put({ key: 'lastSync', value: { at: new Date().toISOString(), direction: 'push', result } })
  return result
}

export async function pullAll(lotId, onProgress) {
  const sb = client()
  if (!sb) throw new Error('Synchronisation non configurée.')
  const result = {}
  for (const localName of SYNC_ORDER) {
    const table = TABLES[localName]
    if (getConfig()?.ticketCloudLots?.[lotId] && ['tickets','spots'].includes(localName)) { result[table]=0; continue } // Dedicated v9 transactional RPCs own these records.
    const query = sb.from(table).select('*')
    const { data, error } = localName === 'lots'
      ? await query.eq('id', lotId)
      : await query.eq('lot_id', lotId).limit(5000)
    if (error) throw new Error(`${table} : ${error.message}`)
    const rows = (data || []).map((r) => convert(r, toCamel))
    if (rows.length) {
      await db.table(localName === 'audit' ? 'audit' : localName).bulkPut(rows)
    }
    result[table] = rows.length
    onProgress?.({ table, count: rows.length })
  }
  await db.meta.put({ key: 'lastSync', value: { at: new Date().toISOString(), direction: 'pull', result } })
  return result
}

let channel = null
export function subscribe(lotId, onChange) {
  const sb = client()
  if (!sb) return () => {}
  if (channel) { sb.removeChannel(channel); channel = null }
  const tables = ['vehicles', 'sales', 'payments', 'expenses', 'clients', 'spots', 'tickets', 'reservations']
  channel = sb.channel(`lot-${lotId}`)
  for (const t of tables) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `lot_id=eq.${lotId}` }, (payload) => {
      onChange?.({ table: t, event: payload.eventType })
    })
  }
  channel.subscribe()
  return () => { if (channel) { sb.removeChannel(channel); channel = null } }
}

export async function getLastSync() {
  const row = await db.meta.get('lastSync')
  return row?.value || null
}
