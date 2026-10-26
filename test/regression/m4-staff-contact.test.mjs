// M4 — téléphone et e-mail du personnel réellement persistés.
// Défaut v12 : l'API acceptait phone/email, l'interface les envoyait, mais la
// table accounts n'avait pas ces colonnes et l'UPDATE ne les écrivait pas :
// la modification paraissait réussie et n'était jamais enregistrée.
import assert from 'node:assert/strict'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthStore,hashServerPin } from '../../server/auth-store.mjs'

let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

const dir=await mkdtemp(join(tmpdir(),'mp-m4-')),dbPath=join(dir,'auth.sqlite')
const pin=await hashServerPin('1234')
let store=new AuthStore(dbPath)
store.importTrusted({
  lots:[{id:'LOT-A',name:'Parc A'}],
  users:[{id:'admin-1',lotId:'LOT-A',username:'admin',name:'Admin',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt,phone:'+225 07 00 00 00',email:'admin@parc.ci'}],
})

try{
  await check('Les colonnes existent dans le schéma',async()=>{
    const columns=store.sql.prepare('PRAGMA table_info(accounts)').all().map(c=>c.name)
    for(const name of ['phone','email'])assert(columns.includes(name),`colonne manquante : ${name}`)
  })

  await check('L’import initial conserve les coordonnées',async()=>{
    const row=store.sql.prepare("SELECT phone,email FROM accounts WHERE id='admin-1'").get()
    assert.equal(row.phone,'+225 07 00 00 00')
    assert.equal(row.email,'admin@parc.ci')
  })

  const session=await store.login('admin','1234')
  await check('Le profil renvoyé au client contient phone et email',async()=>{
    assert.equal(session.user.phone,'+225 07 00 00 00')
    assert.equal(session.user.email,'admin@parc.ci')
  })

  await check('Création d’un employé : coordonnées enregistrées',async()=>{
    const created=await store.createUser(session.token,{lotId:'LOT-A',name:'Aminata Diallo',username:'aminata',pin:'1111',role:'caissier',phone:'+225 05 11 22 33',email:'aminata@parc.ci'})
    assert.equal(created.phone,'+225 05 11 22 33')
    assert.equal(created.email,'aminata@parc.ci')
    const row=store.sql.prepare('SELECT phone,email FROM accounts WHERE id=?').get(created.id)
    assert.equal(row.phone,'+225 05 11 22 33','valeur absente de la base')
    assert.equal(row.email,'aminata@parc.ci')
  })

  await check('Modification : la valeur est bien écrite, plus seulement acceptée',async()=>{
    const id=store.sql.prepare("SELECT id FROM accounts WHERE username='aminata'").get().id
    const updated=await store.updateUser(session.token,id,{phone:'+225 01 99 88 77',email:'a.diallo@parc.ci'})
    assert.equal(updated.phone,'+225 01 99 88 77')
    assert.equal(updated.email,'a.diallo@parc.ci')
    const row=store.sql.prepare('SELECT phone,email FROM accounts WHERE id=?').get(id)
    assert.equal(row.phone,'+225 01 99 88 77')
    assert.equal(row.email,'a.diallo@parc.ci')
  })

  await check('Le changement survit à une réouverture de la base (SQLite réel)',async()=>{
    store.close()
    store=new AuthStore(dbPath)
    const row=store.sql.prepare("SELECT phone,email FROM accounts WHERE username='aminata'").get()
    assert.equal(row.phone,'+225 01 99 88 77')
    assert.equal(row.email,'a.diallo@parc.ci')
  })

  await check('Un patch sans phone/email ne les efface pas',async()=>{
    const id=store.sql.prepare("SELECT id FROM accounts WHERE username='aminata'").get().id
    const fresh=await store.login('admin','1234')
    const updated=await store.updateUser(fresh.token,id,{name:'Aminata D.'})
    assert.equal(updated.name,'Aminata D.')
    assert.equal(updated.phone,'+225 01 99 88 77','téléphone effacé par un patch partiel')
    assert.equal(updated.email,'a.diallo@parc.ci','e-mail effacé par un patch partiel')
  })

  await check('Une adresse e-mail invalide est refusée (400), pas ignorée',async()=>{
    const id=store.sql.prepare("SELECT id FROM accounts WHERE username='aminata'").get().id
    const fresh=await store.login('admin','1234')
    await assert.rejects(()=>store.updateUser(fresh.token,id,{email:'pas-un-email'}),e=>e.status===400)
    assert.equal(store.sql.prepare('SELECT email FROM accounts WHERE id=?').get(id).email,'a.diallo@parc.ci')
  })

  await check('Un téléphone démesuré est refusé (400)',async()=>{
    const id=store.sql.prepare("SELECT id FROM accounts WHERE username='aminata'").get().id
    const fresh=await store.login('admin','1234')
    await assert.rejects(()=>store.updateUser(fresh.token,id,{phone:'0'.repeat(41)}),e=>e.status===400)
  })

  await check('La migration ajoute les colonnes à une base v12 existante',async()=>{
    const legacyPath=join(dir,'legacy.sqlite')
    const { DatabaseSync }=await import('node:sqlite')
    const legacy=new DatabaseSync(legacyPath)
    legacy.exec(`CREATE TABLE lots(id TEXT PRIMARY KEY,profile TEXT NOT NULL);
     CREATE TABLE accounts(id TEXT PRIMARY KEY,principal TEXT NOT NULL,username TEXT NOT NULL COLLATE NOCASE,name TEXT NOT NULL,role TEXT NOT NULL,lot_id TEXT NOT NULL REFERENCES lots(id),active INTEGER NOT NULL DEFAULT 1,pin_hash TEXT NOT NULL,pin_salt TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,failures INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,UNIQUE(username,lot_id));
     CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,generation INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
     CREATE TABLE auth_audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT NOT NULL,target TEXT,at INTEGER NOT NULL);`)
    const legacyPin=await hashServerPin('1234')
    legacy.prepare("INSERT INTO lots VALUES('LOT-L','{}')").run()
    legacy.prepare('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt) VALUES(?,?,?,?,?,?,?,?)').run('old-1','old-1','ancien','Ancien','admin','LOT-L',legacyPin.hash,legacyPin.salt)
    legacy.close()

    const migrated=new AuthStore(legacyPath)
    try{
      const columns=migrated.sql.prepare('PRAGMA table_info(accounts)').all().map(c=>c.name)
      assert(columns.includes('phone')&&columns.includes('email'),'colonnes non ajoutées')
      assert.equal(migrated.sql.prepare("SELECT phone,email FROM accounts WHERE id='old-1'").get().phone,'')
      const restored=await migrated.login('ancien','1234')
      assert.equal(restored.user.phone,'')
    }finally{migrated.close()}
  })
}finally{
  try{store.close()}catch{/* déjà fermé */}
  await rm(dir,{recursive:true,force:true})
}

console.log(`M4 STAFF CONTACT: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
