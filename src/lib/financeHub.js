import { db,authorize } from './db.js'
import { notifyLocal } from './experience.js'
import { csvRows } from './operations.js'
export const FINANCE_CATEGORIES=['stationnement','transport','entretien','assurance','salaires','charges','autre']
export function filterTransactions(rows,{from='',to='',min='',max='',category='',accountId=''}={}) {
 const low=min===''?0:Number(min),high=max===''?Infinity:Number(max)
 if(!Number.isFinite(low)||low<0||high<low||(!Number.isFinite(high)&&high!==Infinity))throw new Error('Filtre de montant invalide.')
 return rows.filter(r=>(!from||r.date.slice(0,10)>=from)&&(!to||r.date.slice(0,10)<=to)&&Math.abs(r.amount)>=low&&Math.abs(r.amount)<=high&&(!category||r.category===category)&&(!accountId||r.accountId===accountId)).sort((a,b)=>b.date.localeCompare(a.date))
}
export function monthlyFinance(rows,months=6,at=new Date()) {
 const out=[]
 for(let n=months-1;n>=0;n--){const d=new Date(at.getFullYear(),at.getMonth()-n,1),key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,selected=rows.filter(r=>r.date.slice(0,7)===key),income=selected.filter(r=>r.amount>0).reduce((a,r)=>a+r.amount,0),expenses=-selected.filter(r=>r.amount<0).reduce((a,r)=>a+r.amount,0);out.push({month:key,label:d.toLocaleDateString('fr-FR',{month:'short'}),income,expenses,savings:Math.round((income-expenses)*100)/100})}
 return out
}
export async function applicationTransactions(lotId) {
 const [payments,tickets,expenses,passes]=await Promise.all(['payments','tickets','expenses','parkingPasses'].map(t=>db.table(t).where('lotId').equals(lotId).toArray()))
 return [
  ...payments.map(p=>({id:`payment:${p.id}`,date:p.date,label:p.ref||'Règlement véhicule',amount:Number(p.amount),category:'autre',source:'application',method:p.method})),
  ...tickets.filter(t=>t.status==='cloture').map(t=>({id:`ticket:${t.id}`,date:t.exitAt,label:`Stationnement ${t.ref}`,amount:Number(t.amount),category:'stationnement',source:'application',method:t.paymentMethod})),
  ...passes.filter(p=>p.amount>0).map(p=>({id:`pass:${p.id}`,date:p.createdAt,label:`Abonnement ${p.holder}`,amount:Number(p.amount),category:'stationnement',source:'application',method:p.paymentMethod})),
  ...expenses.map(e=>({id:`expense:${e.id}`,date:e.date,label:e.label,amount:-Number(e.amount),category:FINANCE_CATEGORIES.includes(e.category)?e.category:'charges',source:'application',method:'non renseigné'}))
 ].filter(r=>r.date&&Number.isFinite(r.amount))
}
export function transactionsCSV(rows){return csvRows(['Date','Libellé','Montant signé','Catégorie','Compte','Source'],rows.map(r=>[r.date,r.label,r.amount,r.category,r.accountId||'',r.source]))}
export function parseCSV(text) {
 const content=String(text).replace(/^\uFEFF/,'');if(content.length>3000000)throw new Error('CSV limité à 3 Mo.')
 const delimiter=content.split(/\r?\n/)[0].includes(';')?';':','
 const rows=[];let row=[],value='',quoted=false
 for(let i=0;i<content.length;i++){const c=content[i];if(c==='"'){if(quoted&&content[i+1]==='"'){value+='"';i++}else quoted=!quoted}
 else if(c===delimiter&&!quoted){row.push(value);value=''}else if(c==='\n'&&!quoted){row.push(value.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row);row=[];value=''}else value+=c}
 if(quoted)throw new Error('Guillemets CSV non fermés.');row.push(value.replace(/\r$/,''));if(row.some(x=>x.trim()))rows.push(row)
 const head=rows.shift()?.map(h=>h.trim().toLowerCase())||[],idx=k=>head.indexOf(k)
 if(['date','label','amount'].some(k=>idx(k)<0))throw new Error('En-têtes requis : date;label;amount (optionnels : category;externalid).')
 return rows.map((r,i)=>{const date=String(r[idx('date')]||'').trim(),amount=String(r[idx('amount')]||'').trim()===''?NaN:Number(String(r[idx('amount')]||'').replace(/[\s\u202f]/g,'').replace(',','.')),label=String(r[idx('label')]||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date||!Number.isFinite(amount)||!label)throw new Error(`Ligne ${i+2} invalide.`);return {date:`${date}T12:00:00.000Z`,label:label.slice(0,200),amount,category:FINANCE_CATEGORIES.includes(r[idx('category')])?r[idx('category')]:'autre',externalId:idx('externalid')>=0?r[idx('externalid')]:''}})
}
export async function createBankAccount(lotId,actor,name) {
 await authorize(actor,lotId,'kpi.read');if(!String(name).trim())throw new Error('Nom de compte requis.')
 const row={id:crypto.randomUUID(),lotId,name:String(name).trim(),provider:'csv',status:'local-import',createdAt:new Date().toISOString()};await db.bankAccounts.add(row);return row
}
export async function importBankCSV(lotId,actor,accountId,text) {
 await authorize(actor,lotId,'kpi.read');const account=await db.bankAccounts.get(accountId);if(!account||account.lotId!==lotId||account.provider!=='csv')throw new Error('Compte CSV du parking requis.')
 const rows=parseCSV(text);let added=0
 await db.transaction('rw',db.bankTransactions,async()=>{for(const r of rows){const key=`${accountId}:${r.externalId||`${r.date}:${r.amount}:${r.label}`}`;const id=`bank:${key}`;if(await db.bankTransactions.get(id))continue;await db.bankTransactions.add({...r,id,lotId,accountId,source:'bank-import',importedAt:new Date().toISOString()});added++}})
 return {added,duplicates:rows.length-added}
}
export async function loadFinanceDemo(lotId,actor) {
 await authorize(actor,lotId,'kpi.read');const accountId=`DEMO:${lotId}`
 await db.transaction('rw',db.bankAccounts,db.bankTransactions,async()=>{await db.bankAccounts.put({id:accountId,lotId,name:'DÉMONSTRATION — aucune banque connectée',provider:'demo',status:'demo'});for(const [n,m] of monthlyFinance([],6).entries()){for(const [j,amount] of [120000+n*5000,-18000-n*1000,-22000-n*1500].entries()){const date=`${m.month}-${j===0?'05':j===1?'12':'20'}T12:00:00.000Z`;await db.bankTransactions.put({id:`demo:${lotId}:${m.month}:${j}`,lotId,accountId,date,label:`DÉMO ${j===0?'encaissement':j===1?'parking':'entretien'}`,amount,category:j===1?'stationnement':j===2?'entretien':'autre',source:'demo'})}}})
 return accountId
}
export async function saveBudget(lotId,actor,{month,category,limit,scope='application'}) {
 await authorize(actor,lotId,'kpi.read');const value=Number(limit)
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!FINANCE_CATEGORIES.includes(category)||!Number.isFinite(value)||value<=0||!['application','bank'].includes(scope))throw new Error('Budget invalide.')
 const row={id:`${lotId}:${actor.id}:${scope}:${month}:${category}`,lotId,userId:actor.id,month,category,limit:value,scope};await db.budgets.put(row);return row
}
export function budgetProgress(budget,rows){const spent=-rows.filter(r=>r.amount<0&&r.category===budget.category&&r.date.slice(0,7)===budget.month).reduce((n,r)=>n+r.amount,0);return {...budget,spent,percent:Math.round(spent/budget.limit*1000)/10,exceeded:spent>=budget.limit}}
export async function evaluateBudgets(lotId,userId,scope,rows){const budgets=await db.budgets.where('lotId').equals(lotId).filter(b=>b.userId===userId&&b.scope===scope).toArray();for(const b of budgets){const p=budgetProgress(b,rows);if(p.exceeded)await notifyLocal({lotId,userId,kind:'budget',title:`Budget ${b.category} atteint`,body:`${p.spent} sur ${b.limit} pour ${b.month}.`,dedupe:`budget:${b.id}`})}}
export async function transactionsPDF(rows,{lot,from='',to=''}) {
 const [{default:jsPDF},{default:autoTableImport}]=await Promise.all([import('jspdf'),import('jspdf-autotable')]);const autoTable=typeof autoTableImport==='function'?autoTableImport:autoTableImport.default
 const doc=new jsPDF();doc.setFontSize(16);doc.text(`MON PARKING - ${lot.name}`,14,18);doc.setFontSize(10);doc.text(`Transactions ${from||'toutes dates'} / ${to||'toutes dates'} - ${lot.currency||'XOF'}`,14,26)
 doc.text('Flux declares/importes, non rapproches automatiquement avec une banque.',14,33)
 autoTable(doc,{startY:40,head:[['Date','Libelle','Montant','Categorie','Source']],body:rows.map(r=>[r.date.slice(0,10),r.label,Number(r.amount).toFixed(2),r.category,r.source]),styles:{fontSize:8},margin:{bottom:15}})
 return doc
}
