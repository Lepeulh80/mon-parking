import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { db } from './src/lib/db.js'
import { calculateParkingFee as fee } from './src/lib/feeEngine.js'
import { createTicket, closeTicket, setSpotStatus } from './src/lib/parking.js'
import { markLostTicket,correctTicketPlate,dailyParkingReport,saveParkingPolicy } from './src/lib/proParking.js'
import { openCash,closeCash } from './src/lib/operations.js'
import { cashSummary } from './src/lib/cashLedger.js'
import { enqueueParking,syncParking,acceptServerPlate } from './src/lib/parkingSync.js'
import { setConfig,clearConfig } from './src/lib/supabase.js'
let ok=0,ko=0
async function test(name,fn){try{await fn();console.log('OK',name);ok++}catch(e){console.error('KO',name,e.stack);ko++}}
const now=Date.now(),iso=(n=0)=>new Date(now+n).toISOString(),base={hourlyRate:500,dailyRate:6000,dailyCap:6000,graceMinutes:0,maxStayHours:24,overstayHourlyRate:100,lostTicketFee:2000}
await test('passage à minuit : durée écoulée, pas deux journées',()=>assert.equal(fee({...base,billingMode:'daily',entryAt:'2026-10-19T23:50:00Z',exitAt:'2026-10-20T00:10:00Z'}).amount,6000))
await test('plafond horaire et tranches de 24 h',()=>{assert.equal(fee({...base,overstayHourlyRate:0,entryAt:iso(-20*3600000),exitAt:iso()}).amount,6000);assert.equal(fee({...base,overstayHourlyRate:0,entryAt:iso(-44*3600000),exitAt:iso()}).amount,12000)})
await test('franchise, date invalide, montant négatif',()=>{assert.equal(fee({...base,graceMinutes:15,entryAt:iso(-900000),exitAt:iso()}).amount,0);assert.throws(()=>fee({...base,entryAt:'x',exitAt:iso()}));assert.throws(()=>fee({...base,hourlyRate:-1,entryAt:iso(),exitAt:iso()}))})
await test('ticket perdu et dépassement détaillés',()=>{const f=fee({...base,entryAt:iso(-26*3600000),exitAt:iso(),lostTicket:true});assert.equal(f.baseAmount,7000);assert.equal(f.overstayFee,200);assert.equal(f.lostFee,2000);assert.equal(f.amount,9200)})
await test('abonné : temps gratuit, perte facturée explicitement',()=>{assert.equal(fee({...base,entryAt:iso(-26*3600000),exitAt:iso(),subscriber:true}).amount,0);assert.equal(fee({...base,entryAt:iso(-26*3600000),exitAt:iso(),subscriber:true,lostTicket:true}).amount,2000)})
const lot={id:'LOCAL',name:'Parc v9',...base,requireCashSession:true,ticketNext:1},a={id:'a',lotId:'LOCAL',name:'Admin',role:'admin',active:true}
await db.lots.put(lot);await db.users.put(a);await db.spots.bulkPut([{id:'s1',lotId:lot.id,code:'A01',type:'standard',status:'libre'},{id:'s2',lotId:lot.id,code:'A02',type:'standard',status:'libre'}]);await saveParkingPolicy(lot.id,a,base)
let localTicket
await test('entrées locales simultanées : une seule gagne la place',async()=>{const results=await Promise.allSettled([createTicket({lot,plate:'CI 1000 AB',spotId:'s1',user:a}),createTicket({lot,plate:'CI 2000 AB',spotId:'s1',user:a})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);localTicket=results.find(r=>r.status==='fulfilled').value;assert.equal(await db.tickets.where('status').equals('ouvert').count(),1)})
await test('deux corrections concurrentes : une version rejetée, historique conservé',async()=>{const v=localTicket.version;const r=await Promise.allSettled([correctTicketPlate(localTicket.id,a,'CI 3000 AB','Correction relevé',v),correctTicketPlate(localTicket.id,a,'CI 4000 AB','Autre relevé',v)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(await db.plateCorrections.count(),1)})
await test('ticket perdu + sortie positive + double sortie bloquée',async()=>{await markLostTicket(localTicket.id,a,'Original papier égaré');const s=await openCash(lot.id,a,1000);const r=await Promise.allSettled([closeTicket(localTicket.id,{user:a}),closeTicket(localTicket.id,{user:a})]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await db.spots.get('s1')).status,'libre');const moves=await db.cashMovements.toArray();assert.equal(moves.length,1);const expected=cashSummary(s,moves).expected;assert.equal(expected,3500);const closed=await closeCash(s.id,a,3490,'Écart de 10 à contrôler');assert.equal(closed.variance,-10)})
await test('rapport journalier et grille 24 heures',async()=>{const t=await db.tickets.get(localTicket.id);const day=new Date(t.exitAt).toLocaleDateString('en-CA');const r=dailyParkingReport({day,tickets:[t],spots:await db.spots.toArray(),cashSessions:await db.cashSessions.toArray()});assert.equal(r.exits,1);assert.equal(r.revenue,2500);assert.equal(r.variance,-10);assert.equal(r.hours.length,24)})
await test('une place occupée ne se libère pas hors clôture',async()=>{const t=await createTicket({lot,plate:'CI 5000 AB',spotId:'s2',user:a});await assert.rejects(()=>setSpotStatus('s2','libre'),/Clôturez/);assert.equal((await db.spots.get('s2')).status,'occupe')})
console.log('=== PostgreSQL transactionnel : deux postes, reprises et contrôle des droits ===')
const pg=new PGlite(),L='11111111-1111-4111-8111-111111111111',A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
await pg.exec(`create role authenticated;create role anon;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema public,auth to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;create table lots(id uuid primary key);create table memberships(user_id uuid,lot_id uuid,role text,active boolean default true);create table spots(id uuid,lot_id uuid,status text);insert into lots values('${L}');insert into memberships values('${A}','${L}','admin',true),('${B}','${L}','caissier',true);`)
for(const f of (await fs.readdir('./migrations')).filter(f=>/^(008_|009_)/.test(f)).sort())await pg.exec(await fs.readFile(`./migrations/${f}`,'utf8'))
async function login(uid,role='authenticated'){await pg.exec('reset role');await pg.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);await pg.exec(`set role ${role}`)}
async function rpc(name,args){const keys=Object.keys(args),values=keys.map(k=>typeof args[k]==='object'?JSON.stringify(args[k]):args[k]);const sql=`select public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) as result`;return (await pg.query(sql,values)).rows[0].result}
const event=(kind,payload)=>({id:crypto.randomUUID(),kind,payload})
await login(A)
await test('migrations v9 exécutées et configuration serveur autorisée',async()=>{await rpc('pro_configure',{p_lot:L,p_fees:base,p_slots:[{code:'A01'},{code:'A02'}],p_rates:[],p_passes:[]})})
await test('formules SQL/JS cohérentes pour les 5 cas limites',async()=>{for(const x of [{...base},{...base,billingMode:'daily'},{...base,lostTicket:true},{...base,subscriber:true},{...base,subscriber:true,lostTicket:true}]){const args={p_entry:iso(-26*3600000),p_exit:iso(),p:x,p_lost:!!x.lostTicket,p_subscriber:!!x.subscriber};const result=await rpc('pro_fee',args);assert.equal(Number(result.amount),fee({...x,entryAt:args.p_entry,exitAt:args.p_exit}).amount)}})
const T=crypto.randomUUID(),entry=event('entry',{id:T,plate:'CI 9000 AB',spotCode:'A01',entryAt:iso(-1800000)})
await test('entrée cloud et rejeu idempotent : même ticket, une occupation',async()=>{const first=await rpc('pro_apply_event',{p_lot:L,p_event:entry});const replay=await rpc('pro_apply_event',{p_lot:L,p_event:entry});assert.deepEqual(first,replay);assert.equal(first.ticket.version,1)})
await login(B)
await test('second poste ne peut pas prendre la même place',async()=>{await assert.rejects(()=>rpc('pro_apply_event',{p_lot:L,p_event:event('entry',{id:crypto.randomUUID(),plate:'CI 9999 AB',spotCode:'A01',entryAt:iso()})}),/SLOT_UNAVAILABLE/)})
await test('caissier ne peut pas corriger une plaque',async()=>{await assert.rejects(()=>rpc('pro_apply_event',{p_lot:L,p_event:event('correction',{ticketId:T,expectedVersion:1,plate:'CI 9001 AB',reason:'Tentative'})}),/FORBIDDEN/)})
await login(A)
await test('correction versionnée et journal append-only',async()=>{await rpc('pro_apply_event',{p_lot:L,p_event:event('correction',{ticketId:T,expectedVersion:1,plate:'CI 9001 AB',reason:'Lecture rectifiée'})});await assert.rejects(()=>rpc('pro_apply_event',{p_lot:L,p_event:event('correction',{ticketId:T,expectedVersion:1,plate:'CI 9002 AB',reason:'Écriture concurrente'})}),/VERSION_CONFLICT/);await assert.rejects(()=>pg.exec('delete from pro_plate_corrections'));const snap=await rpc('pro_snapshot',{p_lot:L});assert.equal(snap.corrections.length,1);assert.equal(snap.tickets[0].plate,'CI 9001 AB')})
await test('ticket perdu serveur et clôture nécessitent une caisse',async()=>{await rpc('pro_apply_event',{p_lot:L,p_event:event('lost',{ticketId:T,expectedVersion:2,reason:'Papier égaré'})});await assert.rejects(()=>rpc('pro_apply_event',{p_lot:L,p_event:event('exit',{ticketId:T,expectedVersion:3,exitAt:iso(),paymentMethod:'espèces'})}),/CASH_SESSION_REQUIRED/)})
const sessionId=crypto.randomUUID(),exitEvent=event('exit',{ticketId:T,expectedVersion:3,exitAt:iso(),paymentMethod:'espèces'})
await test('caisse serveur + sortie + reçu unique + rapprochement',async()=>{await rpc('pro_apply_event',{p_lot:L,p_event:event('cash_open',{id:sessionId,openingFloat:1000})});const out=await rpc('pro_apply_event',{p_lot:L,p_event:exitEvent});assert.equal(Number(out.ticket.amount),2500);await rpc('pro_apply_event',{p_lot:L,p_event:exitEvent});await assert.rejects(()=>rpc('pro_apply_event',{p_lot:L,p_event:event('exit',exitEvent.payload)}),/TICKET_NOT_OPEN/);const snap=await rpc('pro_snapshot',{p_lot:L});assert.equal(snap.slots.find(s=>s.code==='A01').status,'libre');assert.equal(Number(snap.cash[0].expected),3500);const close=await rpc('pro_apply_event',{p_lot:L,p_event:event('cash_close',{sessionId,counted:3490,reason:'Écart contrôlé'})});assert.equal(Number(close.cash.variance),-10)})
await test('protection inter-parking et clé publique seule',async()=>{await assert.rejects(()=>rpc('pro_snapshot',{p_lot:'22222222-2222-4222-8222-222222222222'}),/FORBIDDEN/);await login('','anon');await assert.rejects(()=>pg.exec('select * from pro_tickets'));await assert.rejects(()=>rpc('pro_snapshot',{p_lot:L}));await login(A)})
// Simulated network transport backed by the real SQL functions, not a fake DB.
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
setConfig({url:'https://example.supabase.co',anonKey:'test-public-key',ocrLotIds:{LOCAL:L},ticketCloudLots:{LOCAL:true}})
const adapter={auth:{getSession:async()=>({data:{session:{user:{id:A}}}})},rpc:async(name,args)=>{try{return {data:await rpc(name,args),error:null}}catch(e){return {error:{code:e.code,message:e.message}}}}}
await test('outbox offline conservée, accusé perdu puis reprise sans doublon',async()=>{
 const payload={id:crypto.randomUUID(),spotCode:'A02',plate:'CI 8000 AB',entryAt:iso()}
 await db.transaction('rw',db.parkingSyncEvents,db.meta,()=>enqueueParking(db,'LOCAL','entry',payload));assert.equal(await db.parkingSyncEvents.count(),1)
 const lostAck={...adapter,rpc:async(name,args)=>{const out=await adapter.rpc(name,args);return name==='pro_apply_event'&&!out.error?{error:{message:'network response lost'}}:out}}
 assert.equal((await syncParking('LOCAL',{sb:lostAck})).mode,'error');assert.equal((await db.parkingSyncEvents.toArray())[0].status,'pending')
 const resumed=await syncParking('LOCAL',{sb:adapter});assert.equal(resumed.mode,'cloud');assert.equal((await db.parkingSyncEvents.toArray())[0].status,'ack');const snap=await rpc('pro_snapshot',{p_lot:L});assert.equal(snap.tickets.filter(t=>t.id===payload.id).length,1)
})
await test('conflit de plaque inter-postes : version serveur acceptée, rejet local audité',async()=>{
 const confirmed=(await db.tickets.where('lotId').equals('LOCAL').toArray()).find(t=>t.cloudConfirmed && t.status==='ouvert' && t.spotCode==='A02')
 await correctTicketPlate(confirmed.id,a,'CI 8001 AB','Rectification poste A',confirmed.version)
 await rpc('pro_apply_event',{p_lot:L,p_event:event('correction',{ticketId:confirmed.id,expectedVersion:confirmed.version,plate:'CI 8002 AB',reason:'Rectification concurrente poste B'})})
 await syncParking('LOCAL',{sb:adapter})
 const conflict=(await db.parkingSyncEvents.toArray()).find(e=>e.status==='conflict' && e.kind==='correction')
 assert(conflict);await acceptServerPlate(conflict.id,a,{sb:adapter})
 assert.equal((await db.tickets.get(confirmed.id)).plate,'CI 8002 AB')
 assert.equal((await db.parkingSyncEvents.get(conflict.id)).status,'resolved')
 assert((await db.plateCorrections.toArray()).some(c=>c.ticketId===confirmed.id&&c.remoteRejected))
 assert((await db.audit.toArray()).some(a=>a.action==='plate-conflict-resolved'))
})
clearConfig();delete globalThis.localStorage
await pg.close();db.close();console.log(`RÉSULTAT V9 : ${ok} OK / ${ko} KO`);process.exit(ko?1:0)
