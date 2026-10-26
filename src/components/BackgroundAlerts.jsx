import { useEffect,useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { applicationTransactions,evaluateBudgets } from '../lib/financeHub'
import { notifyLocal } from '../lib/experience'
import { hasPermission } from '../lib/permissions'
/** In-app observers, not remote server jobs. No alerts while the app is closed. */
export default function BackgroundAlerts({lot,user}) {
 const [tick,setTick]=useState(0)
 useEffect(()=>{const timer=setInterval(()=>setTick(v=>v+1),30000);return()=>clearInterval(timer)},[])
 const canFinance=hasPermission(user,'kpi.read')
 const data=useLiveQuery(async()=>({
  budgets:canFinance?await db.budgets.where('lotId').equals(lot.id).filter(b=>b.userId===user.id).toArray():[],
  app:canFinance?await applicationTransactions(lot.id):[],bank:canFinance?await db.bankTransactions.where('lotId').equals(lot.id).toArray():[],
  tickets:await db.tickets.where('lotId').equals(lot.id).filter(t=>t.status==='ouvert').toArray(),
  audit:(await db.audit.where('lotId').equals(lot.id).filter(a=>a.userId===user.id).sortBy('at')).slice(-30)
 }),[lot.id,user.id,canFinance],null)
 useEffect(()=>{if(!data)return;let active=true;(async()=>{
  if(canFinance){await evaluateBudgets(lot.id,user.id,'application',data.app);await evaluateBudgets(lot.id,user.id,'bank',data.bank)}
  for(const t of data.tickets)if(Date.now()-Date.parse(t.entryAt)>Number(t.maxStayHours||24)*3600000)await notifyLocal({lotId:lot.id,userId:user.id,kind:'anomalie',title:'Durée maximale de stationnement dépassée',body:`Ticket ${t.ref}, zone/place ${t.spotCode}.`,dedupe:`overstay:${t.id}`})
  const key=`auditNotificationCursor:${lot.id}:${user.id}`,old=await db.meta.get(key)
  // First activation establishes a baseline; do not replay historical operations.
  const seen=new Set(old?.value||data.audit.map(a=>a.id))
  if(old)for(const a of data.audit)if(!seen.has(a.id)&&!['ticket-stationnement','sortie-stationnement'].includes(a.action)){await notifyLocal({lotId:lot.id,userId:user.id,kind:'operation',title:'Nouvelle opération enregistrée',body:a.action,dedupe:`audit:${a.id}`});seen.add(a.id)}
  if(active)await db.meta.put({key,value:[...new Set([...seen,...data.audit.map(a=>a.id)])].slice(-200)})
 })().catch(e=>console.warn('alertes locales',e.message));return()=>{active=false}
 },[JSON.stringify(data),tick,lot.id,user.id,canFinance])
 return null
}
