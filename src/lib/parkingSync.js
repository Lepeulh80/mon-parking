/** v9: opt-in transactional ticket replication, separate from v7 OCR learning.
 * Local writes remain provisional until the server acknowledges their event.
 * A rejected event stays visible as a conflict; it is NEVER silently dropped.
 */
import { db } from './db.js'
import { client, getConfig } from './supabase.js'
import { cloudLotId, getPosteId } from './ocrSync.js'
export const ticketCloudEnabled = (lotId) => !!getConfig()?.ticketCloudLots?.[lotId]
const scope = (lotId) => `${getConfig()?.url || 'local'}:${cloudLotId(lotId)}`
export async function enqueueParking(database, lotId, kind, payload) {
  if (!ticketCloudEnabled(lotId)) return null
  const seqKey=`parkingSeq:${lotId}`;const sequence=Number((await database.meta.get(seqKey))?.value||0)+1;await database.meta.put({key:seqKey,value:sequence})
  const event = { sequence, id: crypto.randomUUID(), lotId, kind, payload, posteId: getPosteId(), scope: scope(lotId), status: 'pending', createdAt: new Date().toISOString() }
  await database.parkingSyncEvents.add(event)
  return event.id
}
export async function configureParkingCloud(lotId, fees, { sb } = {}) {
  const c = sb || client(); if (!c) throw new Error('Supabase non configuré.')
  const { data: auth } = await c.auth.getSession(); if (!auth?.session) throw new Error('Session Supabase requise.')
  const legacyOpen=await db.tickets.where('lotId').equals(lotId).filter(t=>t.status==='ouvert' && !['pending','confirmed','conflict'].includes(t.syncStatus)).count()
  const legacyCash=await db.cashSessions.where('lotId').equals(lotId).filter(s=>s.status==='ouverte'&&!s.cloudMode).count()
  if(legacyCash)throw new Error('Clôturez la caisse locale avant la bascule cloud.')
  if(legacyOpen)throw new Error('Clôturez les tickets locaux historiques avant d’activer le cloud transactionnel.')
  const slots = await db.spots.where('lotId').equals(lotId).toArray()
  const rates = await db.ratePlans.where('lotId').equals(lotId).toArray()
  const passes = await db.parkingPasses.where('lotId').equals(lotId).toArray()
  const { error } = await c.rpc('pro_configure', { p_lot: cloudLotId(lotId), p_fees: fees, p_slots: slots, p_rates: rates, p_passes: passes })
  if (error) throw new Error(error.message)
}
function mapTicket(remote, lotId, spots) {
  const spot = spots.find((s) => s.code === remote.spotCode)
  return { ...remote, lotId, spotId: spot?.id || null, syncStatus: 'confirmed', cloudConfirmed: true }
}
export async function syncParking(lotId, { sb } = {}) {
  if (!ticketCloudEnabled(lotId) && !sb) return { mode:'local', pushed:0, conflicts:0 }
  const c = sb || client(); if (!c) return { mode:'local',pushed:0,conflicts:0 }
  try {
    const { data: auth, error: authError } = await c.auth.getSession()
    if (authError || !auth?.session) throw new Error('Session Supabase requise pour partager les tickets.')
    const spots = await db.spots.where('lotId').equals(lotId).toArray()
    const events = await db.parkingSyncEvents.where('lotId').equals(lotId).filter((e) => e.status === 'pending' && e.scope === scope(lotId)).sortBy('sequence')
    let pushed=0, conflicts=0
    const blocked = new Set()
    for (const e of events) {
      const target=e.payload.ticketId || e.payload.id || e.payload.sessionId
      if (blocked.has(target)) continue
      if(e.kind==='cash_close' && (await db.parkingSyncEvents.where('lotId').equals(lotId).filter(x=>x.id!==e.id && ['pending','conflict'].includes(x.status) && ['entry','exit','lost','correction'].includes(x.kind)).count())) continue
      const { data, error } = await c.rpc('pro_apply_event', { p_lot: cloudLotId(lotId), p_event: { id:e.id,kind:e.kind,payload:e.payload,posteId:e.posteId } })
      if (error) {
        // Business failures need operator review; transport/5xx errors retry later.
        if (/VERSION_CONFLICT|UNAVAILABLE|NOT_OPEN|FORBIDDEN|INVALID_|ADJUSTMENT_|REASON_REQUIRED|CONFIGURATION_REQUIRED|23505|duplicate key|CASH_SESSION_REQUIRED/i.test(`${error.code} ${error.message}`)) {
          if(e.kind==='exit') await db.cashMovements.where('source').equals(`${lotId}:ticket:${e.payload.ticketId}`).modify({pendingCloud:false,cloudRejected:true})
        await db.parkingSyncEvents.update(e.id,{status:'conflict',error:error.message}); conflicts++; blocked.add(target)
          if(e.payload.ticketId || e.kind==='entry') await db.tickets.update(e.payload.ticketId || e.payload.id,{syncStatus:'conflict'})
          continue
        }
        throw new Error(error.message)
      }
      await db.transaction('rw',db.parkingSyncEvents,db.tickets,db.cashSessions,db.cashMovements,async()=>{
        await db.parkingSyncEvents.update(e.id,{status:'ack',ackAt:new Date().toISOString(),error:null})
        // Do not overwrite later optimistic edits until every event is acknowledged.
        const newer=await db.parkingSyncEvents.where('lotId').equals(lotId).filter((x)=>x.status==='pending' && x.id!==e.id && (x.payload.ticketId || x.payload.id || x.payload.sessionId)===target).count()
        if(data?.ticket && !newer) {const old=await db.tickets.get(data.ticket.id);if(!old || (old.version||1)<=data.ticket.version)await db.tickets.put(mapTicket(data.ticket,lotId,spots))}
        if(data?.cash && !newer) { const old=await db.cashSessions.get(data.cash.id); await db.cashSessions.put({...old,...data.cash,lotId,cloudOperatorId:data.cash.userId,userId:old?.userId || data.cash.userId,cloudMode:true,cloudExpected:data.cash.expected,cloudConfirmed:true}) }
      })
      pushed++
    }
    const {data:snapshot,error}=await c.rpc('pro_snapshot',{p_lot:cloudLotId(lotId)})
    if(error) throw new Error(error.message)
    await db.transaction('rw',db.tickets,db.spots,db.plateCorrections,db.cashSessions,db.cashMovements,db.parkingSyncEvents,db.meta,async()=>{
      const snapshotKey=`parkingSnapshot:${lotId}:${scope(lotId)}`;const last=(await db.meta.get(snapshotKey))?.value
      if(last && snapshot.serverAt && snapshot.serverAt<last)return
      if(snapshot.serverAt)await db.meta.put({key:snapshotKey,value:snapshot.serverAt})
      const outstanding=await db.parkingSyncEvents.where('lotId').equals(lotId).filter((e)=>['pending','conflict'].includes(e.status) && (!e.scope || e.scope===scope(lotId))).toArray()
      const pendingIds=new Set(outstanding.map((e)=>e.payload.ticketId || e.payload.id))
      const localTickets=await db.tickets.where('lotId').equals(lotId).toArray()
      const affectedCodes=new Set(outstanding.map(e=>e.payload.spotCode || localTickets.find(t=>t.id===e.payload.ticketId)?.spotCode).filter(Boolean))
      for(const t of snapshot.tickets || []) if(!pendingIds.has(t.id)) {const old=await db.tickets.get(t.id);if(!old || (old.version||1)<=t.version)await db.tickets.put(mapTicket(t,lotId,spots))}
      for(const s of snapshot.slots || []) {
        const local=spots.find((x)=>x.code===s.code)
        if(local && !affectedCodes.has(s.code)) {
          const open=(snapshot.tickets || []).find((t)=>t.spotCode===s.code && t.status==='ouvert')
          await db.spots.update(local.id,{status:s.status,currentTicketId:open?.id || null})
        }
      }
      for(const corr of snapshot.corrections || []) await db.plateCorrections.put({id:corr.id,lotId,ticketId:corr.ticket_id,beforePlate:corr.before_plate,afterPlate:corr.after_plate,reason:corr.reason,version:corr.version,userId:corr.actor_id,at:corr.at,cloudConfirmed:true})
      // Receipt acknowledgement and expected-cash snapshot are committed together.
      // Clearing pendingCloud before this snapshot would undercount after a
      // network failure; never clearing it would double-count after a success.
      const cashIds=new Set((snapshot.cash||[]).map(c=>c.id))
      for(const ticket of snapshot.tickets||[])if(ticket.status==='cloture'&&!pendingIds.has(ticket.id)) {
        await db.cashMovements.where('source').equals(`${lotId}:ticket:${ticket.id}`).filter(m=>cashIds.has(m.sessionId)).modify({pendingCloud:false,cloudRejected:false})
      }
      for(const cash of snapshot.cash || []) {
        const pending=outstanding.some((e)=>e.payload.sessionId===cash.id || (e.kind==='cash_open' && e.payload.id===cash.id))
        if(!pending) {const old=await db.cashSessions.get(cash.id);await db.cashSessions.put({...old,...cash,lotId,userId:old?.userId || cash.userId,cloudMode:true,cloudExpected:cash.expected,cloudOperatorId:cash.userId,cloudConfirmed:true})}
      }
    })
    const value={mode:'cloud',pushed,conflicts,at:new Date().toISOString(),error:null}
    await db.meta.put({key:`parkingCloud:${lotId}`,value});return value
  } catch(e) {
    const value={mode:'error',error:e.message,at:new Date().toISOString()};await db.meta.put({key:`parkingCloud:${lotId}`,value});return value
  }
}
const running=new Map()
export function startParkingSync(lotId) {
  if(typeof window==='undefined') return ()=>{}
  let job=running.get(lotId)
  if(!job) {
    job={refs:0,busy:false};job.tick=async()=>{if(job.busy || navigator.onLine===false || !ticketCloudEnabled(lotId))return;job.busy=true;try{await syncParking(lotId)}finally{job.busy=false}}
    job.timer=setInterval(job.tick,15000);window.addEventListener('online',job.tick);window.addEventListener('focus',job.tick);running.set(lotId,job);void job.tick()
  }
  job.refs++;return()=>{if(--job.refs>0)return;clearInterval(job.timer);window.removeEventListener('online',job.tick);window.removeEventListener('focus',job.tick);running.delete(lotId)}
}
export async function reviewSyncConflict(eventId, actor, action) {
  const e=await db.parkingSyncEvents.get(eventId);if(!e || e.status!=='conflict') throw new Error('Conflit introuvable.')
  const current=await db.users.get(actor.id);if(!current?.active || current.lotId!==e.lotId || !['admin','responsable'].includes(current.role))throw new Error('Responsable requis.')
  if(action!=='retry')throw new Error('Action invalide : corrigez la cause puis réessayez, ou conservez le conflit pour audit.')
  await db.parkingSyncEvents.update(eventId,{status:'pending',error:null})
  await db.audit.add({id:crypto.randomUUID(),lotId:e.lotId,userId:current.id,userName:current.name,action:'sync-retry',at:new Date().toISOString(),target:eventId,details:'Nouvelle tentative explicitement demandée.'})
}

