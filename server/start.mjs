import { AuthStore } from './auth-store.mjs'
import { createAuthServer } from './http.mjs'
import { deploymentConfig } from './config.mjs'
try {
 const config=deploymentConfig()
 const store=new AuthStore(config.dbPath)
 const server=createAuthServer({store,origin:config.origin,distDir:config.distDir,tls:config.tls})
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
