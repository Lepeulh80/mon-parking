import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../lib/db'
import { applyUI, DEFAULT_UI, saveUI } from '../lib/experience'
export default function ExperienceBar({lot,user}) {
 const prefs=useLiveQuery(()=>db.meta.get(`ui:${lot.id}:${user.id}`),[lot.id,user.id],null)
 useEffect(()=>{applyUI(prefs?.value||DEFAULT_UI)},[prefs?.value])
 const value=prefs?.value||DEFAULT_UI
 return <div className="experience-toolbar" aria-label="Affichage et accessibilité">
  <button className="btn btn-sm btn-ghost" aria-pressed={value.theme==='light'} title="Basculer entre thème sombre et clair" onClick={()=>saveUI(lot.id,user.id,{theme:value.theme==='dark'?'light':'dark'})}>{value.theme==='dark'?'☀ Clair':'☾ Sombre'}</button>
  <a className="btn btn-sm btn-ghost" href="#/experience" aria-label="Ouvrir accessibilité, sécurité et notifications">Accessibilité & réglages</a>
 </div>
}