export async function acceptServerPlate(eventId, actor, {sb}={}) {
 const e=await db.parkingSyncEvents.get(eventId)
 if(!e || e.status!=='conflict' || !['correction','lost'].includes(e.kind))throw new Error('Seuls les conflits de correction/perte peuvent être remplacés par la version serveur.')
 const u=await db.users.get(actor.id);if(!u?.active||u.lotId!==e.lotId||!['admin','responsable'].includes(u.role))throw new Error('Responsable requis.')
 const c=sb||client();if(!c)throw new Error('Connexion cloud requise.')
 const {data,error}=await c.rpc('pro_snapshot',{p_lot:cloudLotId(e.lotId)});if(error)throw new Error(error.message)
 const remote=(data.tickets||[]).find(t=>t.id===e.payload.ticketId);if(!remote)throw new Error('Ticket serveur introuvable.')
 const spots=await db.spots.where('lotId').equals(e.lotId).toArray()
 await db.transaction('rw',db.tickets,db.parkingSyncEvents,db.plateCorrections,db.audit,async()=>{
   await db.tickets.put(mapTicket(remote,e.lotId,spots))
   await db.parkingSyncEvents.update(e.id,{status:'resolved',resolution:'accepted-server',resolvedBy:u.id,resolvedAt:new Date().toISOString()})
   await db.plateCorrections.where('ticketId').equals(remote.id).filter(x=>!x.cloudConfirmed && x.version===(e.payload.expectedVersion+1)).modify({remoteRejected:true})
   await db.audit.add({id:crypto.randomUUID(),lotId:e.lotId,userId:u.id,userName:u.name,action:'plate-conflict-resolved',target:remote.id,at:new Date().toISOString(),details:JSON.stringify({eventId,choice:'server',serverVersion:remote.version})})
 })
}
