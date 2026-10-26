import { convert, Sql, openSql } from '/tmp/v196run/mon-parking-v19.6/server/sql.mjs'
let pass=0, fail=0
const ok=(name,cond,info='')=>{ if(cond){pass++;console.log('ok   '+name)} else {fail++;console.log('FAIL '+name+' '+info)} }

// --- A. conversion des marqueurs ---
ok('convert ? -> $1,$2', convert('SELECT * FROM t WHERE a=? AND b=?')==='SELECT * FROM t WHERE a=$1 AND b=$2', convert('SELECT * FROM t WHERE a=? AND b=?'))
ok('convert ignore le ? dans une chaine', convert("SELECT * FROM t WHERE a='?' AND b=?")==="SELECT * FROM t WHERE a='?' AND b=$1", convert("SELECT * FROM t WHERE a='?' AND b=?"))
ok('convert ignore le commentaire', convert("-- a?b\nSELECT ?")==='-- a?b\nSELECT $1', JSON.stringify(convert("-- a?b\nSELECT ?")))
ok('convert gere $$', convert("SELECT $$?$$, ?")==='SELECT $$?$$, $1', convert("SELECT $$?$$, ?"))

// --- B. connexion ---
const url=process.env.DATABASE_URL
const { sql, close } = await openSql({ connectionString:url, ssl:false })
const ts=Date.now()
ok('BIGINT accepte un horodatage ms', !!await sql.one('SELECT $1::bigint AS v',[ts]))

// --- C. CRUD asynchrone ---
// Jeu de test isolé : préfixe T-, purge préalable, pour rester valable sur une
// base déjà migrée (sinon les comptes réels perturbent les assertions).
await sql.run("DELETE FROM sessions WHERE token_hash LIKE 'T-%'")
await sql.run("DELETE FROM login_attempts WHERE key LIKE 'T-%'")
await sql.run("DELETE FROM accounts WHERE lot_id='T-L1'")
await sql.run("DELETE FROM lots WHERE id='T-L1'")
await sql.run("INSERT INTO lots(id,profile) VALUES($1,$2)",['T-L1',JSON.stringify({name:'Auto Prestige',currency:'XOF'})])
await sql.run("INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
  ['T-A1','T-A1','T-ADMIN','Kouadio Yao','admin','T-L1','pbkdf2-sha256$600000$aa','bb'])
const row=await sql.one("SELECT * FROM accounts WHERE lower(username)=lower($1) AND lot_id=$2",['t-admin','T-L1'])
// Assertion corrigée : l'identifiant inséré est T-A1 (jeu de test préfixé).
ok('lecture insensible a la casse (ex-COLLATE NOCASE)', row?.id==='T-A1', JSON.stringify(row))
ok('colonne ajoutee phone par defaut', row?.phone==='')
const admin=await sql.one("SELECT count(*)::int AS n FROM accounts WHERE role='admin' AND active=1")
ok('requete de /readyz executable telle quelle', Number.isInteger(admin.n), String(admin.n))
ok('/readyz : compte admin actif', admin.n>=1, String(admin.n))

// --- D. upsert login_attempts (remplace INSERT ... ON CONFLICT de SQLite) ---
await sql.run('INSERT INTO login_attempts(key,count,reset) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=excluded.count,reset=excluded.reset',['T-k',ts+900000])
await sql.run('UPDATE login_attempts SET count=count+1 WHERE key=$1',['T-k'])
ok('compteur de tentatives increment', (await sql.one('SELECT count FROM login_attempts WHERE key=$1',['T-k'])).count===2)

// --- E. contraintes CHECK / unicite portees depuis SQLite ---
let rejected=false
try{ await sql.run("UPDATE accounts SET active=5 WHERE id='T-A1'") }catch{ rejected=true }
ok('CHECK active IN (0,1) refuse 5', rejected)
let dup=false
try{ await sql.run("INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt) VALUES('T-A2','T-A2','T-ADMIN','x','admin','T-L1','h','s')") }catch{ dup=true }
ok('unicite (lower(username),lot_id) refuse le doublon', dup)

// --- F. transaction : rollback réel ---
try{ await sql.transaction(async tx=>{ await tx.run("UPDATE accounts SET name='MODIFIE' WHERE id='T-A1'"); throw new Error('abort') }) }catch{}
ok('ROLLBACK annule l ecriture', (await sql.one("SELECT name FROM accounts WHERE id='T-A1'")).name==='Kouadio Yao')

// --- G. sweep : rowCount ---
await sql.run("INSERT INTO sessions(token_hash,account_id,generation,created,expires) VALUES('T-old','T-A1',1,$1,$2)",[ts-1000,ts-500])
const swept=await sql.run("DELETE FROM sessions WHERE expires<=$1 AND token_hash='T-old'",[ts])
ok('sweep renvoie changes=1', swept.changes===1, String(swept.changes))

console.log(`\nPORTAGE SQL : ${pass} passed / ${fail} failed`)
await close()
process.exit(fail?1:0)
