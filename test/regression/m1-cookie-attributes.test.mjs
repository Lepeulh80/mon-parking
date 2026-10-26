// m1 — attributs du cookie de session selon le protocole.
// Défaut v12 : « Secure » était ajouté inconditionnellement, y compris en HTTP.
// Or le préfixe __Host- exige Secure : un navigateur qui applique la règle
// rejette alors le cookie et la connexion devient impossible en développement.
import assert from 'node:assert/strict'
import { serializeSessionCookie,cookieName,COOKIE,DEV_COOKIE } from '../../server/http.mjs'

let passed=0,failed=0
const check=(name,fn)=>{try{fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}

check('HTTPS utilise le préfixe __Host- avec Secure',()=>{
 const header=serializeSessionCookie({name:cookieName('https://parking.example.com'),token:'T'.repeat(43),expires:Date.now()+1000,now:Date.now(),secure:true})
 assert(header.startsWith(`${COOKIE}=`),header)
 assert(header.includes(' Secure;'))
 assert.equal(cookieName('https://parking.example.com'),COOKIE)
})

check('HTTP loopback ne prétend pas être __Host- : nom simple et sans Secure',()=>{
 const now=Date.now()
 const header=serializeSessionCookie({name:cookieName('http://127.0.0.1:3000'),token:'T'.repeat(43),expires:now+1000,now,secure:false})
 assert(header.startsWith(`${DEV_COOKIE}=`),header)
 assert(!header.includes('Secure'),header)
 assert.equal(cookieName('http://127.0.0.1:3000'),DEV_COOKIE)
})

check('Attributs de protection conservés dans les deux cas',()=>{
 const now=Date.now()
 for(const secure of [true,false]){
  const header=serializeSessionCookie({name:'x',token:'T',expires:now+600000,now,secure})
  for(const flag of ['Path=/','HttpOnly','SameSite=Strict','Max-Age=600','Expires='])assert(header.includes(flag),`${flag} manquant: ${header}`)
  assert(!header.includes('Domain='),'Domain= interdit avec le préfixe __Host-')
 }
})

check('Effacement du cookie : Max-Age=0 et date passée',()=>{
 const header=serializeSessionCookie({name:'x',token:'',expires:0,now:Date.now(),secure:true})
 assert(header.includes('Max-Age=0'),header)
 assert(header.includes('Expires=Thu, 01 Jan 1970'),header)
})

console.log(`M1 COOKIE: ${passed} passed / ${failed} failed`)
process.exitCode=failed?1:0
