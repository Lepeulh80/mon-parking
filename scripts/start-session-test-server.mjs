// Explicit isolated demo fixture. Never use this script for production provisioning.
import { startFixture } from './session-fixture.mjs'
import { resolve } from 'node:path'
const fixture=await startFixture({port:Number(process.env.PORT||4200),distDir:resolve('dist')})
console.log(`TEST_AUTH_SERVER=${fixture.origin}`)
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void fixture.close().then(()=>process.exit(0)))
