// M1 — le proxy de développement ne doit plus être refusé par le serveur.
// Défaut v12 : changeOrigin:false transmettait Host: 127.0.0.1:5173 alors que
// le serveur compare Host et Origin à AUTH_ORIGIN → 403 « Hôte refusé » sur
// toute l'API, donc npm run dev et npm run preview inutilisables.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createServer } from 'node:net'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { AuthStore,hashServerPin } from '../../server/auth-store.mjs'
import { createAuthServer } from '../../server/http.mjs'

const root=resolve(new URL('../../',import.meta.url).pathname)
let passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}
// On analyse le code, pas les commentaires qui décrivent le défaut corrigé.
const stripComments=(text)=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/(^|\s)\/\/.*$/gm,'')

const freePort=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}

await check('La configuration déclare changeOrigin et réécrit Origin',()=>{
  const config=stripComments(readFileSync(join(root,'vite.config.js'),'utf8'))
  assert(/changeOrigin:\s*true/.test(config),'changeOrigin:true absent')
  assert(!/changeOrigin:\s*false/.test(config),'changeOrigin:false encore présent')
  assert(/setHeader\('Origin'/.test(config),'Origin non réécrit vers le backend')
  for(const key of ['server','preview'])assert(new RegExp(`${key}:\\s*\\{\\s*proxy`).test(config),`proxy ${key} absent`)
})

const dir=await mkdtemp(join(tmpdir(),'mp-m1-'))
const backendPort=await freePort(),vitePort=await freePort()
const origin=`http://127.0.0.1:${backendPort}`
let server,child,output=''
try{
  // Backend réel (mêmes contrôles Host/Origin que la production).
  const store=new AuthStore(join(dir,'auth.sqlite'))
  const pin=await hashServerPin('1234')
  store.importTrusted({lots:[{id:'LOT-A',name:'Parc A'}],users:[{id:'admin-1',lotId:'LOT-A',username:'admin',name:'Admin',role:'admin',active:true,pinHash:pin.hash,salt:pin.salt}]})
  // Vite sert la racine du projet : index.html doit y être, pas seulement dans dist.
  const html='<!doctype html><title>MON PARKING</title><div id="root"></div>'
  await mkdir(join(dir,'dist'),{recursive:true})
  await writeFile(join(dir,'index.html'),html)
  await writeFile(join(dir,'dist','index.html'),html)
  server=createAuthServer({store,origin,distDir:join(dir,'dist')})
  await new Promise(r=>server.listen(backendPort,'127.0.0.1',r))

  await check('Le backend refuse bien un Host étranger (contrôle actif)',async()=>{
    const probeResult=await new Promise(resolve=>{
      const req=http.request({host:'127.0.0.1',port:backendPort,path:'/api/auth/status',headers:{Host:'127.0.0.1:'+vitePort}},res=>{
        let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:b}))
      })
      req.on('error',e=>resolve({status:0,body:e.message}));req.end()
    })
    assert.equal(probeResult.status,403,`reçu ${probeResult.status} ${probeResult.body}`)
    assert.match(probeResult.body,/Hôte refusé/)
  })

  // Serveur de développement réel, comme `npm run dev`.
  child=spawn(process.execPath,[join(root,'node_modules','vite','bin','vite.js'),'--host','127.0.0.1','--port',String(vitePort),'--strictPort'],{
    cwd:root,env:{...process.env,AUTH_DEV_TARGET:origin,CHOKIDAR_USEPOLLING:'1'},stdio:['ignore','pipe','pipe'],detached:true,
  })
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
  const ready=await (async()=>{for(let i=0;i<160;i++){if(child.exitCode!==null)return false;try{if((await fetch(`http://127.0.0.1:${vitePort}/`)).ok)return true}catch{}await new Promise(r=>setTimeout(r,120))}return false})()
  assert(ready,`Vite n'a pas démarré :\n${output}`)

  await check('La connexion passe à travers le proxy de développement',async()=>{
    const response=await fetch(`http://127.0.0.1:${vitePort}/api/auth/login`,{
      method:'POST',headers:{Origin:`http://127.0.0.1:${vitePort}`,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',pin:'1234'}),
    })
    const text=await response.text()
    assert.equal(response.status,200,`réponse proxy : ${response.status} ${text}`)
    assert.match(response.headers.get('content-type'),/application\/json/)
    assert.match(text,/"role":"admin"/)
    assert(response.headers.get('set-cookie'),'cookie de session absent')
  })

  await check('Les erreurs d’authentification traversent aussi le proxy',async()=>{
    const response=await fetch(`http://127.0.0.1:${vitePort}/api/auth/login`,{
      method:'POST',headers:{Origin:`http://127.0.0.1:${vitePort}`,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',pin:'0000'}),
    })
    assert.equal(response.status,401)
  })
}finally{
  if(child){try{process.kill(-child.pid,'SIGTERM')}catch{try{child.kill('SIGTERM')}catch{/* already gone */}}}
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}
  await rm(dir,{recursive:true,force:true})
}

console.log(`M1 DEV PROXY: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
