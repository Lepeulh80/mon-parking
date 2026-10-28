// M3 — identifiant ambigu entre deux parkings.
// Défaut v12 : « SELECT … WHERE username=? ORDER BY id LIMIT 1 » choisissait
// silencieusement un compte. Avec des PIN distincts, l'administrateur du second
// parking ne pouvait jamais se connecter.
// M5 — l'authentification locale morte (login, verifyPin, createLotWithAdmin)
// restait dans le bundle comme chemin de contournement du serveur.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthStore,hashServerPin } from '../../server/auth-store.mjs'

const root=new URL('../../',import.meta.url).pathname
let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

// ---------- M5 : plus aucun chemin d'authentification local ----------
await check('M5 : db.js n’exporte plus login/verifyPin/createLotWithAdmin',async()=>{
  const source=readFileSync(join(root,'src','lib','db.js'),'utf8')
  for(const name of ['export async function login','export async function verifyPin','export async function createLotWithAdmin','function legacyFallbackHash','function sha256Hex']){
    assert(!source.includes(name),`${name} toujours présent`)
  }
})

await check('M5 : aucun écran n’importe une authentification locale',async()=>{
  const source=readFileSync(join(root,'src','screens','Auth.jsx'),'utf8')
  assert(/from '\.\.\/lib\/authSession'/.test(source),'Auth.jsx doit passer par le serveur')
  assert(!/\blogin\(/.test(source),'Auth.jsx appelle encore le login local')
})

// ---------- M3 : identifiant ambigu ----------
// Le refus peut survenir a l'import (magasin PostgreSQL) ou a la connexion
// (magasin SQLite historique) : dans les deux cas un identifiant partage par
// deux comptes ne doit JAMAIS permettre d'entrer. On assertit le refus, pas
// son emplacement.
await check('M3 : deux comptes distincts avec le même identifiant sont refusés',async()=>{
  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1111')
  let refused=false
  try{
    await store.importTrusted({lots:[{id:'L1',name:'Un'},{id:'L2',name:'Deux'}],users:[
      {id:'a1',lotId:'L1',username:'dup',name:'Dup Un',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt},
      {id:'a2',lotId:'L2',username:'dup',name:'Dup Deux',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  }catch(e){ refused = e.status===409 || /already used by another principal/i.test(e.message) }
  if(!refused) await assert.rejects(async()=>store.login('dup','1111'),e=>e.status===409)
  store.close()
})

await check('M3 : createUser refuse un identifiant déjà utilisé, même dans un autre parking',async()=>{
  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1234')
  await store.importTrusted({lots:[{id:'L1',name:'Un'},{id:'L2',name:'Deux'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const second=await store.login('chef','1234')
  const lot2=await store.createLot(second.token,{name:'Deuxième parc'})
  // Hors du parc courant : refus (403) ou conflit (409), jamais une creation.
  await assert.rejects(
    async()=>store.createUser(second.token,{lotId:lot2.lot.id,name:'Homonyme',username:'chef',pin:'2222',role:'caissier'}),
    e=>e.status===403||e.status===409)
  // Dans le parc autorise, l'homonyme est explicitement en conflit.
  const scoped=await store.login('chef','1234',undefined,lot2.lot.id)
  await assert.rejects(
    async()=>store.createUser(scoped.token,{lotId:lot2.lot.id,name:'Homonyme',username:'chef',pin:'2222',role:'caissier'}),
    e=>e.status===409)
  store.close()
})

await check('M3 : un même compte multi-parkings reste connectable, et le parking peut être précisé',async()=>{
  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un',code:'PARA'},{id:'L2',name:'Deux',code:'PARB'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const session=await store.login('chef','1234')
  const created=store.createLot(session.token,{name:'Deuxième parc'})
  assert.equal(created.lot.id!==undefined,true)
  const relog=await store.login('chef','1234')
  assert.equal(relog.memberships.length,2,`adhésions : ${relog.memberships.length}`)
  const scoped=await store.login('chef','1234',undefined,'Deuxième parc')
  assert.equal(scoped.lot.name,'Deuxième parc')
  const byId=await store.login('chef','1234',undefined,created.lot.id)
  assert.equal(byId.lot.id,created.lot.id)
  store.close()
})

await check('M3 : un parking inexistant ne laisse pas fuiter d’information',async()=>{
  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  await assert.rejects(()=>store.login('chef','1234',undefined,'AUTRE'),e=>e.status===401&&e.message==='Identifiants incorrects.')
  store.close()
})

console.log(`M3/M5 IDENTITY: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
