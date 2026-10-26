// m3 — en-têtes de cache des fichiers statiques.
// Défaut v12 : « public,max-age=0 » pour tous les fichiers, y compris les
// bundles hachés par Vite (index-XXXXXXXX.js) → revalidation à chaque visite,
// donc aucun bénéfice du cache tout en gardant le coût réseau.
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixture } from '../../scripts/session-fixture.mjs'

const dir = await mkdtemp(join(tmpdir(), 'mp-cache-'))
let fixture, passed = 0, failed = 0
const check = async (name, fn) => { try { await fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e.message) } }
try {
  await mkdir(join(dir, 'assets'), { recursive: true })
  await mkdir(join(dir, 'ocr'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>t</title>')
  await writeFile(join(dir, 'assets', 'index-DxYRShfl.js'), 'export{}')
  await writeFile(join(dir, 'sw.js'), 'self.addEventListener("install",()=>{})')
  await writeFile(join(dir, 'ocr', 'worker.min.js'), '//ocr')
  fixture = await startFixture({ distDir: dir })

  const header = async (path) => (await fetch(fixture.origin + path)).headers.get('cache-control') || ''

  await check('Bundle haché de /assets : cache long et immuable', async () => {
    const value = await header('/assets/index-DxYRShfl.js')
    assert(/max-age=31536000/.test(value), `attendu 1 an, reçu « ${value} »`)
    assert(/immutable/.test(value), `immutable absent : « ${value} »`)
  })

  await check('index.html et sw.js restent no-store', async () => {
    for (const path of ['/', '/index.html', '/sw.js']) {
      const value = await header(path)
      assert(/no-store/.test(value), `${path} devrait être no-store, reçu « ${value} »`)
    }
  })

  await check('Fichier non haché : cache court, pas immuable', async () => {
    const value = await header('/ocr/worker.min.js')
    assert(!/immutable/.test(value), `immuable à tort : « ${value} »`)
    assert(/max-age=3600/.test(value), `attendu max-age=3600, reçu « ${value} »`)
  })
} finally {
  await fixture?.close()
  await rm(dir, { recursive: true, force: true })
}
console.log(`M3 STATIC CACHE: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
