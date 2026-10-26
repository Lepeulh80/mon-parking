import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {db,hashPin} from '../src/lib/db.js'
import {AuthStore,hashServerPin} from '../server/auth-store.mjs'
import {aggregate,MIN_COUNT} from '../src/lib/learning.js'
import {parkingStats} from '../src/lib/parking.js'
import {buildReceipt,buildParkingReceipt} from '../src/lib/pdf.js'
let count=0
const check=async(name,fn)=>{await fn();console.log('PASS',name);count++}
const credentials=await hashServerPin('7685')
await check('B18 PIN PBKDF2 salé, non déterministe et mauvais PIN refusé',async()=>{
 assert.match(credentials.hash,/^pbkdf2-sha256\$600000\$/);assert.equal(credentials.salt.length,32)
 assert.notEqual((await hashServerPin('7685')).salt,credentials.salt)
 const store=new AuthStore(':memory:')
 store.importTrusted({lots:[{id:'pin-lot',name:'PIN'}],users:[{id:'pin-user',lotId:'pin-lot',username:'pin-user',name:'Test',role:'admin',active:true,pinHash:credentials.hash,salt:credentials.salt}]})
 assert((await store.login('pin-user','7685')).token)
 await assert.rejects(()=>store.login('pin-user','0000'),e=>e.status===401)
 store.close()
})
await check('Compatibilité SHA256 : migration automatique au login serveur',async()=>{
 const salt='legacy-salt';let hash=`${salt}:7685`;for(let i=0;i<3;i++)hash=createHash('sha256').update(hash).digest('hex')
 const store=new AuthStore(':memory:')
 store.importTrusted({lots:[{id:'pin-lot',name:'PIN'}],users:[{id:'pin-user',lotId:'pin-lot',username:'pin-user',name:'Test',role:'admin',active:true,pinHash:hash,salt}]})
 assert((await store.login('pin-user','7685')).token)
 assert.match(store.sql.prepare("SELECT pin_hash h FROM accounts WHERE id='pin-user'").get().h,/^pbkdf2-sha256\$600000\$/)
 await assert.rejects(()=>store.login('pin-user','0000'),e=>e.status===401)
 store.close()
})
await check('Ancien fallback non cryptographique accepté puis renforcé',async()=>{
 const salt='legacy-fallback';let h=`${salt}:7685`
 for(let j=0;j<3;j++){let h1=0x811c9dc5,h2=0x1000193;for(let i=0;i<h.length;i++){h1=(h1^h.charCodeAt(i))*0x01000193;h2=(h2+h.charCodeAt(i)*(i+7))>>>0}h=`fb${(h1>>>0).toString(16)}${(h2>>>0).toString(16)}`}
 const store=new AuthStore(':memory:')
 store.importTrusted({lots:[{id:'pin-lot',name:'PIN'}],users:[{id:'pin-user',lotId:'pin-lot',username:'pin-user',name:'Test',role:'admin',active:true,pinHash:h,salt}]})
 assert((await store.login('pin-user','7685')).token)
 assert.match(store.sql.prepare("SELECT pin_hash h FROM accounts WHERE id='pin-user'").get().h,/^pbkdf2-sha256/)
 store.close()
})
await check('B17 une validation OCR répétant une paire ne suffit pas',()=>{
 const event={pairs:['8>B','8>B','8>B'],rawCompact:'CI8888AB',chosenCompact:'CIBBBBAB'}
 assert.equal(aggregate([event]).pairs[0].count,1);assert.equal(aggregate([event]).counts.pairsActive,0)
 assert.equal(aggregate(Array.from({length:MIN_COUNT},()=>event)).counts.pairsActive,1)
})
await check('PDF vente et stationnement valides après mise à jour de sécurité',async()=>{
 const lot={name:'Parking Audit',currency:'XOF',hourlyRate:500},sale={receiptNumber:'REC-TEST',invoiceNumber:'FAC-TEST',total:1000,paid:500,date:new Date().toISOString(),vehicleSnapshot:{plate:'CI 4471 AB'},clientSnapshot:{name:'Test'},paymentMethod:'espèces'}
 const ticket={ref:'TCK-TEST',plate:'CI 4471 AB',entryAt:new Date(Date.now()-3600000).toISOString(),exitAt:new Date().toISOString(),amount:500,spotCode:'A01',hourlyRate:0,paymentMethod:'espèces'}
 for(const doc of [await buildReceipt(sale,lot),await buildParkingReceipt(ticket,lot)]){assert.match(doc.output(),/^%PDF-/);assert(doc.output().length>1000);assert.equal(doc.internal.pageSize.getWidth(),80)}
})
await check('B20 tarif horaire nul conservé dans les estimations',()=>{
 const result=parkingStats({lot:{hourlyRate:500},spots:[],tickets:[{status:'ouvert',entryAt:new Date(Date.now()-3600000).toISOString(),hourlyRate:0,dailyCap:6000,graceMinutes:0}]})
 assert.equal(result.openEstimate,0)
})
db.close();console.log('V11 SECURITY',count,'passed')
