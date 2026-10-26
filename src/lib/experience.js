import { db } from './db.js'
import { setDisplaySettings } from './display.js'
import { DEFAULT_LANG, isSupportedLang, dirFor } from './i18n.js'
import { DEFAULT_CURRENCY, DEFAULT_USD_RATE, normalizeRates, isSupportedCurrency } from './money.js'
export const PALETTE={background:'#0B1220',surface:'#142033',text:'#F1F5F9',muted:'#A8B6CA',primary:'#5EEAD4',secondary:'#60A5FA',warning:'#FBBF24',danger:'#FB7185'}
export const WIDGETS=['occupation','recettes','presence','finance','budgets','ocr']
export const DEFAULT_UI={theme:'dark',contrast:false,textScale:1,reducedMotion:false,widgets:WIDGETS,lang:DEFAULT_LANG,currency:DEFAULT_CURRENCY,usdRate:DEFAULT_USD_RATE}
export function normalizeUI(p={}) {
 const rate=Number(p.usdRate)
 return {theme:p.theme==='light'?'light':'dark',contrast:!!p.contrast,textScale:Math.min(1.5,Math.max(1,Number(p.textScale)||1)),reducedMotion:!!p.reducedMotion,
 widgets:Array.isArray(p.widgets)?[...new Set(p.widgets.filter(v=>WIDGETS.includes(v)))]:[...WIDGETS],
 lang:isSupportedLang(p.lang)?p.lang:DEFAULT_LANG,currency:isSupportedCurrency(p.currency)?p.currency:DEFAULT_CURRENCY,
 usdRate:normalizeRates({USD:Number.isFinite(rate)&&rate>0?rate:DEFAULT_USD_RATE}).USD}
}
export async function saveUI(lotId,userId,patch) {
 const key=`ui:${lotId}:${userId}`,previous=(await db.meta.get(key))?.value||DEFAULT_UI
 const value=normalizeUI({...previous,...patch});await db.meta.put({key,value})
 try{localStorage.setItem('mp.appearance',JSON.stringify(value))}catch{/* Private storage not available */}
 // Les réglages doivent s'appliquer immédiatement, y compris dans les écrans
 // déjà montés : on notifie l'application plutôt que d'attendre un rechargement.
 try{window.dispatchEvent(new CustomEvent('mp-appearance',{detail:value}))}catch{/* SSR/test */ }
 return value
}
export function applyUI(p) {
 const v=normalizeUI(p)
 // Devise et langue alimentent le formatage global (argent.js / i18n.js).
 setDisplaySettings({currency:v.currency,lang:v.lang,usdRate:v.usdRate})
 if(typeof document!=='undefined') {
  const e=document.documentElement
  e.dataset.theme=v.theme;e.dataset.contrast=v.contrast?'high':'normal';e.dataset.motion=v.reducedMotion?'reduced':'normal'
  e.style.setProperty('--text-scale',v.textScale);e.style.colorScheme=v.theme
  // Ar : sens de lecture inversé, annoncé aux lecteurs d'écran et au CSS.
  e.lang=v.lang;e.dir=dirFor(v.lang);e.dataset.lang=v.lang
 }
 return v
}
export function readAppearance(){try{return normalizeUI(JSON.parse(localStorage.getItem('mp.appearance')||'{}'))}catch{return normalizeUI(DEFAULT_UI)}}
export function initializeAppearance(){try{return applyUI(JSON.parse(localStorage.getItem('mp.appearance')||'{}'))}catch{return applyUI(DEFAULT_UI)}}
export function reorderWidgets(list,id,direction){const result=[...list],i=result.indexOf(id),j=i+direction;if(i>=0&&j>=0&&j<result.length)[result[i],result[j]]=[result[j],result[i]];return result}
export async function notifyLocal({lotId,userId,kind='operation',title,body='',dedupe}) {
 const allowedKinds=['validation','budget','anomalie','operation']
 if(!allowedKinds.includes(kind)||!lotId||!userId)throw new Error('Notification invalide.')
 const pref=(await db.meta.get(`notifications:${lotId}:${userId}`))?.value||{}
 if(pref[kind]===false)return null
 const key=dedupe?`${lotId}:${userId}:${dedupe}`:crypto.randomUUID()
 const row={id:key,lotId,userId,kind,title:String(title).slice(0,150),body:String(body).slice(0,500),at:new Date().toISOString(),read:false}
 const created=await db.transaction('rw',db.notifications,async()=>{if(await db.notifications.get(key))return false;await db.notifications.add(row);return true})
 if(!created)return null
 // Local browser notification, NOT a server push. User explicitly opts in.
 if(pref.browser && typeof Notification!=='undefined' && Notification.permission==='granted') {
  const message={body:'Ouvrez MON PARKING pour consulter le détail.',tag:key,data:{url:'./#/experience'}}
  try{if(typeof navigator!=='undefined'&&navigator.serviceWorker?.controller)(await navigator.serviceWorker.ready).showNotification(row.title,message);else new Notification(row.title,message)}catch{/* Inbox remains available */}
 }
 return row
}
export async function saveNotificationPreferences(lotId,userId,patch) {
 const key=`notifications:${lotId}:${userId}`,old=(await db.meta.get(key))?.value||{}
 const value=Object.fromEntries(['validation','budget','anomalie','operation','browser'].map(k=>[k,patch[k]??old[k]??(k!=='browser')]))
 await db.meta.put({key,value});return value
}
export async function requestLocalNotifications(){if(typeof Notification==='undefined')throw new Error('Notifications non prises en charge.');return Notification.requestPermission()}
export function ocrZoneStats(rows) {
 const groups=new Map()
 for(const r of rows){const key=`${r.city||'Ville non renseignée'} · ${r.zone||'Zone non renseignée'}`;const g=groups.get(key)||{label:key,total:0,unchanged:0,corrected:0,lowConfidence:0};g.total++;if(r.unchanged)g.unchanged++;else g.corrected++;if(Number(r.confidence)<40)g.lowConfidence++;groups.set(key,g)}
 return [...groups.values()].map(g=>({...g,rate:g.total?Math.round(g.unchanged/g.total*1000)/10:0}))
}
export async function recordOcrValidation({lotId,userId,city='',zone='',raw,proposed,chosen,confidence}) {
 const compact=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')
 const row={id:crypto.randomUUID(),lotId,userId,city,zone,raw:String(raw||'').slice(0,120),proposed,chosen,confidence:Number(confidence)||0,unchanged:compact(proposed)===compact(chosen),at:new Date().toISOString()}
 if(!lotId||!chosen||!raw)return null
 await db.ocrObservations.add(row)
 if(row.confidence<40)await notifyLocal({lotId,userId,kind:'anomalie',title:'Lecture OCR à vérifier',body:`Confiance faible en zone ${zone||'non renseignée'}.`,dedupe:`ocr:${row.id}`})
 return row
}
