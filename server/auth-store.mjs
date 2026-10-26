import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv, pbkdf2 as pbkdf2Callback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdirSync, chmodSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { generateSecret, generateBackupCodes, hashBackupCode, otpauthUrl, verifyTotp, DIGITS, STEP_MS } from './totp.mjs'
const pbkdf2=promisify(pbkdf2Callback),digest=s=>createHash('sha256').update(s).digest('hex')
const ROLES=new Set(['admin','responsable','caissier','agent','employe'])
// Normalisation stricte : toute valeur ambiguë est refusée plutôt que convertie
// silencieusement, sinon un « 0 » désactive un compte sans passer par les gardes.
function parseActive(value){
 if(value===true||value===1||value==='1'||value==='true')return true
 if(value===false||value===0||value==='0'||value==='false')return false
 throw new AuthError(400,'Valeur « active » invalide : booléen attendu.')
}
const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)}
// ---------------------------------------------------------------------------
// v19.1 — Clé de scellement des secrets TOTP.
// Le PIN est haché (PBKDF2 600 000) mais le secret TOTP était stocké EN CLAIR :
// une copie de la base (sauvegarde, rsync, dump envoyé par mail) permettait de
// générer des codes valides à vie, donc de contourner le second facteur.
// Priorité : AUTH_2FA_KEY (32 octets base64, à fournir par le KMS/le coffre du
// déploiement) ; sinon un fichier auth-store.key (0600) à côté de la base.
// Ce fichier reste sur le même disque que la base : il protège contre une fuite
// de la SEULE base, pas contre la copie du volume entier — c'est écrit ici.
const SECRET_PREFIX='v1:'
function loadSecretKey(path){
 if(process.env.AUTH_2FA_KEY){
  const raw=Buffer.from(String(process.env.AUTH_2FA_KEY),'base64')
  if(raw.length!==32)throw new Error('AUTH_2FA_KEY doit faire exactement 32 octets encodés en base64.')
  return raw
 }
 if(!path||path===':memory:')return randomBytes(32)
 const file=join(dirname(path),'auth-store.key')
 if(existsSync(file)){
  const text=readFileSync(file,'utf8').trim()
  const raw=/^[0-9a-f]{64}$/i.test(text)?Buffer.from(text,'hex'):Buffer.from(text,'base64')
  if(raw.length===32)return raw
  throw new Error(`${file} invalide : 32 octets attendus. Corrigez ou supprimez ce fichier (les secrets TOTP devront être réenrôlés).`)
 }
 if(process.env.NODE_ENV==='production')console.warn(`[auth] AUTH_2FA_KEY absent : clé de scellement générée dans ${file}. Ce fichier vit sur le même disque que la base — fournissez AUTH_2FA_KEY (32 octets base64) via le coffre du déploiement, et sauvegardez-la.`)
 const key=randomBytes(32)
 writeFileSync(file,key.toString('hex'),{mode:0o600});chmodSync(file,0o600)
 return key
}

