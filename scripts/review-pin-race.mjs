// Concurrence PIN côté SERVEUR (remplace le test IndexedDB, l'authentification
// locale ayant été supprimée en M5). Même garantie : une réinitialisation
// administrateur concurrente ne peut pas être écrasée par une connexion en cours.
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { AuthStore,hashServerPin } from '../server/auth-store.mjs'

let passed=0,failed=0
const ok=(name)=>{passed++;console.log('PASS',name)}
const fail=(name,e)=>{failed++;console.error('FAIL',name,e.message)}

const store=new AuthStore(':memory:')
const admin=await hashServerPin('1234'),target=await hashServerPin('1234')
store.importTrusted({
  lots:[{id:'LOT-A',name:'Parc A'}],
  users:[
    {id:'admin-1',lotId:'LOT-A',username:'admin',name:'Admin',role:'admin',active:true,pinHash:admin.hash,salt:admin.salt},
    {id:'staff-1',lotId:'LOT-A',username:'staff',name:'Agent',role:'employe',active:true,pinHash:target.hash,salt:target.salt},
  ],
})

// Une réinitialisation administrateur se glisse pendant le calcul du hash.
let fired=false
store.hooks.beforeLoginCommit=async row=>{
  if(!fired&&row.id==='staff-1'){
    fired=true
    const adminSession=await store.login('admin','1234')
    await store.updateUser(adminSession.token,'staff-1',{pin:'9012'})
  }
}

try{
  const outcome=await store.login('staff','1234').then(v=>({ok:true,v}),e=>({ok:false,e}))
  assert.equal(outcome.ok,false,'la connexion avec l’ancien PIN a été acceptée')
  assert([401,409].includes(outcome.e.status),`statut inattendu ${outcome.e?.status}`)
  ok('Une réinitialisation administrateur concurrente annule la connexion en cours')

  await assert.rejects(()=>store.login('staff','1234'),e=>e.status===401)
  ok('Ancien PIN refusé après la réinitialisation')

  const fresh=await store.login('staff','9012')
  assert(fresh.token)
  ok('Nouveau PIN immédiatement opérationnel')

  const row=store.sql.prepare("SELECT pin_hash FROM accounts WHERE id='staff-1'").get()
  const expected=(await hashServerPin('9012'))
  assert.notEqual(row.pin_hash,target.hash,'le hash de l’ancien PIN a survécu')
  assert.match(row.pin_hash,/^pbkdf2-sha256\$600000\$/)
  assert(row.pin_hash!==expected.hash,'le hash stocké doit rester salé et unique')
  ok('Le hash stocké est celui du nouveau PIN, salé et non réutilisé')
}catch(error){
  fail('Concurrence PIN serveur',error)
}finally{
  store.hooks.beforeLoginCommit=undefined
  store.close()
}

console.log(`PIN CONCURRENCY: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
