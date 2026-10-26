import { db, authorize } from './db.js'
import { compact } from './plate.js'
import { validateFees, DEFAULT_FEES } from './feeEngine.js'
import { enqueueParking,ticketCloudEnabled } from './parkingSync.js'
export { DEFAULT_FEES }
export async function saveParkingPolicy(lotId, actor, input) {
  const a=await authorize(actor,lotId,'rates.manage'),fees=validateFees(input)
  return db.transaction('rw',db.lots,db.audit,async()=>{
    const old=await db.lots.get(lotId);await db.lots.update(lotId,{parkingPolicy:fees,...fees})
    await db.audit.add({id:crypto.randomUUID(),lotId,userId:a.id,userName:a.name,action:'parking-policy',at:new Date().toISOString(),details:JSON.stringify({before:old.parkingPolicy,after:fees})})
    return fees
  })
}
export async function markLostTicket(ticketId, actor, reason) {
  const before=await db.tickets.get(ticketId);if(!before)throw new Error('Ticket introuvable.')
  const a=await authorize(actor,before.lotId,'parking.override');if(String(reason||'').trim().length<3)throw new Error('Motif obligatoire (3 caractères minimum).')
  return db.transaction('rw',db.tickets,db.audit,db.parkingSyncEvents,db.meta,async()=>{
    const t=await db.tickets.get(ticketId);if(t.status!=='ouvert')throw new Error('Ticket non ouvert.');if(t.lostTicket)throw new Error('Ticket déjà déclaré perdu.')
    const row={...t,syncStatus:ticketCloudEnabled(t.lotId)?'pending':t.syncStatus,lostTicket:true,lostTicketReason:reason,lostTicketAt:new Date().toISOString(),version:(t.version||1)+1}
    await db.tickets.put(row)
    await enqueueParking(db,t.lotId,'lost',{ticketId,expectedVersion:t.version||1,reason})
    await db.audit.add({id:crypto.randomUUID(),lotId:t.lotId,userId:a.id,userName:a.name,action:'ticket-perdu',target:ticketId,at:new Date().toISOString(),details:JSON.stringify({reason,fee:t.lostTicketFee||0})})
    return row
  })
}
export async function correctTicketPlate(ticketId, actor, plate, reason, expectedVersion) {
  const before=await db.tickets.get(ticketId);if(!before)throw new Error('Ticket introuvable.')
  const a=await authorize(actor,before.lotId,'parking.override'),key=compact(plate)
  if(key.length<4 || String(reason||'').trim().length<3)throw new Error('Plaque et motif valides requis.')
  return db.transaction('rw',db.tickets,db.plateCorrections,db.audit,db.parkingSyncEvents,db.meta,async()=>{
    const t=await db.tickets.get(ticketId)
    if(t.status!=='ouvert')throw new Error('Ticket non ouvert.')
    if((t.version||1)!==expectedVersion)throw new Error('Conflit de version : rechargez le ticket avant de corriger.')
    const duplicates=await db.tickets.where('lotId').equals(t.lotId).filter((x)=>x.id!==t.id && x.status==='ouvert' && compact(x.plate)===key).count()
    if(duplicates)throw new Error('Cette plaque possède déjà un ticket ouvert.')
    const at=new Date().toISOString(),version=expectedVersion+1,newPlate=String(plate).trim().toUpperCase()
    await db.tickets.update(ticketId,{plate:newPlate,version,syncStatus:ticketCloudEnabled(t.lotId)?'pending':t.syncStatus})
    const row={id:crypto.randomUUID(),lotId:t.lotId,ticketId,beforePlate:t.plate,afterPlate:newPlate,reason,version,userId:a.id,userName:a.name,at}
    await db.plateCorrections.add(row)
    await enqueueParking(db,t.lotId,'correction',{ticketId,plate:newPlate,reason,expectedVersion})
    await db.audit.add({id:crypto.randomUUID(),lotId:t.lotId,userId:a.id,userName:a.name,action:'ticket-correction-plaque',target:ticketId,at,details:JSON.stringify(row)})
    return row
  })
}
export function dailyParkingReport({day, tickets=[],cashSessions=[],spots=[],at=Date.now()}) {
  // day is a local calendar date; duration billing remains elapsed 24h.
  const start=new Date(`${day}T00:00:00`).getTime(),end=new Date(`${day}T00:00:00`);end.setDate(end.getDate()+1)
  const until=end.getTime();if(!Number.isFinite(start))throw new Error('Date de rapport invalide.')
  const inDay=(v)=>{const t=Date.parse(v);return t>=start && t<until}
  const arrived=tickets.filter((t)=>inDay(t.entryAt)),exited=tickets.filter((t)=>t.status==='cloture' && inDay(t.exitAt))
  const byMethod={},byOperator={}
  for(const t of exited){byMethod[t.paymentMethod||'non renseigné']=(byMethod[t.paymentMethod||'non renseigné']||0)+Number(t.amount||0);const op=t.closedById||t.closedBy||'Inconnu';byOperator[op]=(byOperator[op]||0)+Number(t.amount||0)}
  const hours=Array.from({length:24},(_,h)=>({hour:h,entries:arrived.filter((t)=>new Date(t.entryAt).getHours()===h).length,exits:exited.filter((t)=>new Date(t.exitAt).getHours()===h).length}))
  const sessions=cashSessions.filter((s)=>s.closedAt && inDay(s.closedAt))
  return {day,entries:arrived.length,exits:exited.length,revenue:exited.reduce((n,t)=>n+Number(t.amount||0),0),byMethod,byOperator,hours,
    lostTickets:tickets.filter((t)=>t.lostTicket && inDay(t.lostTicketAt)).length,
    meanStayMinutes:exited.length?Math.round(exited.reduce((n,t)=>n+(Date.parse(t.exitAt)-Date.parse(t.entryAt))/60000,0)/exited.length):0,
    occupiedNow:spots.filter((s)=>s.status==='occupe').length,freeNow:spots.filter((s)=>s.status==='libre').length,
    overstay:tickets.filter((t)=>t.status==='ouvert' && (at-Date.parse(t.entryAt))>Number(t.maxStayHours||24)*3600000).length,
    expectedCash:sessions.reduce((n,s)=>n+Number(s.expected||0),0),countedCash:sessions.reduce((n,s)=>n+Number(s.counted||0),0),variance:sessions.reduce((n,s)=>n+Number(s.variance||0),0),closings:sessions.length,
    pendingClosings:cashSessions.filter((s)=>s.status==='ouverte').length,
    note:'Recettes de stationnement uniquement ; hors ventes automobiles et paiements d’abonnements. Occupation actuelle, pas une moyenne historique.' }
}
