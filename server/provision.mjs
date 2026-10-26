import { AuthStore, hashServerPin } from './auth-store.mjs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
const store=new AuthStore(resolve(process.env.AUTH_DB||'./.server-data/auth.sqlite'))
try{
 if(process.argv[2]==='import'){
  if(!process.argv[3])throw new Error('Usage: node server/provision.mjs import /secure/users.json')
  store.importTrusted(JSON.parse(await readFile(process.argv[3],'utf8')))
 }else{
  // Read setup secrets on stdin; never a public HTTP registration endpoint.
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>32768)throw new Error('Input too large')}
  const data=JSON.parse(input)
  if(!data.username||!data.pin||!data.lotName)throw new Error('JSON requis : username, name, pin, lotName ; userId/lotId optionnels pour migration')
  const credentials=await hashServerPin(data.pin),lotId=data.lotId||randomUUID(),id=data.userId||randomUUID()
  store.importTrusted({lots:[{id:lotId,name:data.lotName,code:String(data.lotName).slice(0,4).toUpperCase(),active:true,currency:data.currency||'XOF',hourlyRate:500,dailyCap:6000,graceMinutes:15}],users:[{id,lotId,username:data.username,name:data.name||data.username,role:'admin',active:true,pinHash:credentials.hash,salt:credentials.salt}]})
 }
 console.log('Provisionnement terminé. Aucun identifiant secret affiché.')
}finally{store.close()}
