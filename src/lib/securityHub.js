import { client } from './supabase.js'
const bytes=(s)=>new TextEncoder().encode(s)
function base64(array){let s='';for(const x of new Uint8Array(array))s+=String.fromCharCode(x);return btoa(s)}
function unbase64(s){if(typeof s!=='string'||s.length>40000000)throw new Error('Enveloppe invalide.');return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
const ITERATIONS=310000
async function derive(password,salt,iterations){const material=await crypto.subtle.importKey('raw',bytes(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
/** Real client-side authenticated encryption. Password/key is NEVER persisted. */
export async function encryptBackup(value,password){if(String(password).length<12)throw new Error('Phrase secrète de 12 caractères minimum.');const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await derive(password,salt,ITERATIONS);const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:bytes('MON-PARKING-BACKUP-V1')},key,bytes(JSON.stringify(value)));return {app:'MON PARKING',version:1,algorithm:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:base64(salt),iv:base64(iv),ciphertext:base64(ciphertext)}}
export async function decryptBackup(envelope,password){if(envelope?.version!==1||envelope.algorithm!=='AES-256-GCM'||envelope.kdf!=='PBKDF2-SHA256'||envelope.iterations!==ITERATIONS)throw new Error('Format chiffré non pris en charge.');const salt=unbase64(envelope.salt),iv=unbase64(envelope.iv);if(salt.length!==16||iv.length!==12)throw new Error('Enveloppe invalide.');try{const key=await derive(password,salt,envelope.iterations),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:bytes('MON-PARKING-BACKUP-V1')},key,unbase64(envelope.ciphertext));return JSON.parse(new TextDecoder().decode(plain))}catch{throw new Error('Phrase incorrecte ou sauvegarde altérée.')}}

function sbOrThrow(sb){const c=sb||client();if(!c)throw new Error('Supabase non configuré. Aucun MFA simulé.');return c}
export async function mfaStatus({sb}={}){const c=sbOrThrow(sb);const [{data:factors,error},{data:level,error:levelError}]=await Promise.all([c.auth.mfa.listFactors(),c.auth.mfa.getAuthenticatorAssuranceLevel()]);if(error||levelError)throw error||levelError;return {factors:factors?.totp||[],currentLevel:level?.currentLevel||'aal1',nextLevel:level?.nextLevel||'aal1'}}
export async function enrollTotp({sb}={}){const {data,error}=await sbOrThrow(sb).auth.mfa.enroll({factorType:'totp',friendlyName:'MON PARKING'});if(error)throw error;return data}
export async function verifyTotp(factorId,code,{sb}={}){if(!/^\d{6}$/.test(code))throw new Error('Code TOTP de 6 chiffres requis.');const c=sbOrThrow(sb),{data,error}=await c.auth.mfa.challenge({factorId});if(error)throw error;const result=await c.auth.mfa.verify({factorId,challengeId:data.id,code});if(result.error)throw result.error;return result.data}
export async function uploadEncryptedSnapshot(lotId,envelope,{sb}={}){const c=sbOrThrow(sb);const status=await mfaStatus({sb:c});if(status.currentLevel!=='aal2')throw new Error('MFA AAL2 requis pour sauvegarder dans le coffre cloud.');const {data,error}=await c.rpc('v10_store_encrypted_snapshot',{p_lot:lotId,p_envelope:envelope});if(error)throw error;return data}
export class ExternalProviderRequired extends Error{constructor(provider){super(`${provider} non connecté : serveur, contrat/consentement et identifiants OAuth requis.`);this.name='ExternalProviderRequired'}}
/** No API secret, bank password or OAuth refresh token is accepted in the browser. */
export async function requestIntegration(provider,{endpoint,accessToken,payload={}}={}){
 if(!['bank','drive','dropbox','webauthn','push'].includes(provider))throw new Error('Prestataire inconnu.')
 if(!endpoint||!accessToken)throw new ExternalProviderRequired(provider)
 const url=new URL(endpoint,globalThis.location?.origin||'https://localhost');if(url.protocol!=='https:')throw new Error('Endpoint HTTPS requis.')
 const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${accessToken}`},body:JSON.stringify({...payload,provider}),credentials:'omit'})
 if(!res.ok)throw new Error(`Service ${provider} : HTTP ${res.status}`);return res.json()
}
export async function webAuthnAuthenticate({endpoint,accessToken}={}){
 if(!globalThis.PublicKeyCredential||!navigator.credentials)throw new Error('WebAuthn indisponible sur ce navigateur.')
 const options=await requestIntegration('webauthn',{endpoint,accessToken,payload:{action:'challenge'}})
 const decode=(v)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
 const assertion=await navigator.credentials.get({publicKey:{...options.publicKey,challenge:decode(options.publicKey.challenge),allowCredentials:(options.publicKey.allowCredentials||[]).map(c=>({...c,id:decode(c.id)})),userVerification:'required'}})
 return requestIntegration('webauthn',{endpoint,accessToken,payload:{action:'verify',credential:{id:assertion.id,type:assertion.type,rawId:base64(assertion.rawId),response:{clientDataJSON:base64(assertion.response.clientDataJSON),authenticatorData:base64(assertion.response.authenticatorData),signature:base64(assertion.response.signature),userHandle:assertion.response.userHandle?base64(assertion.response.userHandle):null}}}})
}
export async function subscribePush(vapidPublicKey){if(!vapidPublicKey)throw new ExternalProviderRequired('push');if(!('serviceWorker'in navigator)||!('PushManager'in globalThis))throw new Error('Web Push non pris en charge.');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Notifications refusées.');const key=Uint8Array.from(atob(vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));return (await navigator.serviceWorker.ready).pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key})}
