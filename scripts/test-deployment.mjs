import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp,writeFile,mkdir,rm,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createServer } from 'node:net'
import http from 'node:http'
const root=resolve('.'),baseEnv={...process.env};for(const k of Object.keys(baseEnv))if(k.startsWith('AUTH_')||['HOST','PORT','NODE_ENV'].includes(k))delete baseEnv[k]
let passed=0,failed=0
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function start(dir,env={}){
 const port=await freePort(),child=spawn(process.execPath,['--env-file-if-exists=.env',join(root,'server/start.mjs')],{cwd:dir,env:{...baseEnv,AUTH_ORIGIN:`http://127.0.0.1:${port}`,PORT:String(port),...env},stdio:['ignore','pipe','pipe']})
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
 const closed=new Promise(r=>child.once('exit',code=>r(code)))
 for(let i=0;i<80;i++){if(child.exitCode!==null)break;try{await fetch(`http://127.0.0.1:${port}/healthz`);return {child,port,closed,output:()=>output,stop:async()=>{child.kill('SIGTERM');await closed}}}catch{}await new Promise(r=>setTimeout(r,30))}
 return {child,port,closed,output:()=>output,stop:async()=>{if(child.exitCode===null)child.kill('SIGTERM');await closed}}
}
async function check(name,fn){const dir=await mkdtemp(join(tmpdir(),'mp-deploy-'));let service;try{await mkdir(join(dir,'dist'));await writeFile(join(dir,'dist/index.html'),'<!doctype html><title>Test build</title>');await fn(dir,async env=>service=await start(dir,env));passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.stack)}finally{await service?.stop();await rm(dir,{recursive:true,force:true})}}
await check('npm start loads documented .env without shell-exporting AUTH_ORIGIN',async(dir)=>{
 const port=await freePort();await writeFile(join(dir,'.env'),`AUTH_ORIGIN=http://127.0.0.1:${port}\nPORT=${port}\n`)
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'))
 await writeFile(join(dir,'package.json'),JSON.stringify({scripts:{start:pkg.scripts.start.replace('server/start.mjs',join(root,'server/start.mjs'))}}))
 const child=spawn('npm',['start'],{cwd:dir,env:baseEnv,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']})
 let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b)
 try{let ready=false;for(let i=0;i<60;i++){if(child.exitCode!==null)break;try{ready=(await fetch(`http://127.0.0.1:${port}/healthz`)).status===200;if(ready)break}catch{}await new Promise(r=>setTimeout(r,50))}assert(ready,text)}finally{if(process.platform==='win32')child.kill('SIGTERM');else try{process.kill(-child.pid,'SIGTERM')}catch{}}
})
await check('Missing production build fails before pretending to listen',async(dir,start)=>{await rm(join(dir,'dist'),{recursive:true});const s=await start({});assert.notEqual(await Promise.race([s.closed,new Promise(r=>setTimeout(()=>r('RUNNING'),1000))]),'RUNNING');assert.match(s.output(),/npm run build|build|dist/i)})
await check('Authentication database cannot be placed inside public dist',async(dir,start)=>{const s=await start({AUTH_DB:join(dir,'dist/credentials.sqlite')});assert.notEqual(await Promise.race([s.closed,new Promise(r=>setTimeout(()=>r('RUNNING'),1000))]),'RUNNING');assert.match(s.output(),/AUTH_DB|public|dist/i)})
await check('Production refuses HTTP even on a loopback origin',async(dir,start)=>{const s=await start({NODE_ENV:'production'});assert.notEqual(await Promise.race([s.closed,new Promise(r=>setTimeout(()=>r('RUNNING'),1000))]),'RUNNING');assert.match(s.output(),/HTTPS|https/i)})
await check('Readiness is 503 before administrator provisioning; liveness is 200',async(dir,start)=>{const s=await start({});assert.equal((await fetch(`http://127.0.0.1:${s.port}/healthz`)).status,200);const response=await fetch(`http://127.0.0.1:${s.port}/readyz`);assert.equal(response.status,503);assert.equal((await response.json()).reason,'ADMIN_REQUIRED')})
await check('Secret-looking files in dist cannot be downloaded',async(dir,start)=>{await writeFile(join(dir,'dist/credentials.sqlite'),'DO_NOT_SERVE');await writeFile(join(dir,'dist/.env'),'SECRET');const s=await start({});for(const path of ['/credentials.sqlite','/.env']){const r=await fetch(`http://127.0.0.1:${s.port}${path}`);assert.equal(r.status,403);assert(!(await r.text()).includes('DO_NOT_SERVE'))}})
await check('Malformed absolute request target does not crash the HTTP server',async(dir,start)=>{const s=await start({});await new Promise(resolve=>{const r=http.request({host:'127.0.0.1',port:s.port,path:'http://',method:'GET'},res=>{res.resume();res.on('end',resolve)});r.on('error',resolve);r.end()});await new Promise(r=>setTimeout(r,100));assert.equal(s.child.exitCode,null,s.output());assert.equal((await fetch(`http://127.0.0.1:${s.port}/healthz`)).status,200)})
console.log(`DEPLOYMENT: ${passed} passed / ${failed} failed`);process.exitCode=failed?1:0
