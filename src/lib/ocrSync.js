/** Offline-first OCR replication. Immutable events; local outbox in Dexie.
 * Public key + authenticated active parking membership, never service_role.
 * The server assigns created_at; UUIDs make retries idempotent.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db, nowIso } from './db.js'
import { client, getConfig, isConfigured } from './supabase.js'
import { aggregate } from './learning.js'

export const REMOTE_TABLE = 'ocr_feedback'
const PAGE = 500
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let memPoste
export function getPosteId() {
  try {
    let p = localStorage.getItem('mp.poste')
    if (!p) { p = `poste_${newUuid()}`; localStorage.setItem('mp.poste', p) }
    return p
  } catch { return memPoste ||= `poste_${newUuid()}` }
}
export function setPosteId(id) {
  memPoste = String(id)
  try { localStorage.setItem('mp.poste', memPoste) } catch { /* Node / private storage */ }
  return memPoste
}
export function newUuid() { return globalThis.crypto.randomUUID() }
// Stable compatibility UUID for v6 records with prefixed local ids.
export function stableUuid(seed) {
  const hashes = [2166136261, 2654435761, 2246822519, 3266489917]
  for (const c of String(seed)) for (let i = 0; i < 4; i++) hashes[i] = Math.imul(hashes[i] ^ c.charCodeAt(0), 16777619 + i * 2) >>> 0
  const h = hashes.map((x) => x.toString(16).padStart(8, '0')).join('')
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20)}`
}
export const uuidOf = (row) => row.uuid || (UUID.test(row.id) ? row.id : stableUuid(`ocrfb:${row.lotId}:${row.id}`))
export const cloudLotId = (lotId) => getConfig()?.ocrLotIds?.[lotId] || getConfig()?.ocrLotId || lotId
const scope = (lotId) => `${getConfig()?.url || 'local'}:${cloudLotId(lotId)}`
const stateKey = (lotId) => `ocrSync:${lotId}:${scope(lotId)}`
const mutedKey = (lotId) => `ocrMuted:${lotId}`
const locks = new Map()
export function withFeedbackLock(lotId, fn) {
  const p = (locks.get(lotId) || Promise.resolve()).catch(() => {}).then(fn)
  locks.set(lotId, p)
  return p.finally(() => { if (locks.get(lotId) === p) locks.delete(lotId) })
}
async function ready(c, lotId) {
  if (!UUID.test(cloudLotId(lotId))) throw new Error('Renseignez le UUID lots.id distant dans Apprentissage OCR.')
  const { data, error } = await c.auth.getSession()
  if (error) throw error
  if (!data?.session) throw new Error('Session Supabase requise : connectez ce poste avec un membre du parking.')
}
export function toRemote(e, posteId) {
  return { id: uuidOf(e), lot_id: cloudLotId(e.lotId), poste_id: e.posteId || posteId || getPosteId(),
    at: e.at, user_id: e.userId ? String(e.userId) : null, user_name: e.userName || '',
    raw: e.raw || '', raw_compact: e.rawCompact || '', chosen: e.chosen,
    chosen_compact: e.chosenCompact || '', rejected: e.rejected || [], source: e.source || 'suggestion', pairs: e.pairs || [] }
}
export function fromRemote(r, localLotId = r.lot_id) {
  return { id: r.id, uuid: r.id, lotId: localLotId, posteId: r.poste_id,
    at: r.at, createdAt: r.created_at, userId: r.user_id, userName: r.user_name || '',
    raw: r.raw || '', rawCompact: r.raw_compact || '', chosen: r.chosen,
    chosenCompact: r.chosen_compact || '', rejected: r.rejected || [],
    source: r.source || 'suggestion', pairs: r.pairs || [], synced: 1, remote: 1, syncedAt: r.created_at }
}
async function readState(lotId) { return (await db.meta.get(stateKey(lotId)))?.value || null }
async function saveState(lotId, patch) {
  const value = { ...(await readState(lotId)), ...patch, posteId: getPosteId(), updatedAt: nowIso() }
  await db.meta.put({ key: stateKey(lotId), value }); return value
}
export const getSyncState = readState
export async function pendingFeedback(lotId, limit = Infinity) {
  if (!lotId) return []
  // Also catches pre-v7/imported records without a synced field.
  return db.ocrFeedback.where('lotId').equals(lotId).filter((r) => r.synced !== 1).limit(limit).toArray()
}
export const countPending = async (lotId) => (await pendingFeedback(lotId)).length

export function pushOutbox(lotId, { sb, limit = Infinity } = {}) {
  return withFeedbackLock(lotId, async () => {
    const c = sb ?? client()
    if (!c) return { mode: 'local', pushed: 0 }
    await ready(c, lotId)
    const rows = await pendingFeedback(lotId, limit)
    let pushed = 0
    for (let i = 0; i < rows.length; i += 150) {
      const batch = rows.slice(i, i + 150)
      const { error } = await c.from(REMOTE_TABLE).upsert(batch.map((r) => toRemote(r)), { onConflict: 'id', ignoreDuplicates: true })
      if (error) throw new Error(`ocr_feedback (envoi) : ${error.message}`)
      // Only update sync metadata; do not restore records deleted meanwhile.
      await db.transaction('rw', db.ocrFeedback, async () => {
        for (const r of batch) await db.ocrFeedback.update(r.id, { uuid: uuidOf(r), synced: 1, syncedAt: nowIso() })
      })
      pushed += batch.length
    }
    return { mode: 'cloud', pushed }
  })
}
export function pullRemote(lotId, { sb, since } = {}) {
  return withFeedbackLock(lotId, async () => {
    const c = sb ?? client()
    if (!c) return { mode: 'local', pulled: 0, duplicates: 0 }
    await ready(c, lotId)
    const state = await readState(lotId)
    const watermark = since === undefined ? state?.lastPullAt || null : since
    // A short overlap protects delayed commits; UUID merge removes overlap.
    const from = watermark ? new Date(Date.parse(watermark) - 60000).toISOString() : null
    const muted = new Set((await db.meta.get(mutedKey(lotId)))?.value || [])
    const existing = await db.ocrFeedback.where('lotId').equals(lotId).toArray()
    const known = new Set(existing.map(uuidOf))
    let pulled = 0, duplicates = 0, offset = 0, lastPullAt = watermark
    while (true) {
      let q = c.from(REMOTE_TABLE).select('*').eq('lot_id', cloudLotId(lotId))
      if (from) q = q.gte('created_at', from)
      const { data, error } = await q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + PAGE - 1)
      if (error) throw new Error(`ocr_feedback (réception) : ${error.message}`)
      const rows = data || [], incoming = []
      for (const r of rows) {
        // Defense in depth: do not trust an unfiltered payload.
        if (r.lot_id !== cloudLotId(lotId)) continue
        if (muted.has(r.id) || known.has(r.id)) { duplicates++; continue }
        known.add(r.id); incoming.push(fromRemote(r, lotId))
      }
      if (incoming.length) await db.ocrFeedback.bulkPut(incoming)
      pulled += incoming.length
      if (rows.length) lastPullAt = rows[rows.length - 1].created_at
      if (rows.length < PAGE) break
      offset += PAGE
    }
    // Never advance the cursor if any page failed.
    await saveState(lotId, { lastPullAt })
    return { mode: 'cloud', pulled, duplicates, lastPullAt }
  })
}
export async function mergedLearning(lotId) {
  const rows = lotId ? await db.ocrFeedback.where('lotId').equals(lotId).toArray() : []
  const unique = [...new Map(rows.map((r) => [uuidOf(r), r])).values()]
  return { ...aggregate(unique), rows: unique.length }
}
export async function syncFeedback(lotId, { sb } = {}) {
  if (!lotId) return { mode: 'local', pulled: 0, pushed: 0 }
  const c = sb ?? client()
  if (!c) {
    await saveState(lotId, { mode: 'local', error: null })
    return { mode: 'local', pulled: 0, pushed: 0, counts: (await mergedLearning(lotId)).counts }
  }
  try {
    // Send before pull: old legacy ids are acknowledged before the echo arrives.
    const push = await pushOutbox(lotId, { sb: c })
    const pull = await pullRemote(lotId, { sb: c })
    const merged = await mergedLearning(lotId)
    await saveState(lotId, { mode: 'cloud', error: null, lastSyncAt: nowIso(), pulled: pull.pulled, pushed: push.pushed })
    return { mode: 'cloud', pulled: pull.pulled, pushed: push.pushed, counts: merged.counts }
  } catch (e) {
    await saveState(lotId, { mode: 'error', error: e.message, lastErrorAt: nowIso() })
    return { mode: 'error', error: e.message, pulled: 0, pushed: 0 }
  }
}
export async function flushOutbox(lotId) { return syncFeedback(lotId) }
export async function muteRemote(lotId, ids = []) {
  const prev = (await db.meta.get(mutedKey(lotId)))?.value || []
  await db.meta.put({ key: mutedKey(lotId), value: [...new Set([...prev, ...ids])] })
}
// Reference-counted polling: automatic on all parking stations, no duplicate timers.
const watchers = new Map()
export function startOcrSync(lotId) {
  if (!lotId || typeof window === 'undefined') return () => {}
  let w = watchers.get(lotId)
  if (!w) {
    w = { refs: 0, running: false }
    w.tick = async () => {
      if (w.running || navigator.onLine === false) return
      w.running = true
      try { await syncFeedback(lotId) } catch (e) { console.warn('OCR sync', e.message) }
      finally { w.running = false }
    }
    w.timer = setInterval(w.tick, 20000)
    window.addEventListener('online', w.tick)
    window.addEventListener('focus', w.tick)
    watchers.set(lotId, w); void w.tick()
  }
  w.refs++
  return () => {
    if (--w.refs > 0) return
    clearInterval(w.timer); window.removeEventListener('online', w.tick); window.removeEventListener('focus', w.tick)
    watchers.delete(lotId)
  }
}
export function useOcrSync(lotId) {
  const pendingCount = useLiveQuery(() => countPending(lotId), [lotId], 0)
  const state = useLiveQuery(() => lotId ? readState(lotId) : null, [lotId], null)
  return { pendingCount: pendingCount || 0, state, posteId: getPosteId(), configured: isConfigured() }
}
