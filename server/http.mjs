import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { readFile,stat,realpath } from 'node:fs/promises'
import { resolve,extname,sep } from 'node:path'
import { AuthError } from './auth-store.mjs'
import { hasPermission } from '../src/lib/permissions.js'
export const COOKIE='__Host-mp_sid'
// Le préfixe __Host- exige l'attribut Secure : un navigateur REJETTE un cookie
// __Host- non-Secure. En développement loopback (HTTP), il faut donc un nom
// simple, sinon la connexion est impossible sur les navigateurs stricts (Safari).
export const DEV_COOKIE='mp_sid'
export const cookieName=origin=>new URL(origin).protocol==='https:'?COOKIE:DEV_COOKIE
// Fonction pure : testable sans TLS, et seule source de vérité des attributs.
export function serializeSessionCookie({name,token,expires,now=Date.now(),secure}){
 const maxAge=token?Math.max(0,Math.floor((expires-now)/1000)):0
 return `${name}=${token||''}; Path=/; HttpOnly;${secure?' Secure;':''} SameSite=Strict; Max-Age=${maxAge}; Expires=${new Date(token?expires:0).toUTCString()}`
}
const cookies=req=>{try{return Object.fromEntries((req.headers.cookie||'').split(';').filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i).trim(),decodeURIComponent(s.slice(i+1))]}))}catch{return {}}}
// CSP servie uniquement avec les fichiers construits (le dev passe par Vite).
// Aucun script inline n'est utilise : 'wasm-unsafe-eval' suffit a Tesseract.
export const CSP=[
 "default-src 'self'",
 "base-uri 'none'",
 "object-src 'none'",
 "frame-ancestors 'none'",
 "form-action 'self'",
 "script-src 'self' 'wasm-unsafe-eval'",
 "worker-src 'self' blob:",
 "child-src 'self' blob:",
 "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
 "font-src 'self' data: https://fonts.gstatic.com",
 "img-src 'self' data: blob:",
 "media-src 'self' blob:",
 "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://fonts.googleapis.com https://fonts.gstatic.com",
 "manifest-src 'self'",
].join('; ')
export function createAuthServer({store,origin,distDir=null,tls}){
 const expected=new URL(origin)
 if(expected.pathname!=='/'||!['https:','http:'].includes(expected.protocol))throw new Error('AUTH_ORIGIN must be an origin')
 if(expected.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(expected.hostname))throw new Error('HTTPS required outside loopback')
 const secure=expected.protocol==='https:',sessionCookie=cookieName(origin) // M6 : limitation de débit sur la connexion, par origine réseau.
 const trustProxy=process.env.AUTH_TRUST_PROXY==='1'
 const maxAttempts=Math.max(3,Number(process.env.AUTH_MAX_LOGIN_ATTEMPTS||20))
 const windowMs=15*60000,attempts=new Map()
 const clientKey=req=>{
  if(trustProxy){const first=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();if(first)return first}
  return req.socket.remoteAddress||'inconnu'
 }
 const waitFor=key=>{
  if(typeof store.loginWait==='function')return store.loginWait(key,maxAttempts,windowMs)
  const entry=attempts.get(key);if(!entry)return 0;if(entry.reset<=store.now()){attempts.delete(key);return 0}return entry.count>=maxAttempts?Math.max(1,Math.ceil((entry.reset-store.now())/1000)):0}
 const recordFailure=key=>{
  if(typeof store.noteLoginFailure==='function')return store.noteLoginFailure(key,maxAttempts,windowMs)
  const now=store.now(),entry=attempts.get(key)
  if(!entry||entry.reset<=now)attempts.set(key,{count:1,reset:now+windowMs})
  else entry.count++
  if(attempts.size>5000)for(const [k,v] of attempts)if(v.reset<=now)attempts.delete(k)
 }

 const setCookie=(res,token,expires)=>res.setHeader('Set-Cookie',serializeSessionCookie({name:sessionCookie,token,expires,now:store.now(),secure}))
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
 async function body(req){let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>32768)throw new AuthError(413,'Requête trop volumineuse.')}try{return JSON.parse(text)}catch{throw new AuthError(400,'JSON invalide.')}}
 const listener=async(req,res)=>{
  res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff')
  if(expected.protocol==='https:')res.setHeader('Strict-Transport-Security','max-age=31536000')
  let url
  try{url=new URL(req.url,origin)}catch{return json(res,400,{error:'URL de requête invalide.'})}
  if(url.pathname==='/healthz'||url.pathname==='/readyz'){
   // m7 : sans ce contrôle, « ?reason=ADMIN_REQUIRED » révélait publiquement
   // l'état de provisionnement du parking.
   if(req.headers.host!==expected.host)return json(res,403,{error:'Hôte refusé.'})
   if(req.method!=='GET')return json(res,405,{error:'Méthode refusée.'})
   if(url.pathname==='/healthz')return json(res,200,{status:'ok'})
   try{
    if(!distDir||!(await stat(resolve(distDir,'index.html'))).isFile())return json(res,503,{ready:false,reason:'BUILD_REQUIRED'})
    const admin=store.sql.prepare("SELECT COUNT(*) n FROM accounts WHERE role='admin' AND active=1").get().n
    return admin?json(res,200,{ready:true}):json(res,503,{ready:false,reason:'ADMIN_REQUIRED'})
   }catch{return json(res,503,{ready:false,reason:'AUTH_DB_OR_BUILD_UNAVAILABLE'})}
  }
  if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
   const token=cookies(req)[sessionCookie]
   try{
    if(req.headers.host!==expected.host)throw new AuthError(403,'Hôte refusé.')
    if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==expected.origin))throw new AuthError(403,'Origine refusée.')
    if(!['GET','POST','PATCH'].includes(req.method))throw new AuthError(405,'Méthode refusée.')
    if(req.method!=='GET'&&(req.headers.origin!==expected.origin||!String(req.headers['content-type']||'').startsWith('application/json')))throw new AuthError(403,'Requête même origine JSON requise.')
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
     const key=clientKey(req),wait=waitFor(key)
     if(wait){res.setHeader('Retry-After',String(wait));return json(res,429,{error:`Trop de tentatives depuis ce poste. Réessayez dans ${Math.ceil(wait/60)} minute(s).`})}
     const input=await body(req)
     let result
     try{result=await store.login(input.username,input.pin,token,input.lot)}
     catch(error){recordFailure(key);if(error.retryAfter)res.setHeader('Retry-After',String(error.retryAfter));throw error}
     if(typeof store.clearLoginFailures==='function')store.clearLoginFailures(key);else attempts.delete(key)
     if(result.mfaRequired)return json(res,200,{mfaRequired:true,challenge:result.challenge,expires:result.expires})
     const {token:fresh,expires,...identity}=result
     setCookie(res,fresh,expires);return json(res,200,identity)
    }
    if(url.pathname==='/api/auth/mfa'&&req.method==='POST'){
     const key=clientKey(req),wait=waitFor(key)
     if(wait){res.setHeader('Retry-After',String(wait));return json(res,429,{error:`Trop de tentatives depuis ce poste. Réessayez dans ${Math.ceil(wait/60)} minute(s).`})}
     const input=await body(req)
     let result
     try{result=await store.completeMfa(input.challenge,input.code)}
     catch(error){recordFailure(key);if(error.retryAfter)res.setHeader('Retry-After',String(error.retryAfter));throw error}
     if(typeof store.clearLoginFailures==='function')store.clearLoginFailures(key);else attempts.delete(key)
     const {token:fresh,expires,...identity}=result
     setCookie(res,fresh,expires);return json(res,200,identity)
    }
    if(url.pathname==='/api/auth/mfa/enroll'&&req.method==='POST')return json(res,200,store.enrollTotp(token))
    if(url.pathname==='/api/auth/mfa/activate'&&req.method==='POST'){
     const input=await body(req);return json(res,200,store.activateTotp(token,input.code))
    }
    if(url.pathname==='/api/auth/mfa/disable'&&req.method==='POST'){
     const input=await body(req);await store.disableTotp(token,input.pin);setCookie(res,'',0);return json(res,200,{ok:true})
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){store.logout(token);setCookie(res,'',0);return json(res,200,{ok:true})}
    if(url.pathname==='/api/auth/status'&&req.method==='GET'){
     try{return json(res,200,{authenticated:true,...store.identity(store.authenticate(token))})}
     catch(e){if(e.status!==401)throw e;return json(res,200,{authenticated:false})}
    }
    if(url.pathname==='/api/auth/session'&&req.method==='GET'){
     const account=store.authenticate(token);return json(res,200,store.identity(account))
    }
    if(url.pathname==='/api/auth/authorize'&&req.method==='POST'){
     const input=await body(req),account=store.authenticate(token),user=store.profile(account)
     if(user.lotId!==input.lotId||!hasPermission(user,input.permission))throw new AuthError(403,'Accès refusé.')
     return json(res,200,user)
    }
    if(url.pathname==='/api/auth/pin'&&req.method==='POST'){
     const input=await body(req);await store.changePin(token,input.currentPin,input.newPin);setCookie(res,'',0);return json(res,200,{ok:true})
    }
    if(url.pathname==='/api/auth/switch-lot'&&req.method==='POST'){
     const input=await body(req),{token:fresh,expires,...identity}=store.switchLot(token,input.lotId)
     setCookie(res,fresh,expires);return json(res,200,identity)
    }
    if(url.pathname==='/api/admin/users'&&req.method==='POST')return json(res,201,await store.createUser(token,await body(req)))
    if(url.pathname==='/api/admin/lots'&&req.method==='POST')return json(res,201,store.createLot(token,await body(req)))
    const match=/^\/api\/admin\/users\/([^/]+)$/.exec(url.pathname)
    if(match&&req.method==='PATCH'){
     const updated=await store.updateUser(token,decodeURIComponent(match[1]),await body(req))
     try{store.authenticate(token)}catch{setCookie(res,'',0)}
     return json(res,200,updated)
    }
    throw new AuthError(405,'Route ou méthode refusée.')
   }catch(e){
    const status=e instanceof AuthError?e.status:500
    // A delayed rejection must not erase a newer cookie set by another tab.
    // Explicit logout and PIN-change responses clear their own cookie instead.
    return json(res,status,{error:status===500?'Erreur serveur.':e.message})
   }
  }
  if(!distDir){res.writeHead(404);res.end('Not found');return}
  try{
   const pathname=decodeURIComponent(url.pathname)
   // m8 : le défi ACME est un fichier public sans extension, servi avant le filtre.
   const acme=pathname.startsWith('/.well-known/acme-challenge/')
   if(!acme&&(pathname.split('/').some(part=>part.startsWith('.'))||/\.(?:sqlite(?:-wal|-shm)?|db|env|key|pem|p12)(?:$|\/)/i.test(pathname))){res.writeHead(403);res.end();return}
   let file=resolve(distDir,`.${pathname}`),root=await realpath(resolve(distDir))
   if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);res.end();return}
   if(file===root)file=resolve(root,'index.html')
   let info;try{info=await stat(file)}catch{if(extname(url.pathname)){res.writeHead(404);res.end();return}file=resolve(root,'index.html');info=await stat(file)}
   if(!info.isFile()){res.writeHead(404);res.end();return}
   file=await realpath(file)
   if(file!==root&&!file.startsWith(root+sep)){res.writeHead(403);res.end();return}
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.wasm':'application/wasm','.gz':'application/gzip','.ico':'image/x-icon'}
   // Les fichiers de /assets sont hachés par Vite : ils peuvent être mis en cache
   // un an. Le HTML et le service worker doivent rester revalidés à chaque appel.
   const rel=file===root?'/index.html':file.slice(root.length).split(sep).join('/'),ext=extname(file)
   const hashed=rel.startsWith('/assets/')&&/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(rel)
   const cache=ext==='.html'||rel.endsWith('/sw.js')?'no-store':hashed?'public,max-age=31536000,immutable':'public,max-age=3600'
   res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':cache,...(ext==='.html'?{'Content-Security-Policy':CSP}:{})})
   res.end(await readFile(file))
  }catch{res.writeHead(404);res.end()}
 }
 return tls?createTlsServer(tls,listener):createServer(listener)
}
