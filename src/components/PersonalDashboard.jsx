import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { motion, useReducedMotion } from 'framer-motion'
import { db } from '../lib/db'
import { Card, CardHead } from './UI'
import { DEFAULT_UI,saveUI,reorderWidgets } from '../lib/experience'
import { applicationTransactions,monthlyFinance,budgetProgress } from '../lib/financeHub'
import { hasPermission } from '../lib/permissions'
import { fmtMoney } from '../lib/format'
import InteractiveTrend from './InteractiveTrend'
const names={occupation:'Occupation en direct local',recettes:'Recettes stationnement',presence:'Présence de l’équipe',finance:'Dépenses et flux net mensuels',budgets:'Mes budgets',ocr:'Qualité des lectures OCR'}
export default function PersonalDashboard({lot,user}) {
 const [customize,setCustomize]=useState(false),systemReduced=useReducedMotion(),finance=hasPermission(user,'kpi.read')
 const data=useLiveQuery(async()=>({pref:(await db.meta.get(`ui:${lot.id}:${user.id}`))?.value||DEFAULT_UI,
  spots:await db.spots.where('lotId').equals(lot.id).toArray(),tickets:await db.tickets.where('lotId').equals(lot.id).toArray(),attendance:await db.attendance.where('lotId').equals(lot.id).toArray(),
  finance:finance?await applicationTransactions(lot.id):[],budgets:finance?await db.budgets.where('lotId').equals(lot.id).filter(b=>b.userId===user.id&&b.scope==='application').toArray():[],ocr:finance?await db.ocrObservations.where('lotId').equals(lot.id).toArray():[]
 }),[lot.id,user.id,finance],null)
 if(!data)return <div role="status">Chargement des widgets…</div>
 const allowed=Object.keys(names).filter(k=>finance||['occupation','presence'].includes(k)),widgets=data.pref.widgets.filter(k=>allowed.includes(k)),reduce=data.pref.reducedMotion||systemReduced
 const occupied=data.spots.filter(s=>s.status==='occupe').length,total=data.spots.filter(s=>s.status!=='hs').length
 const update=widgets=>saveUI(lot.id,user.id,{widgets})
 const money=n=>fmtMoney(n,lot.currency),months=monthlyFinance(data.finance)
 const content={occupation:<><b className="personal-number">{total?Math.round(occupied/total*100):0} %</b><p className="tiny mut">{occupied} occupées / {total} places utilisables · {data.spots.filter(s=>s.status==='libre').length} libres</p></>,
 recettes:<><b className="personal-number">{money(data.tickets.filter(t=>t.status==='cloture').reduce((n,t)=>n+Number(t.amount||0),0))}</b><p className="tiny mut">Tous les tickets clôturés disponibles sur ce poste, pas un solde bancaire.</p></>,
 presence:<><b className="personal-number">{data.attendance.filter(a=>!a.outAt).length}</b><p className="tiny mut">Pointages actuellement ouverts.</p></>,
 finance:<InteractiveTrend rows={months} label="Évolution mensuelle des dépenses et du flux net déclaré" format={money}/>,
 budgets:<>{data.budgets.length?data.budgets.map(b=>{const p=budgetProgress(b,data.finance);return <p className="tiny" key={b.id}>{b.month} · {b.category} : {money(p.spent)} / {money(b.limit)} ({p.percent} %) {p.exceeded?'— Budget atteint':''}</p>}):<p className="tiny mut">Définissez vos budgets dans Expérience & finances.</p>}</>,
 ocr:<>{data.ocr.length?<><b className="personal-number">{data.ocr.filter(r=>r.unchanged).length} / {data.ocr.length}</b><p className="tiny mut">Lectures validées sans correction dans l’échantillon observé.</p></>:<p className="tiny mut">Aucune observation OCR validée avec la v10.</p>}</>}
 return <section aria-label="Tableau de bord personnalisable"><div className="row" style={{justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:12}}><h2 style={{fontSize:18}}>Mon espace de pilotage</h2><button className="btn btn-ghost btn-sm" data-testid="customize-dashboard" aria-expanded={customize} onClick={()=>setCustomize(v=>!v)}>Personnaliser les widgets</button></div>
 {customize&&<Card style={{marginBottom:14}}><p className="tiny mut">Préférences propres à votre compte et parking. Réordonnancement au clavier, sans glisser-déposer obligatoire.</p><div className="widget-tools">{allowed.map(k=><label key={k}><input type="checkbox" checked={widgets.includes(k)} onChange={e=>update(e.target.checked?[...data.pref.widgets,k]:data.pref.widgets.filter(w=>w!==k))}/> {names[k]} </label>)}</div><a href="#/experience">Synchronisation des préférences, accessibilité et sécurité</a></Card>}
 <div className="personal-grid">{widgets.map((k,i)=><motion.div layout={!reduce} initial={false} transition={reduce?{duration:0}:{duration:.18}} key={k}><Card style={{height:'100%'}}><CardHead title={names[k]} right={customize&&<div className="widget-tools"><button className="btn btn-ghost btn-sm" aria-label={`Monter ${names[k]}`} disabled={i===0} onClick={()=>update(reorderWidgets(widgets,k,-1))}>↑</button><button className="btn btn-ghost btn-sm" aria-label={`Descendre ${names[k]}`} disabled={i===widgets.length-1} onClick={()=>update(reorderWidgets(widgets,k,1))}>↓</button></div>}/>{content[k]}</Card></motion.div>)}</div>
 <p className="tiny mut">Mise à jour immédiate des données locales IndexedDB. Les tickets cloud se mettent à jour à la cadence de synchronisation configurée (15 s), pas par une promesse de temps réel sans latence.</p></section>
}
