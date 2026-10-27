import { existsSync,statSync,realpathSync,readFileSync } from 'node:fs'
import { resolve,dirname,basename,sep } from 'node:path'
const inside=(path,root)=>path===root||path.startsWith(root+sep)
function canonical(path){if(existsSync(path))return realpathSync(path);const parent=dirname(path);return parent===path?path:resolve(canonical(parent),basename(path))}
export function deploymentConfig(env=process.env,cwd=process.cwd(),{requireBuild=true}={}){
 const [major,minor]=process.versions.node.split('.').map(Number)
 if(major<22||(major===22&&minor<23))throw new Error('Node 22.23+ requis (Node 24 recommandé).')
 // Plateformes sans shell (Render, Railway) : l'URL publique n'existe qu'après
 // la création du service. On la déduit de la variable fournie par l'hôte,
 // AUTH_ORIGIN restant prioritaire pour un domaine personnalisé.
 const platformOrigin=(env.RENDER_EXTERNAL_URL||'').trim()||(env.RAILWAY_PUBLIC_DOMAIN?`https://${env.RAILWAY_PUBLIC_DOMAIN.trim()}`:'')
 const declared=(env.AUTH_ORIGIN||platformOrigin||'').trim()
 if(!declared)throw new Error('AUTH_ORIGIN manquant. Copiez .env.example en .env ; définissez votre origine HTTPS en production.')
 let url;try{url=new URL(declared)}catch{throw new Error('AUTH_ORIGIN doit être une origine complète, par exemple https://parking.example.com.')}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('AUTH_ORIGIN doit contenir uniquement protocole + domaine + port éventuel, sans identifiants, chemin ni paramètres.')
 const production=env.NODE_ENV==='production'
 if(url.protocol!=='https:'&&(production||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('HTTPS obligatoire en production ; HTTP est réservé au développement loopback.')
 const port=Number(env.PORT||3000)
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT invalide : nombre entier entre 1 et 65535 requis.')
 const distDir=canonical(resolve(cwd,env.DIST_DIR||'dist')),dbPath=canonical(resolve(cwd,env.AUTH_DB||'.server-data/auth.sqlite'))
 if(inside(dbPath,distDir))throw new Error('AUTH_DB ne doit jamais se trouver dans dist ou un répertoire public.')
 if(requireBuild&&(!existsSync(resolve(distDir,'index.html'))||!statSync(resolve(distDir,'index.html')).isFile()))throw new Error('Build de production absent : exécutez npm run build avant npm start.')
 if(!!env.AUTH_TLS_CERT!==!!env.AUTH_TLS_KEY)throw new Error('AUTH_TLS_CERT et AUTH_TLS_KEY doivent être fournis ensemble, ou tous deux absents derrière un proxy HTTPS.')
 const tls=env.AUTH_TLS_CERT?{cert:readFileSync(resolve(cwd,env.AUTH_TLS_CERT)),key:readFileSync(resolve(cwd,env.AUTH_TLS_KEY))}:undefined
 return {origin:url.origin,port,host:env.HOST||'127.0.0.1',dbPath,distDir,tls,production}
}
