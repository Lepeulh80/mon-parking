import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { db,createSale,returnRental,deleteSale } from '../src/lib/db.js'
import { createAdditionalLot } from '../src/lib/admin.js'
import { saveReservation,checkInReservation,createTicket,closeTicket,parkingStats } from '../src/lib/parking.js'
import { openCash } from '../src/lib/operations.js'
import { parseCSV } from '../src/lib/financeHub.js'
import { plateScore } from '../src/lib/match.js'
import { aggregate } from '../src/lib/learning.js'
import { requestIntegration } from '../src/lib/securityHub.js'
import { syncParking } from '../src/lib/parkingSync.js'
import { setConfig,clearConfig } from '../src/lib/supabase.js'
import { cashSummary } from '../src/lib/cashLedger.js'
const report=[]
async function test(id,file,cause,fn){try{await fn();report.push({id,file,cause,pass:true});console.log('PASS',id)}catch(e){report.push({id,file,cause,pass:false,error:e.message});console.log('FAIL',id,e.message)}}
const L='audit-lot',A={id:'audit-admin',lotId:L,username:'audit-admin',name:'Admin',role:'admin',active:true},E={id:'audit-agent',lotId:L,role:'agent',active:true},O={id:'other-admin',lotId:'other',role:'admin',active:true},now=Date.now(),iso=n=>new Date(now+n).toISOString()
const lot={id:L,name:'Audit',hourlyRate:500,dailyCap:6000,graceMinutes:0,invoiceNext:1,receiptNext:1,ticketNext:1,code:'TEST'}
await db.lots.bulkPut([lot,{...lot,id:'other'}]);await db.users.bulkPut([A,E,O]);await db.vehicles.bulkPut([{id:'vehicle',lotId:L,status:'stock',plate:'V',mileage:100},{id:'vehicle-2',lotId:L,status:'stock',plate:'V2',mileage:100}]);
await db.spots.bulkPut(Array.from({length:6},(_,i)=>({id:`s${i}`,lotId:L,code:`A0${i}`,type:'standard',zone:'A',status:'libre'})))
await test('B01','src/lib/admin.js:createAdditionalLot','Requête sur ownerKey non indexé',async()=>{const row=await createAdditionalLot(A,{name:'Nouveau parc',city:'Abidjan',currency:'XOF'});assert(row.id)})
const salePayload={lotId:L,userId:A.id,userName:A.name,vehicleId:'vehicle',type:'vente',total:100,paid:50,price:100,subtotal:100,vatAmount:0,vehicleSnapshot:{plate:'V'},date:iso(0)}
const sale=await createSale(salePayload)
await test('B02','src/lib/db.js:returnRental','Aucune vérification du type de document',async()=>{await assert.rejects(()=>returnRental(sale.id,0,A));assert.equal((await db.vehicles.get('vehicle')).status,'vendu')})
await db.vehicles.update('vehicle',{status:'vendu'})
await db.sales.put({id:'rental',lotId:L,vehicleId:'vehicle-2',type:'location',total:100,paid:0,invoiceNumber:'LOC',returnedAt:null})
await db.vehicles.update('vehicle-2',{status:'loue'})
await test('B03','src/lib/db.js:returnRental','Absence de contrôle des droits et du parking',async()=>{await assert.rejects(()=>returnRental('rental',0,O));assert.equal((await db.vehicles.get('vehicle-2')).status,'loue')})
await test('B04','src/lib/db.js:deleteSale','Suppression de règlements sans contrepassation de caisse',async()=>{await assert.rejects(()=>deleteSale(sale.id,A));assert(await db.sales.get(sale.id))})
await test('B05','src/lib/db.js:createSale','Totaux validés puis stockés dans leur type initial',async()=>{await db.vehicles.put({id:'strings',lotId:L,status:'stock',plate:'STRING'});const row=await createSale({...salePayload,vehicleId:'strings',total:'100',paid:'20'});assert.equal(typeof row.total,'number');assert.equal(typeof row.paid,'number')})
await test('B06','src/lib/parking.js:checkInReservation','Place réservée refusée par createTicket, qui exige libre',async()=>{const rid=await saveReservation(L,{spotId:'s0',plate:'CI 1000 AB',startAt:iso(-1000),endAt:iso(3600000)});const r=await db.reservations.get(rid);const t=await checkInReservation(r,lot,A);assert.equal(t.status,'ouvert');assert.equal((await db.reservations.get(rid)).status,'en-cours')})
await test('B07','src/lib/parking.js:saveReservation','Identifiant de place d’un autre parking accepté',async()=>{await db.spots.put({id:'foreign',lotId:'other',status:'libre',code:'X'});await assert.rejects(()=>saveReservation(L,{spotId:'foreign',plate:'CI 2000 AB',startAt:iso(0),endAt:iso(10000)}))})
await test('B08','src/lib/parking.js:saveReservation','Période inversée acceptée',()=>assert.rejects(()=>saveReservation(L,{spotId:'s1',plate:'CI 3000 AB',startAt:iso(10000),endAt:iso(0)})))
await test('B09','src/lib/match.js:makeCostFn','Un coût appris de 0,45 augmente le coût visuel initial de 0,25',()=>{const raw='CI 8842 K8',stored='CI 8842 KB',before=plateScore(raw,stored);const learning=aggregate([{pairs:['8>B'],rawCompact:'UNRELATED',chosenCompact:'NOBOOST'},{pairs:['8>B'],rawCompact:'UNRELATED',chosenCompact:'NOBOOST'}]);assert(plateScore(raw,stored,learning).score>=before.score)})
await test('B10','src/lib/financeHub.js:parseCSV','Montant vide transformé en zéro par Number("")',()=>assert.throws(()=>parseCSV('date;label;amount\n2026-10-01;Parking;')))
await test('B11','src/lib/securityHub.js:requestIntegration','payload.provider écrase le prestataire validé',async()=>{const old=globalThis.fetch;let sent;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(init.body);return {ok:true,json:async()=>({})}};try{await requestIntegration('bank',{endpoint:'https://example.test/bff',accessToken:'TOKEN',payload:{provider:'dropbox'}});assert.equal(sent.provider,'bank')}finally{globalThis.fetch=old}})
const previousTZ=process.env.TZ;process.env.TZ='America/Los_Angeles'
await test('B12','src/lib/parking.js:parkingStats','Jour civil comparé à une date UTC',()=>{const RealDate=globalThis.Date;globalThis.Date=class extends RealDate{constructor(...args){if(args.length)super(...args);else super('2026-10-21T03:00:00Z')}static now(){return RealDate.parse('2026-10-21T03:00:00Z')}};try{const stats=parkingStats({spots:[],lot,tickets:[{status:'cloture',exitAt:'2026-10-20T07:10:00Z',amount:500}]});assert.equal(stats.todayCount,1)}finally{globalThis.Date=RealDate}})
if(previousTZ)process.env.TZ=previousTZ;else delete process.env.TZ
// Cloud merge repro: one unresolved correction must not freeze every other slot.
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
setConfig({url:'https://example.supabase.co',anonKey:'test',ocrLotIds:{[L]:'11111111-1111-4111-8111-111111111111'},ticketCloudLots:{[L]:true}})
await db.tickets.put({id:'pending-ticket',lotId:L,spotId:'s4',spotCode:'A04',plate:'CI 4040 AB',status:'ouvert',version:2})
await db.parkingSyncEvents.put({id:crypto.randomUUID(),lotId:L,status:'conflict',kind:'correction',payload:{ticketId:'pending-ticket'},sequence:1})
await db.spots.update('s5',{status:'occupe'})
const adapter={auth:{getSession:async()=>({data:{session:{user:{id:'server-admin'}}}})},rpc:async(name)=>({data:name==='pro_snapshot'?{serverAt:new Date().toISOString(),slots:[{code:'A05',status:'libre'}],tickets:[],cash:[],corrections:[]}: {},error:null})}
await test('B13','src/lib/parkingSync.js:slot merge','Tout ticket pending bloque toutes les places',async()=>{await syncParking(L,{sb:adapter});assert.equal((await db.spots.get('s5')).status,'libre')})
await db.cashSessions.put({id:'cloud-cash',lotId:L,userId:A.id,openingFloat:1000,cloudMode:true,cloudExpected:1000,status:'ouverte'})
await db.cashMovements.put({id:'move',lotId:L,sessionId:'cloud-cash',source:`${L}:ticket:cloud-ticket`,kind:'recette',method:'espèces',amount:500,pendingCloud:true})
await test('B14','src/lib/parkingSync.js:receipt confirmation','pendingCloud jamais acquitté avec le total serveur : double comptage',async()=>{const sb={...adapter,rpc:async()=>({data:{serverAt:new Date(Date.now()+1000).toISOString(),slots:[],tickets:[{id:'cloud-ticket',spotCode:'A05',status:'cloture',version:2,amount:500}],cash:[{id:'cloud-cash',userId:'server-admin',status:'ouverte',openingFloat:1000,expected:1500}],corrections:[]}})};await syncParking(L,{sb});assert.equal(cashSummary(await db.cashSessions.get('cloud-cash'),await db.cashMovements.toArray()).expected,1500)})
clearConfig();delete globalThis.localStorage
await fs.mkdir('audit-evidence',{recursive:true});await fs.writeFile(process.env.AUDIT_PHASE==='before'?'audit-evidence/regressions-before.json':'audit-evidence/regressions-after.json',JSON.stringify(report,null,2));db.close();const failed=report.filter(r=>!r.pass).length;console.log(`AUDIT REGRESSIONS: ${report.length-failed} passed / ${failed} failed`);process.exit(failed?1:0)