export class AuthError extends Error { constructor(status,message){super(message);this.status=status} }
export async function hashServerPin(pin){
 if(!/^\d{4,12}$/.test(String(pin)))throw new AuthError(400,'PIN de 4 à 12 chiffres requis.')
 const salt=randomBytes(16).toString('hex'),hash=(await pbkdf2(String(pin),salt,600000,32,'sha256')).toString('hex')
 return {hash:`pbkdf2-sha256$600000$${hash}`,salt}
}
async function verify(pin,row){
 if(typeof pin!=='string'||pin.length>128)return false
 const match=/^pbkdf2-sha256\$(310000|600000)\$([a-f0-9]{64})$/.exec(row.pin_hash)
 if(match)return safeEqual((await pbkdf2(pin,row.pin_salt,Number(match[1]),32,'sha256')).toString('hex'),match[2])
 // v19.2 : les deux formats hérités (sha256×3 et FNV « fb… ») sont rapides à
 // casser hors ligne. Ils sont réécrits en PBKDF2 600 000 à la première
 // connexion réussie ; AUTH_DENY_LEGACY_PIN=1 permet de les refuser tout de
 // suite sur un parc déjà migré, au lieu d'attendre chaque connexion.
 if(process.env.AUTH_DENY_LEGACY_PIN==='1')return false
 let h=`${row.pin_salt}:${pin}`
 if(/^[a-f0-9]{64}$/.test(row.pin_hash)){for(let i=0;i<3;i++)h=digest(h);return safeEqual(h,row.pin_hash)}
 if(/^fb[a-f0-9]{2,16}$/.test(row.pin_hash)){
  for(let j=0;j<3;j++){let h1=0x811c9dc5,h2=0x1000193;for(let i=0;i<h.length;i++){h1=(h1^h.charCodeAt(i))*0x01000193;h2=(h2+h.charCodeAt(i)*(i+7))>>>0}h=`fb${(h1>>>0).toString(16)}${(h2>>>0).toString(16)}`}
  return safeEqual(h,row.pin_hash)
 }
 return false
}
export class AuthStore {
 constructor(path,{now=()=>Date.now(),ttlMs=8*3600000,hooks={}}={}){
  if(path!==':memory:'){mkdirSync(dirname(path),{recursive:true,mode:0o700})}
  this.sql=new DatabaseSync(path);this.now=now;this.ttlMs=ttlMs;this.hooks=hooks
  this.secretKey=loadSecretKey(path)
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1000)throw new Error('Invalid session lifetime')
  this.sql.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS lots(id TEXT PRIMARY KEY,profile TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,principal TEXT NOT NULL,username TEXT NOT NULL COLLATE NOCASE,name TEXT NOT NULL,role TEXT NOT NULL,lot_id TEXT NOT NULL REFERENCES lots(id),active INTEGER NOT NULL DEFAULT 1,pin_hash TEXT NOT NULL,pin_salt TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,failures INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,UNIQUE(username,lot_id));
   CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),generation INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS session_account ON sessions(account_id);
   CREATE TABLE IF NOT EXISTS auth_audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT NOT NULL,target TEXT,at INTEGER NOT NULL);`)
  // Migration additive : les colonnes de contact sont désormais réellement
  // stockées. Sans cela l'API acceptait phone/email puis les jetait (m4 v12).
  const columns=new Set(this.sql.prepare('PRAGMA table_info(accounts)').all().map(column=>column.name))
  for(const [name,definition] of [
   ['phone',"TEXT NOT NULL DEFAULT ''"],['email',"TEXT NOT NULL DEFAULT ''"],
   // v19 : second facteur TOTP (RFC 6238). Le secret n'est jamais renvoyé au
   // client après l'enrôlement ; `totp_last_step` bloque le rejeu d'un code.
   ['totp_secret',"TEXT NOT NULL DEFAULT ''"],['totp_active',"INTEGER NOT NULL DEFAULT 0"],
   ['totp_last_step',"INTEGER NOT NULL DEFAULT 0"],['totp_backup',"TEXT NOT NULL DEFAULT '[]'"],
   ['totp_failures',"INTEGER NOT NULL DEFAULT 0"],['totp_locked_until',"INTEGER NOT NULL DEFAULT 0"]]){
   // Revue de sécurité v19.4 : le nom de colonne était interpolé sans contrôle.
   // La liste ci-dessus est littérale, mais rien n'empêchait une future entrée
   // dynamique d'atteindre le DDL. On valide désormais l'identifiant et on
   // refuse tout ce qui n'est pas un nom simple, avant toute exécution.
   if(!/^[a-z][a-z0-9_]{0,30}$/.test(name))throw new Error(`Colonne de migration invalide : ${String(name)}`)
   if(!/^(TEXT|INTEGER|REAL|BLOB)\b/.test(definition))throw new Error(`Définition de colonne invalide pour ${name}`)
   if(!columns.has(name))this.sql.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${definition}`)
  }
  // v19.1 : tout secret TOTP encore en clair est scellé immédiatement.
  this.reencryptTotpSecrets()
  this.sql.exec('CREATE INDEX IF NOT EXISTS auth_audit_at ON auth_audit(at)')
  // v16 : le compteur de tentatives de connexion survit au redemarrage.
  // Avant, une map en memoire etait videe a chaque redemarrage du processus.
  this.sql.exec('CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset INTEGER NOT NULL)')
  // v19 : défi de second facteur. Stocké haché, à usage unique, 5 minutes.
  this.sql.exec('CREATE TABLE IF NOT EXISTS login_challenges(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL,principal TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL)')
  this.sql.exec('CREATE INDEX IF NOT EXISTS login_challenges_account ON login_challenges(account_id)')
  // Purge immédiate au démarrage : la table sessions ne doit pas croître sans fin.
  try{this.sweep()}catch{/* une base en lecture seule ne doit pas empêcher le démarrage */}
  if(path!==':memory:')chmodSync(path,0o600)
 }

 // v16 : limitation de debit persistante (par origine reseau ou par compte).
 loginWait(key,max,windowMs=15*60000){
  const row=this.sql.prepare('SELECT count,reset FROM login_attempts WHERE key=?').get(key)
  if(!row)return 0
  const now=this.now()
  if(row.reset<=now){this.clearLoginFailures(key);return 0}
  return row.count>=max?Math.max(1,Math.ceil((row.reset-now)/1000)):0
 }
 noteLoginFailure(key,max,windowMs=15*60000){
  const now=this.now()
  const row=this.sql.prepare('SELECT count,reset FROM login_attempts WHERE key=?').get(key)
  if(!row||row.reset<=now)this.sql.prepare('INSERT INTO login_attempts(key,count,reset) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,reset=excluded.reset').run(key,now+windowMs)
  else this.sql.prepare('UPDATE login_attempts SET count=count+1 WHERE key=?').run(key)
 }
 clearLoginFailures(key){this.sql.prepare('DELETE FROM login_attempts WHERE key=?').run(key)}
 // M6/m12 : purge des sessions expirées et du journal au-delà de la rétention.
 sweep({auditKeepDays=180}={}){
  const now=this.now()
  const sessions=this.sql.prepare('DELETE FROM sessions WHERE expires<=?').run(now).changes
  const audit=this.sql.prepare('DELETE FROM auth_audit WHERE at<?').run(now-auditKeepDays*86400000).changes
  const attempts=this.sql.prepare('DELETE FROM login_attempts WHERE reset<=?').run(now).changes
  const challenges=this.sql.prepare('DELETE FROM login_challenges WHERE expires<=?').run(now).changes
  // Compteur exposé pour que l'exploitant sache s'il reste des hachages faibles.
  let legacyPins=0
  try{legacyPins=this.sql.prepare("SELECT COUNT(*) n FROM accounts WHERE pin_hash NOT LIKE 'pbkdf2-sha256$600000$%'").get().n}catch{legacyPins=0}
  return {sessions,audit,attempts,challenges,legacyPins}
 }
 transaction(fn){this.sql.exec('BEGIN IMMEDIATE');try{const value=fn();this.sql.exec('COMMIT');return value}catch(e){this.sql.exec('ROLLBACK');throw e}}
 audit(actor,action,target){this.sql.prepare('INSERT INTO auth_audit VALUES(?,?,?,?,?)').run(randomUUID(),actor||null,action,target||null,this.now())}
 importTrusted({lots,users}){
  if(this.sql.prepare('SELECT COUNT(*) n FROM accounts').get().n)throw new Error('Import allowed only into an empty auth database')
  this.transaction(()=>{
   for(const lot of lots){if(!lot.id)throw new Error('Missing lot id');this.sql.prepare('INSERT INTO lots VALUES(?,?)').run(lot.id,JSON.stringify(lot))}
   const principals=new Map(),owners=new Map()
   for(const user of users){
    if(!user.id||!user.username||!ROLES.has(user.role)||!user.pinHash||!user.salt)throw new Error('Invalid trusted user import')
    const key=`${user.username.toLowerCase()}:${user.pinHash}:${user.salt}`,principal=principals.get(key)||user.id;principals.set(key,principal)
    const username=user.username.toLowerCase(),owner=owners.get(username)
    if(owner&&owner!==principal)throw new Error(`Username ${username} is already used by another principal`)
    owners.set(username,principal)
    this.sql.prepare('INSERT INTO accounts(id,principal,username,name,role,lot_id,active,pin_hash,pin_salt,phone,email) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(user.id,principal,user.username.toLowerCase(),user.name||user.username,user.role,user.lotId,user.active?1:0,user.pinHash,user.salt,String(user.phone||''),String(user.email||''))
   }
  })
 }
 profile(row){return {id:row.id,username:row.username,name:row.name,role:row.role,lotId:row.lot_id,active:!!row.active,phone:row.phone||'',email:row.email||'',mfaEnabled:!!row.totp_active,authVersion:row.generation,serverAuthenticated:true}}
 identity(row){
  const members=this.sql.prepare('SELECT * FROM accounts WHERE principal=? AND active=1').all(row.principal)
  return {user:this.profile(row),mfa:this.mfaState(row),lot:JSON.parse(this.sql.prepare('SELECT profile FROM lots WHERE id=?').get(row.lot_id).profile),memberships:members.map(r=>({user:this.profile(r),lot:JSON.parse(this.sql.prepare('SELECT profile FROM lots WHERE id=?').get(r.lot_id).profile)}))}
 }
 issue(row,oldToken){
  if(oldToken)this.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(oldToken))
  const token=randomBytes(32).toString('base64url'),expires=this.now()+this.ttlMs
  this.sql.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(digest(token),row.id,row.generation,this.now(),expires)
  this.audit(row.id,'login',row.id)
  return {token,expires,...this.identity(row)}
 }
 async login(username,pin,oldToken,lotRef){
  if(typeof username!=='string'||username.length>120)throw new AuthError(401,'Identifiants incorrects.')
  const candidates=this.sql.prepare('SELECT * FROM accounts WHERE username=?').all(username.trim().toLowerCase())
  if(!candidates.length)throw new AuthError(401,'Identifiants incorrects.')
  // M3 : deux comptes DISTINCTS partageant le même identifiant rendaient la
  // connexion arbitraire (le plus petit id gagnait, silencieusement). Les
  // multi-parkings d'un même principal restent, eux, parfaitement légitimes.
  if(new Set(candidates.map(account=>account.principal)).size>1)throw new AuthError(409,'Identifiant utilisé par plusieurs comptes : connexion refusée. Précisez le parking ou contactez votre administrateur.')
  let pool=candidates
  if(lotRef!==undefined&&lotRef!==null&&String(lotRef).trim()){
   const wanted=String(lotRef).trim().toLowerCase()
   pool=candidates.filter(account=>{
    if(account.lot_id.toLowerCase()===wanted)return true
    const profile=JSON.parse(this.sql.prepare('SELECT profile FROM lots WHERE id=?').get(account.lot_id).profile)
    return String(profile.code||'').toLowerCase()===wanted||String(profile.name||'').toLowerCase()===wanted
   })
   if(!pool.length)throw new AuthError(401,'Identifiants incorrects.')
  }
  let row=pool.find(account=>account.active)||pool[0]
  for(let n=0;n<3;n++){
   if(!row.active)throw new AuthError(401,'Identifiants incorrects.')
   if(row.locked_until>this.now()){
    const error=new AuthError(429,'Compte temporairement verrouillé. Réessayez plus tard.')
    error.retryAfter=Math.max(1,Math.ceil((row.locked_until-this.now())/1000))
    throw error
   }
   if(!await verify(pin,row)){
    this.sql.prepare('UPDATE accounts SET failures=failures+1,locked_until=CASE WHEN failures+1>=4 THEN ? ELSE locked_until END WHERE id=?').run(this.now()+60000,row.id)
    throw new AuthError(401,'Identifiants incorrects.')
   }
   const upgrade=row.pin_hash.startsWith('pbkdf2-sha256$600000$')?null:await hashServerPin(pin)
   await this.hooks.beforeLoginCommit?.(row)
   const result=this.transaction(()=>{
    const current=this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(row.id)
    if(!current?.active)throw new AuthError(401,'Identifiants incorrects.')
    if(current.generation!==row.generation||current.pin_hash!==row.pin_hash||current.pin_salt!==row.pin_salt)return {retry:current}
    if(upgrade){this.sql.prepare('UPDATE accounts SET pin_hash=?,pin_salt=? WHERE principal=?').run(upgrade.hash,upgrade.salt,current.principal);current.pin_hash=upgrade.hash;current.pin_salt=upgrade.salt}
    this.sql.prepare('UPDATE accounts SET failures=0,locked_until=0 WHERE id=?').run(current.id)
    // v19 : avec la 2FA active, le PIN ne suffit plus à ouvrir une session.
    return current.totp_active?this.beginChallenge(current):this.issue(current,oldToken)
   })
   if(!result.retry)return result
   row=result.retry
  }
  throw new AuthError(409,'Identifiants modifiés pendant la connexion. Réessayez.')
 }
 authenticate(token){
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))throw new AuthError(401,'Connexion requise.')
  const session=this.sql.prepare('SELECT * FROM sessions WHERE token_hash=?').get(digest(token))
  if(session&&session.expires<=this.now())this.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token))
  const row=session&&this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(session.account_id)
  if(!row?.active||!session||session.expires<=this.now()||session.generation!==row.generation)throw new AuthError(401,'Session expirée ou révoquée.')
  return row
 }
 logout(token){if(typeof token==='string')this.sql.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token))}
 revokePrincipal(principal){this.sql.prepare('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE principal=?)').run(principal)}
 async changePin(token,oldPin,newPin){
  const row=this.authenticate(token)
  if(row.locked_until>this.now())throw new AuthError(429,'Trop de tentatives. Réessayez plus tard.')
  if(!await verify(oldPin,row)){
   this.sql.prepare('UPDATE accounts SET failures=failures+1,locked_until=CASE WHEN failures+1>=4 THEN ? ELSE locked_until END WHERE id=?').run(this.now()+60000,row.id)
   const after=this.sql.prepare('SELECT failures FROM accounts WHERE id=?').get(row.id).failures
   throw new AuthError(after>=4?429:403,after>=4?'Trop de tentatives de PIN. Réessayez dans une minute.':'PIN actuel incorrect.')
  }
  const credentials=await hashServerPin(newPin)
  this.transaction(()=>{
   const current=this.authenticate(token)
   if(current.generation!==row.generation||current.pin_hash!==row.pin_hash)throw new AuthError(409,'Identifiants modifiés. Réessayez.')
   this.sql.prepare('UPDATE accounts SET pin_hash=?,pin_salt=?,generation=generation+1,failures=0,locked_until=0 WHERE principal=?').run(credentials.hash,credentials.salt,row.principal)
   this.revokePrincipal(row.principal);this.audit(row.id,'pin-change',row.id)
  })
 }
 async updateUser(token,id,patch){
  const actor=this.authenticate(token),target=this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(id)
  if(actor.role!=='admin'||!target||target.lot_id!==actor.lot_id)throw new AuthError(403,'Accès refusé.')
  if(Object.keys(patch).some(k=>!['pin','name','role','active','phone','email'].includes(k)))throw new AuthError(400,'Champ refusé.')
  if(patch.role!==undefined&&!ROLES.has(patch.role))throw new AuthError(400,'Rôle inconnu.')
  // « active » est normalisé AVANT le garde-fou : 0, '', null ou « false »
  // désactivaient le compte sans déclencher la protection du dernier admin.
  const nextActive=patch.active===undefined?undefined:parseActive(patch.active)
  const credentials=patch.pin!==undefined?await hashServerPin(patch.pin):null
  return this.transaction(()=>{
   const a=this.authenticate(token),u=this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(id)
   if(a.role!=='admin'||!u||u.lot_id!==a.lot_id)throw new AuthError(403,'Accès refusé.')
   const active=nextActive===undefined?!!u.active:nextActive,role=patch.role??u.role
   if(u.role==='admin'&&u.active&&(!active||role!=='admin')){
    const others=this.sql.prepare("SELECT COUNT(*) n FROM accounts WHERE lot_id=? AND role='admin' AND active=1 AND id<>?").get(u.lot_id,id).n
    if(others<1)throw new AuthError(409,'Dernier administrateur actif protégé.')
   }
   const phone=patch.phone===undefined?String(u.phone||''):String(patch.phone||'').trim()
   if(phone.length>40)throw new AuthError(400,'Téléphone trop long (40 caractères maximum).')
   const email=patch.email===undefined?String(u.email||''):String(patch.email||'').trim()
   if(email.length>160||(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))throw new AuthError(400,'Adresse e-mail invalide.')
   if(credentials){this.sql.prepare("UPDATE accounts SET pin_hash=?,pin_salt=?,generation=generation+1,totp_secret='',totp_active=0,totp_backup='[]',totp_last_step=0,totp_failures=0,totp_locked_until=0 WHERE principal=?").run(credentials.hash,credentials.salt,u.principal);this.revokePrincipal(u.principal)}
   if(nextActive!==undefined||patch.role!==undefined){this.sql.prepare('UPDATE accounts SET generation=generation+1 WHERE id=?').run(id);this.sql.prepare('DELETE FROM sessions WHERE account_id=?').run(id)}
   this.sql.prepare('UPDATE accounts SET name=?,role=?,active=?,phone=?,email=? WHERE id=?').run(String(patch.name??u.name),role,active?1:0,phone,email,id)
   this.audit(a.id,'account-update',id)
   return this.profile(this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(id))
  })
 }
 async createUser(token,body){
  const actor=this.authenticate(token)
  if(actor.role!=='admin'||body.lotId!==actor.lot_id)throw new AuthError(403,'Accès refusé.')
  if(!/^[a-z0-9._-]{3,120}$/i.test(body.username||'')||!String(body.name||'').trim()||!ROLES.has(body.role))throw new AuthError(400,'Compte invalide.')
  const existing=this.sql.prepare('SELECT DISTINCT principal FROM accounts WHERE username=?').all(String(body.username).toLowerCase())
  if(existing.length)throw new AuthError(409,'Cet identifiant est déjà utilisé.')
  const credentials=await hashServerPin(body.pin),id=randomUUID()
  return this.transaction(()=>{
   const a=this.authenticate(token);if(a.role!=='admin'||a.lot_id!==body.lotId)throw new AuthError(403,'Accès refusé.')
   this.sql.prepare('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt,phone,email) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,id,body.username.toLowerCase(),body.name,body.role,body.lotId,credentials.hash,credentials.salt,String(body.phone||'').trim(),String(body.email||'').trim())
   this.audit(a.id,'account-create',id);return this.profile(this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(id))
  })
 }
 createLot(token,body){return this.transaction(()=>{
  const a=this.authenticate(token);if(a.role!=='admin'||!String(body.name||'').trim())throw new AuthError(403,'Accès refusé.')
  const id=randomUUID(),profile={id,name:body.name,city:body.city||'',currency:body.currency||'XOF',code:String(body.name).slice(0,4).toUpperCase(),logo:body.logo||null,active:true,hourlyRate:500,dailyCap:6000,graceMinutes:15,invoiceNext:1,receiptNext:1,ticketNext:1}
  this.sql.prepare('INSERT INTO lots VALUES(?,?)').run(id,JSON.stringify(profile))
  const clash=this.sql.prepare('SELECT COUNT(*) n FROM accounts WHERE username=? AND principal<>?').get(a.username,a.principal).n
  if(clash)throw new AuthError(409,'Identifiant déjà utilisé par un autre compte.')
  const uid=randomUUID();this.sql.prepare('INSERT INTO accounts(id,principal,username,name,role,lot_id,pin_hash,pin_salt) VALUES(?,?,?,?,?,?,?,?)').run(uid,a.principal,a.username,a.name,'admin',id,a.pin_hash,a.pin_salt)
  this.audit(a.id,'lot-create',id);return {lot:profile,user:this.profile(this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(uid))}
 })}
 switchLot(token,lotId){return this.transaction(()=>{
  const a=this.authenticate(token),target=this.sql.prepare('SELECT * FROM accounts WHERE principal=? AND lot_id=? AND active=1').get(a.principal,lotId)
  if(!target)throw new AuthError(403,'Parking non autorisé.')
  return this.issue(target,token)
 })}
 // ---------------------------------------------------------------------------
 // 2FA TOTP
 // ---------------------------------------------------------------------------
 // Politique d'entreprise : AUTH_2FA_POLICY=off|admin|all. Elle ne bloque pas
 // la connexion d'elle-même (sinon un administrateur non enrôlé se verrouille
 // dehors) : elle expose `mfa.required` pour que l'interface impose l'enrôlement.
 mfaPolicy(){const value=String(process.env.AUTH_2FA_POLICY||'off').toLowerCase();return ['off','admin','all'].includes(value)?value:'off'}
 mfaRequiredFor(row){const policy=this.mfaPolicy();return policy==='all'||(policy==='admin'&&row.role==='admin')}
 mfaState(row){
  let backup=[]
  try{backup=JSON.parse(row.totp_backup||'[]')}catch{backup=[]}
  return {enabled:!!row.totp_active,policy:this.mfaPolicy(),required:this.mfaRequiredFor(row),backupRemaining:Array.isArray(backup)?backup.length:0,digits:DIGITS,period:STEP_MS/1000}
 }
 beginChallenge(row){
  const token=randomBytes(32).toString('base64url'),expires=this.now()+5*60000
  // Un seul défi vivant par compte : une nouvelle tentative invalide l'ancienne.
  this.sql.prepare('DELETE FROM login_challenges WHERE account_id=?').run(row.id)
  this.sql.prepare('INSERT INTO login_challenges VALUES(?,?,?,?,?,?)').run(digest(token),row.id,row.principal,expires,0,this.now())
  this.audit(row.id,'mfa-challenge',row.id)
  return {mfaRequired:true,challenge:token,expires}
 }
 completeMfa(challengeToken,code){
  const invalid=new AuthError(401,'Vérification expirée. Reconnectez-vous.')
  if(typeof challengeToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(challengeToken))throw invalid
  const key=digest(challengeToken)
  const challenge=this.sql.prepare('SELECT * FROM login_challenges WHERE token_hash=?').get(key)
  if(!challenge)throw invalid
  if(challenge.expires<=this.now()){this.sql.prepare('DELETE FROM login_challenges WHERE token_hash=?').run(key);throw invalid}
  const row=this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(challenge.account_id)
  if(!row?.active||!row.totp_active)throw invalid
  if(row.totp_locked_until>this.now()){
   const error=new AuthError(429,'Trop de codes erronés. Réessayez dans une minute.')
   error.retryAfter=Math.max(1,Math.ceil((row.totp_locked_until-this.now())/1000));throw error
  }
  if(challenge.attempts>=5){
   this.sql.prepare('DELETE FROM login_challenges WHERE token_hash=?').run(key)
   const error=new AuthError(429,'Trop de codes erronés. Reconnectez-vous.')
   error.retryAfter=60;throw error
  }
  const clean=String(code??'').replace(/[\s-]/g,'')
  let check=verifyTotp(this.secretOf(row),clean,{now:this.now(),lastStep:row.totp_last_step})
  let backupHash=null
  if(!check.ok){
   // Codes de secours : à usage unique, stockés uniquement hachés.
   let list=[]
   try{list=JSON.parse(row.totp_backup||'[]')}catch{list=[]}
   const hash=hashBackupCode(clean)
   // Comparaison à temps constant sur les empreintes (includes() sortait dès le
// premier caractère divergent, ce qui donnait un oracle de position).
   if(hash&&Array.isArray(list)&&list.some(stored=>safeEqual(String(stored),hash))){backupHash=hash;check={ok:true}}
  }
  if(!check.ok){
   this.sql.prepare('UPDATE login_challenges SET attempts=attempts+1 WHERE token_hash=?').run(key)
   // Décision prise en JS : un `CASE` d'UPDATE lit la valeur AVANT écriture et
   // laissait le compteur atteindre 5 sans verrouiller (même défaut qu'en v15).
   const failures=Number(row.totp_failures||0)+1
   if(failures>=5)this.sql.prepare('UPDATE accounts SET totp_failures=?,totp_locked_until=? WHERE id=?').run(failures,this.now()+60000,row.id)
   else this.sql.prepare('UPDATE accounts SET totp_failures=? WHERE id=?').run(failures,row.id)
   const error=new AuthError(failures>=5?429:401,failures>=5?'Trop de codes erronés. Réessayez dans une minute.':'Code de vérification incorrect.')
   if(failures>=5)error.retryAfter=60
   throw error
  }
  return this.transaction(()=>{
   const current=this.sql.prepare('SELECT * FROM accounts WHERE id=?').get(row.id)
   if(!current?.active||!current.totp_active||current.generation!==row.generation)throw invalid
   this.sql.prepare('DELETE FROM login_challenges WHERE token_hash=?').run(key)
   if(backupHash){
    let list=[]
    try{list=JSON.parse(current.totp_backup||'[]')}catch{list=[]}
    this.sql.prepare('UPDATE accounts SET totp_backup=? WHERE id=?').run(JSON.stringify(list.filter(h=>h!==backupHash)),current.id)
   }else{
    this.sql.prepare('UPDATE accounts SET totp_last_step=?,totp_failures=0,totp_locked_until=0 WHERE id=?').run(check.step,current.id)
   }
   this.audit(current.id,backupHash?'mfa-backup':'mfa-ok',current.id)
   return this.issue(current,null)
  })
 }
 enrollTotp(token){
  const row=this.authenticate(token)
  if(row.totp_active)throw new AuthError(409,'La double authentification est déjà active : désactivez-la avant de réenrôler.')
  const secret=generateSecret()
  this.sql.prepare('UPDATE accounts SET totp_secret=?,totp_last_step=0,totp_failures=0,totp_locked_until=0 WHERE id=?').run(this.sealSecret(secret),row.id)
  this.audit(row.id,'mfa-enroll-start',row.id)
  return {secret,otpauth:otpauthUrl({secret,account:row.username,issuer:'MON PARKING'}),digits:DIGITS,period:STEP_MS/1000,issuer:'MON PARKING'}
 }
 activateTotp(token,code){
  const row=this.authenticate(token)
  if(row.totp_active)throw new AuthError(409,'La double authentification est déjà active.')
  if(!this.secretOf(row))throw new AuthError(409,'Aucun enrôlement en cours : demandez d’abord un secret.')
  // v19.1 : l'activation n'avait AUCUNE limitation — un jeton de session volé
  // permettait de deviner le code à 6 chiffres (10^6 essais) et de lier
  // l'authentificateur de l'attaquant. Mêmes compteurs que completeMfa.
  if(Number(row.totp_locked_until||0)>this.now()){
   const error=new AuthError(429,'Trop de codes erronés. Réessayez dans une minute.')
   error.retryAfter=Math.max(1,Math.ceil((row.totp_locked_until-this.now())/1000));throw error
  }
  const check=verifyTotp(this.secretOf(row),String(code??''),{now:this.now(),lastStep:0})
  if(!check.ok){
   const failures=Number(row.totp_failures||0)+1
   if(failures>=5)this.sql.prepare('UPDATE accounts SET totp_failures=?,totp_locked_until=? WHERE id=?').run(failures,this.now()+60000,row.id)
   else this.sql.prepare('UPDATE accounts SET totp_failures=? WHERE id=?').run(failures,row.id)
   const error=new AuthError(failures>=5?429:401,failures>=5?'Trop de codes erronés. Réessayez dans une minute.':'Code incorrect : vérifiez l’heure de votre téléphone, puis réessayez.')
   if(failures>=5)error.retryAfter=60
   throw error
  }
  const codes=generateBackupCodes()
  return this.transaction(()=>{
   const current=this.authenticate(token)
   if(current.totp_active)throw new AuthError(409,'La double authentification est déjà active.')
   this.sql.prepare('UPDATE accounts SET totp_active=1,totp_last_step=?,totp_backup=?,totp_failures=0,totp_locked_until=0 WHERE id=?').run(check.step,JSON.stringify(codes.map(hashBackupCode)),current.id)
   this.audit(current.id,'mfa-activate',current.id)
   return {ok:true,backupCodes:codes}
  })
 }
 async disableTotp(token,pin){
  const row=this.authenticate(token)
  if(!row.totp_active)throw new AuthError(409,'La double authentification n’est pas active.')
  if(!await verify(pin,row))throw new AuthError(403,'PIN incorrect.')
  this.transaction(()=>{
   const current=this.authenticate(token)
   if(!current.totp_active)throw new AuthError(409,'La double authentification n’est pas active.')
   this.sql.prepare("UPDATE accounts SET totp_active=0,totp_secret='',totp_backup='[]',totp_last_step=0,totp_failures=0,totp_locked_until=0,generation=generation+1 WHERE principal=?").run(current.principal)
   this.revokePrincipal(current.principal)
   this.audit(current.id,'mfa-disable',current.id)
  })
  return {ok:true}
 }
 // ---------------------- scellement des secrets TOTP ----------------------
 sealSecret(secret){
  if(!secret)return ''
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.secretKey,iv)
  const ct=Buffer.concat([cipher.update(String(secret),'utf8'),cipher.final()])
  return `${SECRET_PREFIX}${iv.toString('base64')}:${ct.toString('base64')}:${cipher.getAuthTag().toString('base64')}`
 }
 // Toute valeur illisible renvoie '' : le second facteur échoue alors en
 // « fermé » plutôt que de laisser passer une connexion sans code.
 openSecret(value){
  if(!value)return ''
  const text=String(value)
  if(!text.startsWith(SECRET_PREFIX))return text // reste en clair : migré au démarrage
  const [iv,ct,tag]=text.slice(SECRET_PREFIX.length).split(':')
  if(!iv||!ct||!tag)return ''
  try{
   const decipher=createDecipheriv('aes-256-gcm',this.secretKey,Buffer.from(iv,'base64'))
   decipher.setAuthTag(Buffer.from(tag,'base64'))
   return Buffer.concat([decipher.update(Buffer.from(ct,'base64')),decipher.final()]).toString('utf8')
  }catch{return ''}
 }
 secretOf(row){return this.openSecret(row?.totp_secret)}
 reencryptTotpSecrets(){
  let rows=[]
  try{rows=this.sql.prepare("SELECT id,totp_secret FROM accounts WHERE totp_secret<>''").all()}catch{return 0}
  let migrated=0
  for(const row of rows){
   if(String(row.totp_secret).startsWith(SECRET_PREFIX))continue
   this.sql.prepare('UPDATE accounts SET totp_secret=? WHERE id=?').run(this.sealSecret(row.totp_secret),row.id)
   migrated++
  }
  return migrated
 }
 close(){this.sql.close()}
}
