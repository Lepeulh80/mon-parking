// Session authority is the same-origin server, never an IndexedDB/localStorage row.
export async function authRequest(path,{method='GET',body}={}) {
 let response
 try{
  response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
 }catch(cause){
  // m10 : distinguer panne réseau, serveur absent et réponse illisible donne
  // un diagnostic exploitable au lieu d'un message unique et trompeur.
  const offline=typeof navigator!=='undefined'&&navigator.onLine===false
  const error=new Error(offline?'Hors ligne : la vérification de session nécessite le réseau.':'Serveur d’authentification injoignable. Vérifiez la connexion puis réessayez.')
  error.status=0;error.offline=offline;error.cause=cause;throw error
 }
 let data
 try{data=await response.json()}
 catch{
  const error=new Error(response.ok?'Réponse du serveur illisible. Rechargez la page.':`Réponse du serveur invalide (statut ${response.status}). Vérifiez le reverse proxy puis réessayez.`)
  error.status=response.status;error.invalidPayload=true;throw error
 }
 if(!response.ok){const error=new Error(data?.error||`Authentification refusée (statut ${response.status}).`);error.status=response.status;error.retryAfter=Number(response.headers.get('Retry-After'))||null;throw error}
 return data
}
export async function signIn(username,pin){
 const result=await authRequest('/api/auth/login',{method:'POST',body:{username,pin}})
 // v19 : le PIN seul ne suffit plus quand la 2FA est active. Le serveur renvoie
 // un défi à usage unique (5 min) au lieu d'un cookie de session.
 if(result.mfaRequired)return result
 localStorage.removeItem('mp_logout_pending');return result
}
export const verifyMfa=(challenge,code)=>authRequest('/api/auth/mfa',{method:'POST',body:{challenge,code}})
export const enrollTotp=()=>authRequest('/api/auth/mfa/enroll',{method:'POST',body:{}})
export const activateTotp=code=>authRequest('/api/auth/mfa/activate',{method:'POST',body:{code}})
export const disableTotp=pin=>authRequest('/api/auth/mfa/disable',{method:'POST',body:{pin}})
export async function restoreSession(){
 if(typeof navigator!=='undefined'&&navigator.onLine===false)throw new Error('Hors ligne : la vérification de session nécessite le réseau.')
 const result=await authRequest('/api/auth/status')
 if(!result.authenticated){const error=new Error('Connexion requise.');error.status=401;throw error}
 return result
}
export const signOut=()=>authRequest('/api/auth/logout',{method:'POST',body:{}})
export const changeSessionPin=(currentPin,newPin)=>authRequest('/api/auth/pin',{method:'POST',body:{currentPin,newPin}})
export const switchSessionLot=lotId=>authRequest('/api/auth/switch-lot',{method:'POST',body:{lotId}})
export function notifyAuthChange(){
 if(typeof window==='undefined')return
 window.dispatchEvent(new Event('mp-auth-check'))
 try{const channel=new BroadcastChannel('mp-auth');channel.postMessage('recheck');channel.close()}catch{/* Polling/focus remain available. */}
}
