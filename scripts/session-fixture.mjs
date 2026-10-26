// Test fixture only: the production server never imports or calls seedDemo().
import 'fake-indexeddb/auto'
import { seedDemo, db } from '../src/lib/db.js'
import { AuthStore } from '../server/auth-store.mjs'
import { createAuthServer } from '../server/http.mjs'
import { createServer } from 'node:net'
export async function makeStore(options={}){
 await seedDemo()
 const store=new AuthStore(options.path||':memory:',options)
 store.importTrusted({lots:await db.lots.toArray(),users:await db.users.toArray()})
 return store
}
export async function startFixture({store,port,distDir}={}){
 store||=await makeStore()
 if(!port){const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));port=probe.address().port;await new Promise(r=>probe.close(r))}
 const origin=`http://127.0.0.1:${port}`,server=createAuthServer({store,origin,distDir})
 await new Promise(r=>server.listen(port,'127.0.0.1',r))
 return {store,server,origin,close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));store.close()}}
}
