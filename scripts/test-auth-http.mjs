import assert from 'node:assert/strict'
import { startFixture } from './session-fixture.mjs'
import { COOKIE,DEV_COOKIE,cookieName } from '../server/http.mjs'
import { AuthStore } from '../server/auth-store.mjs'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const external=process.env.AUTH_TEST_BASE,fixture=external?null:await startFixture(),base=external||fixture.origin
let passed=0,failed=0
const request=(path,{cookie,body,method=body?'POST':'GET',origin=base,headers={}}={})=>fetch(base+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined})
async function login(username='admin',pin='1234',cookie){const response=await request('/api/auth/login',{body:{username,pin},cookie});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/application\/json/);const setCookie=response.headers.get('set-cookie');assert(setCookie);return {cookie:setCookie.split(';')[0],setCookie,data:await response.json()}}
async function check(name,fn){
 if(external&&/expires on the SERVER|Generation mismatch|Only token digests|Restart persists|Server PIN reset/.test(name)){console.log('NOT_APPLICABLE_OLD_SERVER',name,'(no server state existed in the original build)');return}
 try{await fn();passed++;console.log('PASS',name)}catch(e){failed++;console.error('FAIL',name,e.stack)}
}
try{
 await check('No session cookie: protected endpoint rejects the request',async()=>{assert.equal((await request('/api/auth/session')).status,401)})
 await check('Invented persisted IDs/token cannot authenticate',async()=>{assert.equal((await request('/api/auth/session',{cookie:`${COOKIE}=${'A'.repeat(43)}`,headers:{'X-User-Id':'demo-user-admin','X-Lot-Id':'demo-lot-apa',Authorization:'Bearer fabricated'}})).status,401)})
 await check('Authenticated GET supplies no hash, salt, bearer or plaintext PIN',async()=>{const session=await login(),response=await request('/api/auth/session',{cookie:session.cookie});assert.equal(response.status,200);const text=await response.text();assert(!/pinHash|pin_hash|pin_salt|"salt"|"token"|"1234"/.test(text));assert.equal(JSON.parse(text).user.role,'admin')})
 await check('Cookie is HttpOnly SameSite Strict with expiry and no Domain',async()=>{const {setCookie}=await login();for(const flag of ['HttpOnly','SameSite=Strict','Path=/','Expires=','Max-Age='])assert(setCookie.includes(flag));assert(!setCookie.includes('Domain='));assert(setCookie.startsWith(`${DEV_COOKIE}=`));assert(!setCookie.includes('Secure'),'un cookie __Host- non-Secure serait rejeté par le navigateur')})
 await check('Cookie naming follows the origin protocol: __Host- and Secure only over HTTPS',async()=>{
  assert.equal(cookieName('http://127.0.0.1:3000'),DEV_COOKIE);assert.equal(cookieName('https://parking.example.com'),COOKIE)
  assert(COOKIE.startsWith('__Host-'),'le nom HTTPS doit garder le préfixe __Host-')
 })
 await check('Status restoration is validated on the server, not from persisted client IDs',async()=>{
  const absent=await request('/api/auth/status',{cookie:`${COOKIE}=${'Z'.repeat(43)}`});assert.deepEqual(await absent.json(),{authenticated:false})
  const {cookie}=await login(),valid=await request('/api/auth/status',{cookie});const state=await valid.json();assert.equal(state.authenticated,true);assert.equal(state.user.id,'demo-user-admin')
 })
 await check('Every login rotates ID and rejects the previous cookie',async()=>{const first=await login(),second=await login('admin','1234',first.cookie);assert.notEqual(first.cookie,second.cookie);assert.equal((await request('/api/auth/session',{cookie:first.cookie})).status,401);assert.equal((await request('/api/auth/session',{cookie:second.cookie})).status,200)})
 await check('Late rejection of an old cookie cannot clear a newer login cookie',async()=>{
  const first=await login();await login('admin','1234',first.cookie)
  const response=await request('/api/auth/session',{cookie:first.cookie})
  assert.equal(response.status,401);assert.equal(response.headers.get('set-cookie'),null)
 })
 await check('Logout revokes server record and clears the browser cookie',async()=>{const {cookie}=await login(),response=await request('/api/auth/logout',{cookie,body:{}});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);assert.equal((await request('/api/auth/session',{cookie})).status,401)})
 await check('Replaying a copied cookie after logout cannot restore a persisted session',async()=>{const {cookie}=await login();await request('/api/auth/logout',{cookie,body:{}});for(let n=0;n<3;n++)assert.equal((await request('/api/auth/session',{cookie})).status,401)})
 await check('PIN change kills all sessions on every device, not only the current cookie',async()=>{
  const first=await login(),second=await login(),response=await request('/api/auth/pin',{cookie:first.cookie,body:{currentPin:'1234',newPin:'5678'}})
  assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Max-Age=0/)
  for(const session of [first,second])assert.equal((await request('/api/auth/session',{cookie:session.cookie})).status,401)
  assert.equal((await request('/api/auth/login',{body:{username:'admin',pin:'1234'}})).status,401)
  const fresh=await login('admin','5678');assert.equal((await request('/api/auth/pin',{cookie:fresh.cookie,body:{currentPin:'5678',newPin:'1234'}})).status,200)
 })
 await check('Wrong current PIN cannot revoke a valid session or change credentials',async()=>{const {cookie}=await login();assert.equal((await request('/api/auth/pin',{cookie,body:{currentPin:'0000',newPin:'5678'}})).status,403);assert.equal((await request('/api/auth/session',{cookie})).status,200)})
 await check('Administrator reset revokes every employee cookie and old PIN',async()=>{
  const admin=await login(),one=await login('vendeur','1111'),two=await login('vendeur','1111')
  assert.equal((await request('/api/admin/users/demo-user-vendeur',{cookie:admin.cookie,method:'PATCH',body:{pin:'3333'}})).status,200)
  for(const s of [one,two])assert.equal((await request('/api/auth/session',{cookie:s.cookie})).status,401)
  assert.equal((await request('/api/auth/login',{body:{username:'vendeur',pin:'1111'}})).status,401)
  await login('vendeur','3333')
  assert.equal((await request('/api/admin/users/demo-user-vendeur',{cookie:admin.cookie,method:'PATCH',body:{pin:'1111'}})).status,200)
 })
 await check('Disabled account immediately loses access with an existing cookie',async()=>{
  const admin=await login(),employee=await login('vendeur','1111')
  assert.equal((await request('/api/admin/users/demo-user-vendeur',{cookie:admin.cookie,method:'PATCH',body:{active:false}})).status,200)
  assert.equal((await request('/api/auth/session',{cookie:employee.cookie})).status,401)
  assert.equal((await request('/api/admin/users/demo-user-vendeur',{cookie:admin.cookie,method:'PATCH',body:{active:true}})).status,200)
 })
 await check('Persisted cookie expires on the SERVER even if the client keeps replaying it',async()=>{
  assert(fixture,'Expiry control requires the local real server fixture')
  const oldNow=fixture.store.now,oldTtl=fixture.store.ttlMs;let clock=Date.now();fixture.store.now=()=>clock;fixture.store.ttlMs=1000
  try{const {cookie}=await login();assert.equal((await request('/api/auth/session',{cookie})).status,200);clock+=1001;assert.equal((await request('/api/auth/session',{cookie})).status,401)}finally{fixture.store.now=oldNow;fixture.store.ttlMs=oldTtl}
 })
 await check('Generation mismatch alone rejects an otherwise valid stored session',async()=>{
  assert(fixture);const {cookie}=await login()
  fixture.store.sql.prepare('UPDATE accounts SET generation=generation+1 WHERE id=?').run('demo-user-admin')
  assert.equal((await request('/api/auth/session',{cookie})).status,401)
 })
 await check('Role and tenant checks use server identity, never client role claims',async()=>{
  const {cookie}=await login('vendeur','1111')
  assert.equal((await request('/api/admin/users/demo-user-admin',{cookie,method:'PATCH',body:{pin:'9999'},headers:{'X-Role':'admin'}})).status,403)
  assert.equal((await request('/api/auth/authorize',{cookie,body:{lotId:'other-lot',permission:'sales.write'}})).status,403)
  assert.equal((await request('/api/auth/authorize',{cookie,body:{lotId:'demo-lot-apa',permission:'staff.manage'}})).status,403)
  assert.equal((await request('/api/auth/authorize',{cookie,body:{lotId:'demo-lot-apa',permission:'sales.write'}})).status,200)
 })
 await check('CSRF, GET logout, cross-origin and non-JSON mutations are denied',async()=>{
  const {cookie}=await login()
  assert.equal((await request('/api/auth/logout',{cookie,body:{},origin:'https://attacker.invalid'})).status,403)
  assert.equal((await request('/api/auth/logout',{cookie,method:'GET'})).status,405)
  assert.equal((await request('/api/auth/logout',{cookie,body:{},headers:{'Content-Type':'text/plain'}})).status,403)
  assert.equal((await request('/api/auth/session',{cookie,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403)
  assert.equal((await request('/api/auth/session',{cookie})).status,200)
 })
 await check('Auth responses are no-store; state-changing GET never succeeds',async()=>{const {cookie}=await login(),response=await request('/api/auth/session',{cookie});assert.match(response.headers.get('cache-control'),/no-store/);assert.equal((await request('/api/auth/pin',{cookie,method:'GET'})).status,405)})
 await check('Only token digests are stored; plaintext cookie is absent from rows',async()=>{assert(fixture);const {cookie}=await login(),rows=fixture.store.sql.prepare('SELECT * FROM sessions').all();assert(rows.length);assert(!JSON.stringify(rows).includes(cookie.split('=')[1]));assert(rows.every(row=>/^[a-f0-9]{64}$/.test(row.token_hash)))})
 await check('Restart persists sessions and persists their revocation (real SQLite file)',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mp-auth-')),path=join(directory,'auth.sqlite')
  let store
  try{
   const data=fixture.store.sql.prepare('SELECT * FROM accounts WHERE username=?').get('admin')
   store=new AuthStore(path);store.importTrusted({lots:[{id:'durable',name:'Durable'}],users:[{id:'durable-user',lotId:'durable',username:'durable',name:'Durable',role:'admin',active:true,pinHash:data.pin_hash,salt:data.pin_salt}]})
   const session=await store.login('durable','1234');store.close();store=new AuthStore(path)
   assert.equal(store.authenticate(session.token).id,'durable-user');store.logout(session.token);store.close();store=new AuthStore(path)
   assert.throws(()=>store.authenticate(session.token),e=>e.status===401)
  }finally{store?.close();await rm(directory,{recursive:true,force:true})}
 })
 await check('Server PIN reset while login is hashing cannot resurrect the old credential',async()=>{
  assert(fixture);const admin=await login(),operator=await login('vendeur','1111');let fire=true
  fixture.store.hooks.beforeLoginCommit=async row=>{if(fire&&row.id==='demo-user-vendeur'){fire=false;await fixture.store.updateUser(admin.cookie.split('=')[1],row.id,{pin:'8888'})}}
  try{
   assert.equal((await request('/api/auth/login',{body:{username:'vendeur',pin:'1111'}})).status,401)
   assert.equal((await request('/api/auth/session',{cookie:operator.cookie})).status,401)
   await login('vendeur','8888');await request('/api/admin/users/demo-user-vendeur',{cookie:admin.cookie,method:'PATCH',body:{pin:'1111'}})
  }finally{fixture.store.hooks.beforeLoginCommit=undefined}
 })
}finally{await fixture?.close()}
console.log(`SERVER SESSION: ${passed} passed / ${failed} failed`);process.exitCode=failed?1:0
