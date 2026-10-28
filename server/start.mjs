import { AuthStore } from './auth-store.mjs'
import { PgAuthStore } from './auth-store-pg.mjs'
import { PgBusinessStore } from './business-store-pg.mjs'
import { createAuthServer } from './http.mjs'
import { createR2 } from './r2.mjs'
import { deploymentConfig } from './config.mjs'
import { bootstrapAdmin } from './bootstrap.mjs'
try {
 const config=deploymentConfig()
 // DATABASE_URL renseigné => PostgreSQL (Neon/Render), sinon SQLite local.
 // PG_AUTO_MIGRATE=0 est obligatoire derrière un pooler : le DDL y est refusé,
 // les migrations se lancent alors avec `npm run db:migrate`.
 const usePg=!!String(process.env.DATABASE_URL||'').trim()
 const store=usePg
  ?await PgAuthStore.open({connectionString:process.env.DATABASE_URL,autoMigrate:String(process.env.PG_AUTO_MIGRATE||'1')!=='0',secretAnchor:process.cwd()})
  :new AuthStore(config.dbPath)
 const business=usePg?new PgBusinessStore(store.sql===undefined?undefined:store._sql,async()=>{}):null
 console.log(usePg?'Base : PostgreSQL (DATABASE_URL)':'Base : SQLite locale ('+config.dbPath+')')
 await bootstrapAdmin(store)
 const media=createR2()
 if(media)console.log(`Stockage R2 : bucket ${media.config.bucket}`)
 else console.log('Stockage R2 : non configuré (photos locales uniquement)')
 const server=createAuthServer({store,origin:config.origin,distDir:config.distDir,tls:config.tls,business,media})
 server.requestTimeout=15000;server.headersTimeout=10000
 // m9 : une erreur de listen fermait la base, puis SIGTERM la refermait et
 // levait « database is not open » dans le gestionnaire de signal.
 let closed=false
 const closeStore=()=>{if(closed)return;closed=true;try{store.close()}catch{/* déjà fermée */}}
 server.on('error',error=>{console.error(`Démarrage impossible : ${error.code||error.message}`);closeStore();process.exitCode=1})
 server.listen(config.port,config.host,()=>console.log(`MON PARKING écoute sur ${config.host}:${config.port} ; origine ${config.origin}`))
 let stopping=false
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
  if(stopping)return;stopping=true
  const timer=setTimeout(()=>{server.closeAllConnections();closeStore();process.exit(0)},5000);timer.unref()
  server.close(()=>{clearTimeout(timer);closeStore();process.exit(0)})
 })
} catch(error) {
 console.error(`Configuration de déploiement invalide : ${error.message}`)
 process.exitCode=1
}
