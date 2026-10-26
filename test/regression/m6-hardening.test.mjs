// M6 / m11 / m12 — limitation de débit, verrouillage du changement de PIN,
// purge des sessions expirées et rétention du journal d'authentification.
import assert from 'node:assert/strict'
import { AuthStore,hashServerPin } from '../../server/auth-store.mjs'
import { createAuthServer } from '../../server/http.mjs'
import { createServer } from 'node:net'
import http from 'node:http'

let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

const build=async({maxAttempts=20}={})=>{
  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
  const origin=`http://127.0.0.1:${port}`
  process.env.AUTH_MAX_LOGIN_ATTEMPTS=String(maxAttempts)
  const server=createAuthServer({store,origin})
  await new Promise(r=>server.listen(port,'127.0.0.1',r))
  const close=async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close()}
  return {store,server,origin,close}
}

const post=(origin,path,body)=>new Promise(resolve=>{
  const payload=JSON.stringify(body)
  const req=http.request({host:'127.0.0.1',port:new URL(origin).port,path,method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text,headers:res.headers}))
  })
  req.on('error',e=>resolve({status:0,body:e.message,headers:{}}));req.write(payload);req.end()
})

// ---------- M6 : limitation par origine réseau ----------
{
  const {store,origin,close}=await build({maxAttempts:5})
  try{
    await check('M6 : au-delà du seuil, la connexion est refusée avec Retry-After',async()=>{
      const statuses=[]
      for(let i=0;i<7;i++)statuses.push((await post(origin,'/api/auth/login',{username:'chef',pin:'0000'})).status)
      assert(statuses.includes(429),`statuts : ${statuses.join(',')}`)
      assert.equal(statuses.at(-1),429,'la dernière tentative devait être bloquée')
    })

    await check('M6 : l’en-tête Retry-After est présent et positif',async()=>{
      const response=await post(origin,'/api/auth/login',{username:'chef',pin:'0000'})
      assert.equal(response.status,429)
      assert(Number(response.headers['retry-after'])>0,`Retry-After : ${response.headers['retry-after']}`)
    })

    await check('M6 : le verrouillage de compte renvoie aussi Retry-After',async()=>{
      const response=await post(origin,'/api/auth/login',{username:'chef',pin:'0000'})
      assert.equal(response.status,429)
      assert(Number(response.headers['retry-after'])>0)
    })

    await check('M6 : un succès remet le compteur à zéro',async()=>{
      const fresh=await build({maxAttempts:5})
      try{
        for(let i=0;i<4;i++)await post(fresh.origin,'/api/auth/login',{username:'chef',pin:'0000'})
        // Le compte est verrouillé par échecs : on libère le verrou côté base.
        fresh.store.sql.prepare('UPDATE accounts SET failures=0,locked_until=0').run()
        const good=await post(fresh.origin,'/api/auth/login',{username:'chef',pin:'1234'})
        assert.equal(good.status,200,good.body)
        const after=await post(fresh.origin,'/api/auth/login',{username:'chef',pin:'0000'})
        assert.notEqual(after.status,429,'compteur non réinitialisé après succès')
      }finally{await fresh.close()}
    })
  }finally{await close()}
}

// ---------- m12 : purge des sessions ----------
await check('m12 : sweep supprime les sessions expirées et garde les vivantes',async()=>{
  let clock=Date.now()
  const store=new AuthStore(':memory:',{now:()=>clock,ttlMs:1000})
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const old=await store.login('chef','1234')
  clock+=2000
  const fresh=await store.login('chef','1234')
  const removed=store.sweep()
  assert.equal(removed.sessions,1,`sessions supprimées : ${removed.sessions}`)
  const remaining=store.sql.prepare('SELECT COUNT(*) n FROM sessions').get().n
  assert.equal(remaining,1)
  assert.equal(store.authenticate(fresh.token).id,'a1')
  assert.throws(()=>store.authenticate(old.token),e=>e.status===401)
  store.close()
})

await check('m12 : authenticate supprime la ligne expirée rencontrée',async()=>{
  let clock=Date.now()
  const store=new AuthStore(':memory:',{now:()=>clock,ttlMs:1000})
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const session=await store.login('chef','1234')
  clock+=1500
  assert.throws(()=>store.authenticate(session.token),e=>e.status===401)
  assert.equal(store.sql.prepare('SELECT COUNT(*) n FROM sessions').get().n,0)
  store.close()
})

await check('m12 : le journal perd les entrées au-delà de la rétention',async()=>{
  let clock=Date.now()
  const store=new AuthStore(':memory:',{now:()=>clock,ttlMs:3600000})
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  await store.login('chef','1234')
  const before=store.sql.prepare('SELECT COUNT(*) n FROM auth_audit').get().n
  assert(before>=1)
  clock+=181*86400000
  const removed=store.sweep({auditKeepDays:180})
  assert.equal(removed.audit,before)
  assert.equal(store.sql.prepare('SELECT COUNT(*) n FROM auth_audit').get().n,0)
  store.close()
})

// ---------- m11 : le changement de PIN compte les échecs ----------
await check('m11 : quatre mauvais PIN actuels verrouillent le changement',async()=>{
  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const session=await store.login('chef','1234')
  const codes=[]
  for(let i=0;i<4;i++)codes.push(await store.changePin(session.token,'0000','5678').then(()=>200,e=>e.status))
  assert.equal(codes.filter(code=>code===403).length,3,`403 attendus x3 : ${codes.join(',')}`)
  assert.equal(codes[3],429,`le 4e échec doit verrouiller : ${codes.join(',')}`)
  await assert.rejects(()=>store.changePin(session.token,'1234','5678'),e=>e.status===429)
  const row=store.sql.prepare("SELECT pin_hash,generation FROM accounts WHERE id='a1'").get()
  assert.equal(row.pin_hash,pin.hash,'le PIN a été modifié malgré le verrouillage')
  assert.equal(row.generation,1,'la génération de session a bougé malgré le verrouillage')
  // Un verrouillage anti-force-brute ne révoque PAS une session déjà ouverte :
  // seule une modification effective du PIN incrémente la génération.
  assert.equal(store.authenticate(session.token).id,'a1')
  store.close()
})

console.log(`M6 HARDENING: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
