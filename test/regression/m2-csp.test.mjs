// M2 — Content-Security-Policy absente en v12.
// Une application qui manipule encaissements et PIN n'avait aucun en-tête CSP :
// un XSS pouvait exfiltrer les données locales et appeler /api/... authentifié.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixture } from '../../scripts/session-fixture.mjs'
import { CSP } from '../../server/http.mjs'

const dir=await mkdtemp(join(tmpdir(),'mp-csp-'))
let fixture,passed=0,failed=0
const check=async(name,fn)=>{try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}
const directives=(header)=>new Map(header.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{const [name,...rest]=part.split(/\s+/);return [name,rest.join(' ')]}))

try{
  await mkdir(join(dir,'assets'),{recursive:true})
  await writeFile(join(dir,'index.html'),'<!doctype html><html><head><script type="module" src="./assets/app-1234ABCD.js"></script></head><body><div id="root"></div></body></html>')
  await writeFile(join(dir,'assets','app-1234ABCD.js'),'export const ok=1')
  await writeFile(join(dir,'manifest.webmanifest'),'{"name":"MON PARKING"}')
  fixture=await startFixture({distDir:dir})

  const page=await fetch(fixture.origin+'/')
  const header=page.headers.get('content-security-policy')

  await check('La page HTML est servie avec une CSP',async()=>{
    assert(header,`en-tête absent. En-têtes : ${JSON.stringify([...page.headers])}`)
    assert(header.length>80,`CSP trop courte : ${header}`)
  })

  await check('Les directives structurantes sont présentes',async()=>{
    const map=directives(header)
    for(const name of ['default-src','base-uri','object-src','frame-ancestors','form-action','script-src','connect-src','worker-src','img-src','style-src']){
      assert(map.has(name),`directive manquante : ${name}`)
    }
    assert.equal(map.get('default-src'),"'self'")
    assert.equal(map.get('frame-ancestors'),"'none'")
    assert.equal(map.get('base-uri'),"'none'")
    assert.equal(map.get('object-src'),"'none'")
    assert.equal(map.get('form-action'),"'self'")
  })

  await check('script-src n’autorise ni inline ni eval arbitraire',async()=>{
    const script=directives(header).get('script-src')
    assert(!/'unsafe-inline'/.test(script),`script-src trop permissif : ${script}`)
    assert(!/'unsafe-eval'/.test(script),`eval autorisé : ${script}`)
    assert(/'wasm-unsafe-eval'/.test(script),'Tesseract (WASM) serait bloqué')
    assert(/'self'/.test(script))
  })

  await check('Le moteur OCR peut charger son worker et son WASM',async()=>{
    const map=directives(header)
    assert(/blob:/.test(map.get('worker-src')),`worker-src : ${map.get('worker-src')}`)
    assert(/'self'/.test(map.get('connect-src')),'le WASM et les données locales doivent rester accessibles')
  })

  await check('Aucune source distante arbitraire (pas de wildcard *)',async()=>{
    for(const [name,value] of directives(header))assert(!/(^|\s)\*(\s|$)/.test(value),`joker interdit dans ${name}: ${value}`)
  })

  await check('La CSP reste alignée sur la constante exportée',async()=>{
    assert.equal(header,CSP)
  })

  await check('Les assets ne portent pas la CSP mais gardent nosniff',async()=>{
    const asset=await fetch(fixture.origin+'/assets/app-1234ABCD.js')
    assert.equal(asset.status,200)
    assert.equal(asset.headers.get('content-security-policy'),null)
    assert.equal(asset.headers.get('x-content-type-options'),'nosniff')
  })

  await check('Le repli SPA sur index.html est aussi protégé',async()=>{
    const deep=await fetch(fixture.origin+'/dashboard')
    assert.equal(deep.status,200)
    assert.match(deep.headers.get('content-security-policy')||'',/default-src 'self'/)
  })
}finally{
  await fixture?.close()
  await rm(dir,{recursive:true,force:true})
}

console.log(`M2 CSP: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
