// m7 / m8 / m9 / m10 — durcissement complémentaire.
// m7  : /healthz et /readyz ne révèlent plus l'état de provisionnement.
// m8  : /.well-known/acme-challenge/ reste accessible (renouvellement TLS).
// m9  : la fermeture du serveur est idempotente (plus de « database is not open »).
// m10 : les erreurs réseau / serveur / payload sont distinguées à l'écran.
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createServer } from 'node:net'
import { AuthStore,hashServerPin } from '../../server/auth-store.mjs'
import { createAuthServer } from '../../server/http.mjs'

const root=resolve(new URL('../../',import.meta.url).pathname)
let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

const get=(origin,path,{host}={})=>new Promise(resolve=>{
  const url=new URL(origin)
  const req=http.request({host:'127.0.0.1',port:url.port,path,method:'GET',headers:host?{Host:host}:{}},res=>{
    let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:text,headers:res.headers}))
  })
  req.on('error',e=>resolve({status:0,body:e.message,headers:{}}));req.end()
})

// ---------- m7 + m8 ----------
const dir=await mkdtemp(join(tmpdir(),'mp-harden-'))
let fixture
try{
  await mkdir(join(dir,'dist'),{recursive:true})
  await mkdir(join(dir,'dist','.well-known','acme-challenge'),{recursive:true})
  await writeFile(join(dir,'dist','index.html'),'<!doctype html><title>t</title>')
  await writeFile(join(dir,'dist','.well-known','acme-challenge','jeton'),'cle-acme-publique')
  await writeFile(join(dir,'dist','credentials.sqlite'),'DO_NOT_SERVE')

  const store=new AuthStore(':memory:')
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'L1',name:'Un'}],users:[{id:'a1',lotId:'L1',username:'chef',name:'Chef',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r))
  const port=probe.address().port;await new Promise(r=>probe.close(r))
  const origin=`http://127.0.0.1:${port}`
  const server=createAuthServer({store,origin,distDir:join(dir,'dist')})
  await new Promise(r=>server.listen(port,'127.0.0.1',r))
  fixture={store,server,origin}

  await check('m7 : /healthz avec un Host étranger renvoie 403',async()=>{
    const response=await get(origin,'/healthz',{host:'attaquant.example'})
    assert.equal(response.status,403,`statut ${response.status}`)
    assert(!/ok/.test(response.body))
  })

  await check('m7 : /readyz ne divulgue plus ADMIN_REQUIRED depuis l’extérieur',async()=>{
    const response=await get(origin,'/readyz',{host:'attaquant.example'})
    assert.equal(response.status,403)
    assert(!/ADMIN_REQUIRED/.test(response.body),response.body)
  })

  await check('m7 : les sondes locales légitimes restent fonctionnelles',async()=>{
    assert.equal((await get(origin,'/healthz')).status,200)
    assert.equal((await get(origin,'/readyz')).status,200)
  })

  await check('m8 : le défi ACME est servi (200) au lieu d’être bloqué (403)',async()=>{
    const response=await get(origin,'/.well-known/acme-challenge/jeton')
    assert.equal(response.status,200,`statut ${response.status}`)
    assert.match(response.body,/cle-acme-publique/)
  })

  await check('m8 : les fichiers sensibles restent bloqués',async()=>{
    for(const path of ['/credentials.sqlite','/.env']){
      const response=await get(origin,path)
      assert.equal(response.status,403,`${path} → ${response.status}`)
    }
  })
}finally{
  if(fixture){fixture.server.closeAllConnections();await new Promise(r=>fixture.server.close(r));fixture.store.close()}
  await rm(dir,{recursive:true,force:true})
}

// ---------- m9 : fermeture idempotente ----------
await check('m9 : deux SIGTERM ne provoquent aucune erreur de base déjà fermée',async()=>{
  const work=await mkdtemp(join(tmpdir(),'mp-sig-'))
  let child,output=''
  try{
    await mkdir(join(work,'dist'),{recursive:true})
    await writeFile(join(work,'dist','index.html'),'<!doctype html><title>t</title>')
    const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r))
    const port=probe.address().port;await new Promise(r=>probe.close(r))
    child=spawn(process.execPath,[join(root,'server','start.mjs')],{
      cwd:work,env:{...process.env,AUTH_ORIGIN:`http://127.0.0.1:${port}`,PORT:String(port),HOST:'127.0.0.1',AUTH_DB:join(work,'auth.sqlite'),DIST_DIR:'dist'},
      stdio:['ignore','pipe','pipe'],
    })
    child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
    const ready=await (async()=>{for(let i=0;i<120;i++){if(child.exitCode!==null)return false;try{if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok)return true}catch{}await new Promise(r=>setTimeout(r,60))}return false})()
    assert(ready,`serveur non démarré :\n${output}`)
    const exited=new Promise(r=>child.once('exit',code=>r(code)))
    child.kill('SIGTERM')
    await new Promise(r=>setTimeout(r,120))
    if(child.exitCode===null)child.kill('SIGTERM')
    const code=await Promise.race([exited,new Promise(r=>setTimeout(()=>r('TIMEOUT'),8000))])
    assert.notEqual(code,'TIMEOUT','le serveur ne s’est pas arrêté')
    assert(!/not open|database is closed/i.test(output),`sortie : ${output}`)
  }finally{
    if(child&&child.exitCode===null)child.kill('SIGKILL')
    await rm(work,{recursive:true,force:true})
  }
})

// ---------- m10 : messages d'erreur distincts ----------
await check('m10 : panne réseau, réponse illisible et erreur HTTP sont distinguées',async()=>{
  const {authRequest}=await import('../../src/lib/authSession.js')
  const original=globalThis.fetch
  try{
    globalThis.fetch=async()=>{throw new TypeError('fetch failed')}
    const offline=await authRequest('/api/auth/status').catch(e=>e)
    assert.equal(offline.status,0)
    assert(/injoignable|Hors ligne/.test(offline.message),offline.message)

    globalThis.fetch=async()=>({ok:false,status:502,headers:new Map(),json:async()=>{throw new SyntaxError('Unexpected token <')}})
    const broken=await authRequest('/api/auth/status').catch(e=>e)
    assert.equal(broken.status,502)
    assert(/502/.test(broken.message),broken.message)
    assert(!/Aucun accès restauré/.test(broken.message),'message générique conservé')

    globalThis.fetch=async()=>({ok:false,status:401,headers:new Map(),json:async()=>({error:'Code PIN incorrect.'})})
    const denied=await authRequest('/api/auth/login',{method:'POST',body:{}}).catch(e=>e)
    assert.equal(denied.status,401)
    assert.equal(denied.message,'Code PIN incorrect.')
  }finally{globalThis.fetch=original}
})

console.log(`m7–m10 HARDENING: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
