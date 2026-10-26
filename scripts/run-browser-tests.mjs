import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { startFixture } from './session-fixture.mjs'
const fixture=process.env.BASE?null:await startFixture({distDir:resolve('dist')})
const env={...process.env,BASE:process.env.BASE||fixture.origin},files=process.argv.slice(2)
let status=0
try{
 for(const file of files.length?files:['test-v10-browser.mjs','test-v8-browser.mjs','test-v9-browser.mjs','scripts/test-persisted-proof.mjs','scripts/security-review-pin-session.mjs','scripts/test-media-browser.mjs']){
  status=await new Promise(resolve=>{const child=spawn(process.execPath,[file],{env,stdio:'inherit'});child.on('error',()=>resolve(1));child.on('exit',code=>resolve(code||0))})
  if(status)break
 }
}finally{await fixture?.close()}
process.exitCode=status
