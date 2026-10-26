import { deploymentConfig } from '../server/config.mjs'
import { DatabaseSync } from 'node:sqlite'
import { existsSync,accessSync,constants,readdirSync,readFileSync,statSync } from 'node:fs'
import { resolve,join,sep } from 'node:path'
const local=process.argv.includes('--local')
let failures=0
const check=(ok,text)=>{console.log(`${ok?'OK':'ERREUR'} — ${text}`);if(!ok)failures++}

// Motifs de secrets qui ne doivent JAMAIS finir dans le bundle public.
// Un scan des variables VITE_* ne suffit pas : une clé peut être compilée
// dans dist/ via un fichier d'environnement commité ou un import direct.
const SECRET_PATTERNS=[
 ['clé privée PEM',/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
 ['clé secrète Supabase',/sb_secret_[A-Za-z0-9_-]{16,}/],
 ['clé de service Stripe',/sk_live_[A-Za-z0-9]{16,}/],
 ['rôle service_role',/service_role/],
]

function scanDist(root){
 const hits=[],seen=new Set()
 const walk=dir=>{
  if(hits.length&&seen.size>4000)return
  let entries;try{entries=readdirSync(dir,{withFileTypes:true})}catch{return}
  for(const entry of entries){
   const full=join(dir,entry.name)
   if(entry.isDirectory()){if(entry.name!=='node_modules')walk(full);continue}
   if(!/\.(?:js|html|json|map|css)$/i.test(entry.name))continue
   let size=0;try{size=statSync(full).size}catch{continue}
   if(size>8*1024*1024)continue
   seen.add(full)
   let text='';try{text=readFileSync(full,'utf8')}catch{continue}
   for(const [label,pattern] of SECRET_PATTERNS)if(pattern.test(text))hits.push(`${label} dans ${full.slice(root.length+1)||entry.name}`)
  }
 }
 if(existsSync(root))walk(root)
 return {hits,scanned:seen.size}
}

try{
 const config=deploymentConfig()
 check(local||config.production,'NODE_ENV=production pour Internet ; --local uniquement pour vérification de développement')
 check(local||!/(^|\.)(?:example\.com|example\.org|example\.net|invalid|example)$/.test(new URL(config.origin).hostname),'AUTH_ORIGIN contient votre domaine, pas le domaine de démonstration')
 check(new URL(config.origin).hostname.length>0,`Origine contrôlée : ${config.origin}`)

 // Re-vérifications indépendantes : on ne se contente pas de « config.mjs a validé ».
 const index=resolve(config.distDir,'index.html')
 check(existsSync(index)&&statSync(index).isFile(),`Build présent : ${index}`)
 check(!(config.dbPath===config.distDir||config.dbPath.startsWith(config.distDir+sep)),`Base AUTH_DB hors répertoire public : ${config.dbPath}`)
 check(!!config.tls===!!process.env.AUTH_TLS_CERT,'Paramètres TLS cohérents (Caddy/Nginx devant Node, ou paire cert+key)')

 let secrets=false
 for(const [key,value] of Object.entries(process.env)){
  if(!key.startsWith('VITE_')||!value)continue
  if(/SECRET|PASSWORD|SERVICE_ROLE|PRIVATE_KEY|REFRESH_TOKEN/.test(key)||value.startsWith('sb_secret_'))secrets=true
  if(key==='VITE_SUPABASE_ANON_KEY'){
   try{if(JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString()).role==='service_role')secrets=true}catch{/* A publishable key need not be a JWT. */}
  }
 }
 check(!secrets,'Aucune clé privée/service_role ni mot de passe dans les variables VITE_*')

 const {hits,scanned}=scanDist(config.distDir)
 check(!hits.length,`Aucun secret compilé dans le bundle public (${scanned} fichiers scannés)`)
 for(const hit of hits)console.log(`        ↳ ${hit}`)

 if(existsSync(config.dbPath)){
  try{
   accessSync(config.dbPath,constants.R_OK|constants.W_OK)
   const db=new DatabaseSync(config.dbPath,{readOnly:true})
   try{check(db.prepare("SELECT COUNT(*) n FROM accounts WHERE role='admin' AND active=1").get().n>0,'Au moins un administrateur serveur actif provisionné')}finally{db.close()}
  }catch{check(false,'Base AUTH_DB lisible/inscriptible et schéma valide pour le compte du service')}
 }else check(false,'Base serveur absente : exécuter npm run auth:setup ou auth:import avec le même AUTH_DB')
 console.log('Périmètre : contrôles locaux uniquement. DNS, certificat HTTPS public, reverse proxy, disque persistant et sauvegardes doivent être vérifiés sur votre hébergeur.')
}catch(error){check(false,error.message)}
console.log(`DEPLOY_CHECK_EXIT=${failures?1:0}`);process.exitCode=failures?1:0
