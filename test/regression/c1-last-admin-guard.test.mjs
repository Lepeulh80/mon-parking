// C1 — protection du dernier administrateur actif.
// Défaut v12 : le garde testait « patch.active === false » alors que l'écriture
// testait la véracité de la valeur. {"active":0} désactivait donc le dernier
// administrateur sans déclencher la protection : le parking devenait
// inadministrable (readyz → 503 ADMIN_REQUIRED) jusqu'à intervention SQL manuelle.
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore,hashServerPin } from '../../server/auth-store.mjs'
import { createAuthServer } from '../../server/http.mjs'
import { createServer } from 'node:net'

let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

const dir=await mkdtemp(join(tmpdir(),'mp-c1-')),dbPath=join(dir,'auth.sqlite')
const store=new AuthStore(dbPath)
const pin=await hashServerPin('1234'),pin2=await hashServerPin('1111')
store.importTrusted({
  lots:[{id:'LOT-A',name:'Parc A',code:'PARA'}],
  users:[
    {id:'admin-1',lotId:'LOT-A',username:'admin',name:'Admin Un',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt,phone:'+225 07 00 00 00',email:'admin@parc.ci'},
    {id:'staff-1',lotId:'LOT-A',username:'vendeur',name:'Vendeur',role:'employe',active:true,pinHash:pin2.hash,salt:pin2.salt},
  ],
})

const probe=createServer()
await new Promise(r=>probe.listen(0,'127.0.0.1',r))
const port=probe.address().port
await new Promise(r=>probe.close(r))
const origin=`http://127.0.0.1:${port}`
const server=createAuthServer({store,origin})
await new Promise(r=>server.listen(port,'127.0.0.1',r))

const call=async(path,{method='GET',body,cookie}={})=>{
  const response=await fetch(origin+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined})
  let data=null
  try{data=await response.json()}catch{/* empty body */}
  return {status:response.status,data,setCookie:response.headers.get('set-cookie')}
}
const login=async(username,pwd)=>{
  const response=await call('/api/auth/login',{method:'POST',body:{username,pin:pwd}})
  assert.equal(response.status,200,JSON.stringify(response.data))
  return response.setCookie.split(';')[0]
}
const activeAdmins=()=>store.sql.prepare("SELECT COUNT(*) n FROM accounts WHERE lot_id='LOT-A' AND role='admin' AND active=1").get().n

try{
  const admin=await login('admin','1234')

  await check('{active:0} ne contourne plus la protection du dernier admin',async()=>{
    const response=await call('/api/admin/users/admin-1',{method:'PATCH',cookie:admin,body:{active:0}})
    assert.equal(response.status,409,`reçu ${response.status} ${JSON.stringify(response.data)}`)
    assert.equal(activeAdmins(),1,'le dernier administrateur a été désactivé')
    assert.equal((await call('/api/auth/session',{cookie:admin})).status,200,'la session admin a été cassée')
  })

  await check('Même protection pour les variantes falsy (0, "0", "", null, "false")',async()=>{
    for(const value of [0,'0','false',null,'']){
      const response=await call('/api/admin/users/admin-1',{method:'PATCH',cookie:admin,body:{active:value}})
      assert([400,409].includes(response.status),`valeur ${JSON.stringify(value)} acceptée (${response.status})`)
      assert.equal(activeAdmins(),1,`désactivation via ${JSON.stringify(value)}`)
    }
  })

  await check('Rétrogradation du dernier admin refusée, quel que soit le chemin',async()=>{
    for(const body of [{role:'employe'},{role:'employe',active:true},{active:true,role:'agent'}]){
      const response=await call('/api/admin/users/admin-1',{method:'PATCH',cookie:admin,body})
      assert.equal(response.status,409,`${JSON.stringify(body)} → ${response.status}`)
      assert.equal(activeAdmins(),1)
    }
  })

  await check('Valeur « active » ambiguë refusée explicitement (400)',async()=>{
    const response=await call('/api/admin/users/staff-1',{method:'PATCH',cookie:admin,body:{active:'peut-être'}})
    assert.equal(response.status,400)
    assert.match(response.data.error,/active/i)
  })

  await check('Avec un second administrateur actif, la désactivation redevient possible',async()=>{
    const created=await call('/api/admin/users',{method:'POST',cookie:admin,body:{lotId:'LOT-A',name:'Admin Deux',username:'admin2',pin:'4321',role:'admin'}})
    assert.equal(created.status,201,JSON.stringify(created.data))
    assert.equal(activeAdmins(),2)
    const disabled=await call('/api/admin/users/admin-1',{method:'PATCH',cookie:admin,body:{active:0}})
    assert.equal(disabled.status,200,JSON.stringify(disabled.data))
    assert.equal(disabled.data.active,false)
    assert.equal(activeAdmins(),1)
    // Le compte désactivé perd immédiatement son accès.
    assert.equal((await call('/api/auth/session',{cookie:admin})).status,401)
  })

  await check('Le dernier admin restant est de nouveau protégé',async()=>{
    const second=await login('admin2','4321')
    const response=await call('/api/admin/users/'+store.sql.prepare("SELECT id FROM accounts WHERE username='admin2'").get().id,{method:'PATCH',cookie:second,body:{active:false}})
    assert.equal(response.status,409)
    assert.equal(activeAdmins(),1)
  })
}finally{
  server.closeAllConnections()
  await new Promise(r=>server.close(r))
  store.close()
  await rm(dir,{recursive:true,force:true})
}

console.log(`C1 LAST ADMIN GUARD: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
