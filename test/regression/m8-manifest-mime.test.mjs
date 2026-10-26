import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AuthStore } from '../../server/auth-store.mjs'
import { createAuthServer } from '../../server/http.mjs'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK', name) }
  catch (error) { failed++; console.log('FAIL', name, '-', error.message) }
}

await check('m14 : dist/ est construit avant les régressions', async () => {
  // Sans ce contrôle, l'absence de build se manifestait par un 404 opaque sur
  // /sw.js, indiscernable d'une vraie régression de livraison statique.
  assert.ok(existsSync(resolve('dist/sw.js')), 'dist/sw.js absent : exécuter `npm run build` avant les régressions')
})

const dir = mkdtempSync(join(tmpdir(), 'mp-mime-'))
const store = new AuthStore(join(dir, 'auth.sqlite'))
const port = 20000 + Math.floor(Math.random() * 20000)
const server = createAuthServer({ store, origin: `http://127.0.0.1:${port}`, distDir: resolve('dist') })
await new Promise((r) => server.listen(port, '127.0.0.1', r))
const get = (path) => fetch(`http://127.0.0.1:${port}${path}`)

await check('m14 : le manifeste est servi en application/manifest+json', async () => {
  const res = await get('/manifest.webmanifest')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/manifest+json',
    `content-type reçu : ${res.headers.get('content-type')}`)
})

await check('m14 : le manifeste contient les icônes 192/512 et le mode standalone', async () => {
  const manifest = await (await get('/manifest.webmanifest')).json()
  const sizes = manifest.icons.map((icon) => icon.sizes)
  assert.ok(sizes.includes('192x192'), `tailles : ${sizes.join(',')}`)
  assert.ok(sizes.includes('512x512'), `tailles : ${sizes.join(',')}`)
  assert.equal(manifest.display, 'standalone')
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'aucune icône maskable')
})

await check('m14 : le service worker n’est jamais mis en cache', async () => {
  const res = await get('/sw.js')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control') || '', /no-store/)
})

await check('m14 : les icônes déclarées existent réellement', async () => {
  for (const path of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-512-maskable.png']) {
    const res = await get(path)
    assert.equal(res.status, 200, `${path} introuvable`)
    assert.equal(res.headers.get('content-type'), 'image/png')
  }
})

server.close(); store.close(); rmSync(dir, { recursive: true, force: true })
console.log(`M8 MANIFEST MIME: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
