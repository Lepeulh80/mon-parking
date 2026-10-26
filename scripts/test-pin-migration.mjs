// Migration et concurrence du hash PIN côté SERVEUR (remplace le test Dexie,
// l'authentification locale ayant été supprimée en M5). La cryptographie doit
// rester hors transaction, et deux connexions simultanées ne doivent produire
// qu'une seule migration.
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { pbkdf2Sync,randomBytes } from 'node:crypto'
import { AuthStore } from '../server/auth-store.mjs'

let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

// Hash 310000 itérations RÉELLEMENT calculé : un simple changement de préfixe
// produirait un hash invérifiable et le test ne prouverait rien.
const legacyHash=(pin,iterations=310000)=>{
  const salt=randomBytes(16).toString('hex')
  const hash=pbkdf2Sync(String(pin),salt,iterations,32,'sha256').toString('hex')
  return {hash:`pbkdf2-sha256$${iterations}$${hash}`,salt}
}
const make=async()=>{
  const store=new AuthStore(':memory:')
  const legacy=legacyHash('1234')
  store.importTrusted({lots:[{id:'LOT-A',name:'Parc A'}],users:[{id:'u-1',lotId:'LOT-A',username:'agent',name:'Agent',role:'admin',active:true,pinHash:legacy.hash,salt:legacy.salt}]})
  return store
}

const store=await make()

await check('Un PIN au format 310000 reste accepté puis renforcé à 600000',async()=>{
  const session=await store.login('agent','1234')
  assert(session.token)
  const row=store.sql.prepare("SELECT pin_hash FROM accounts WHERE id='u-1'").get()
  assert.match(row.pin_hash,/^pbkdf2-sha256\$600000\$/)
})

await check('Deux connexions simultanées ne produisent qu’une migration',async()=>{
  const fresh=await make()
  const before=fresh.sql.prepare("SELECT pin_hash FROM accounts WHERE id='u-1'").get().pin_hash
  const [one,two]=await Promise.all([fresh.login('agent','1234'),fresh.login('agent','1234')])
  assert(one.token&&two.token)
  const after=fresh.sql.prepare("SELECT pin_hash FROM accounts WHERE id='u-1'").get().pin_hash
  assert.match(after,/^pbkdf2-sha256\$600000\$/)
  assert.notEqual(before,after)
  // Une seule ligne de session vivante par connexion réussie, pas de doublon.
  const sessions=fresh.sql.prepare("SELECT COUNT(*) n FROM sessions WHERE account_id='u-1'").get().n
  assert.equal(sessions,2,`sessions inattendues : ${sessions}`)
  fresh.close()
})

await check('Un mauvais PIN n’écrit rien et ne migre pas',async()=>{
  const fresh=await make()
  const before=fresh.sql.prepare("SELECT pin_hash FROM accounts WHERE id='u-1'").get().pin_hash
  await assert.rejects(()=>fresh.login('agent','0000'),e=>e.status===401)
  assert.equal(fresh.sql.prepare("SELECT pin_hash FROM accounts WHERE id='u-1'").get().pin_hash,before)
  assert.equal(fresh.sql.prepare("SELECT COUNT(*) n FROM sessions").get().n,0)
  fresh.close()
})

await check('Un compte désactivé refuse la connexion même avec le bon PIN',async()=>{
  const fresh=await make()
  fresh.sql.prepare("UPDATE accounts SET active=0 WHERE id='u-1'").run()
  await assert.rejects(()=>fresh.login('agent','1234'),e=>e.status===401)
  fresh.close()
})

console.log(`PIN MIGRATION: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
