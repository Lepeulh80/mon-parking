import { useId, useState } from 'react'
/** Interactive SVG with keyboard/touch hit targets and an equivalent data table. */
export default function InteractiveTrend({rows,label,fields=[{key:'expenses',name:'Dépenses',color:'#60A5FA'},{key:'savings',name:'Flux net',color:'#5EEAD4'}],format=(n)=>String(n)}) {
 const id=useId(),[selected,setSelected]=useState(0),[visible,setVisible]=useState(fields.map(f=>f.key))
 const values=rows.flatMap(r=>fields.filter(f=>visible.includes(f.key)).map(f=>Number(r[f.key])||0)),max=Math.max(1,...values.map(Math.abs)),w=640,h=190,pad=25,mid=95
 const x=i=>pad+(rows.length===1?280:i/(Math.max(1,rows.length-1))*590),y=v=>mid-(Number(v)||0)/max*65
 return <div><div className="widget-tools" aria-label="Séries du graphique">{fields.map(f=><button className="btn btn-ghost btn-sm" key={f.key} aria-pressed={visible.includes(f.key)} onClick={()=>setVisible(v=>v.includes(f.key)?v.filter(x=>x!==f.key):[...v,f.key])}>{f.name}</button>)}</div>
 <svg className="accessible-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={id}>
 <title id={id}>{label}. Sélectionnez les points au clavier, au toucher ou à la souris.</title><line x1="25" x2="615" y1={mid} y2={mid} stroke="var(--muted)" strokeDasharray="4 4"/>
 {fields.filter(f=>visible.includes(f.key)).map(f=><path key={f.key} d={rows.map((r,i)=>`${i?'L':'M'}${x(i)},${y(r[f.key])}`).join(' ')} stroke={f.color} strokeWidth="3" fill="none"/>)}
 {rows.map((r,i)=><g key={r.month||r.label||i} role="button" tabIndex="0" aria-label={`${r.label}, ${fields.map(f=>`${f.name} ${format(r[f.key])}`).join(', ')}`} onFocus={()=>setSelected(i)} onMouseEnter={()=>setSelected(i)} onClick={()=>setSelected(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(i)}}}>
 <rect x={x(i)-19} y="10" width="38" height="165" fill="transparent"/>{fields.filter(f=>visible.includes(f.key)).map(f=><circle key={f.key} cx={x(i)} cy={y(r[f.key])} r={selected===i?6:4} fill={f.color} stroke="var(--bg)" strokeWidth="2"/>)}<text x={x(i)} y="184" textAnchor="middle" fill="var(--muted)" fontSize="11">{r.label}</text></g>)}</svg>
 {rows[selected]&&<div className="chart-detail" aria-live="polite">{rows[selected].label} : {fields.map(f=>`${f.name} : ${format(rows[selected][f.key])}`).join(' · ')}</div>}
 <details><summary>Données du graphique en tableau accessible</summary><div className="table-wrap"><table className="tbl"><caption>{label}</caption><thead><tr><th>Période</th>{fields.map(f=><th key={f.key}>{f.name}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}><th scope="row">{r.month||r.label}</th>{fields.map(f=><td key={f.key}>{format(r[f.key])}</td>)}</tr>)}</tbody></table></div></details></div>
}
