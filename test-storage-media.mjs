/**
 * Passerelle Storage (src/lib/storageMedia.js).
 *
 * Ne remplace pas la suite RLS : il prouve le contrat CLIENT (chemins, garde-fous,
 * propagation d'erreur) avec un faux bucket en mémoire qui imite l'API supabase-js.
 * Les autorisations restent prouvées par les 12 assertions storage de `npm run test:rls`.
 */
import assert from 'node:assert/strict'
import {
  BUCKET, MAX_BYTES, mediaPath, validateMedia, uploadMedia, signedMediaUrl,
  removeMedia, listVehicleMedia, countLotMedia, MediaError,
} from './src/lib/storageMedia.js'

let pass = 0
let fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`) }
  catch (e) { fail++; console.log(`FAIL ${name} → ${e.message}`) }
}

/** Bucket factice : mêmes signatures que storage.from(bucket).* */
function fakeSupabase({ failUpload = false, failSign = false } = {}) {
  const objects = new Map()
  return {
    _objects: objects,
    storage: {
      from(name) {
        assert.equal(name, BUCKET)
        return {
          async upload(path, blob, opts) {
            if (failUpload) return { data: null, error: { message: 'new row violates row-level security policy' } }
            objects.set(path, { blob, opts })
            return { data: { path, id: 'x' }, error: null }
          },
          async createSignedUrl(path, seconds) {
            if (failSign) return { data: null, error: { message: 'Object not found' } }
            if (!objects.has(path)) return { data: null, error: { message: 'Object not found' } }
            return { data: { signedUrl: `https://exemple.test/${BUCKET}/${path}?token=t&exp=${seconds}` }, error: null }
          },
          async remove(paths) {
            const removed = paths.filter((p) => objects.delete(p))
            return { data: removed, error: null }
          },
          async list(prefix, opts) {
            const entries = [...objects.keys()]
              .filter((p) => p.startsWith(`${prefix}/`.replace(/\/+/g, '/')))
              .map((p) => ({ name: p.slice(prefix.length + 1), metadata: { size: objects.get(p).blob.size, mimetype: objects.get(p).opts.contentType } }))
            return { data: entries.slice(0, opts?.limit || 100), error: null }
          },
        }
      },
    },
  }
}

const jpeg = (size = 2048) => ({ size, type: 'image/jpeg' })
const base = { lotId: 'lot_A1', vehicleId: 'veh-001', kind: 'photo', mime: 'image/jpeg' }

/* ---------- 1. chemin ---------- */
await test('s1 : chemin conforme à la policy (<lot_id>/<vehicle_id>/<kind>/<id>.<ext>)', () => {
  assert.equal(mediaPath({ ...base, objectId: 'obj1' }), 'lot_A1/veh-001/photo/obj1.jpg')
})

await test('s2 : extension déduite du MIME, jamais du nom fourni', () => {
  assert.equal(mediaPath({ ...base, kind: 'spin', mime: 'image/webp', objectId: 'o2' }), 'lot_A1/veh-001/spin/o2.webp')
  assert.equal(mediaPath({ ...base, mime: 'image/avif', objectId: 'o3' }), 'lot_A1/veh-001/photo/o3.avif')
})

await test('s3 : traversée de répertoire refusée avant tout réseau', () => {
  for (const bad of ['../evasion', 'lot/../x', '.hidden', 'a b', '', 'x'.repeat(65)]) {
    assert.throws(() => mediaPath({ ...base, objectId: bad }), MediaError, `accepté à tort : ${bad}`)
  }
  assert.throws(() => mediaPath({ ...base, lotId: '../B', objectId: 'o' }), /lotId invalide/)
})

await test('s4 : kind hors liste blanche refusé', () => {
  assert.throws(() => mediaPath({ ...base, kind: 'exe', objectId: 'o' }), /Type de média inconnu/)
})

await test('s5 : MIME hors bucket refusé (gif, svg, pdf)', () => {
  for (const mime of ['image/gif', 'image/svg+xml', 'application/pdf']) {
    assert.throws(() => mediaPath({ ...base, mime, objectId: 'o' }), /Type MIME refusé/)
  }
})

/* ---------- 2. garde-fous fichier ---------- */
await test('s6 : limite 8 Mio = celle du bucket', () => {
  assert.equal(MAX_BYTES, 8 * 1024 * 1024)
  assert.equal(validateMedia({ blob: jpeg(MAX_BYTES), mime: 'image/jpeg' }), true)
  assert.throws(() => validateMedia({ blob: jpeg(MAX_BYTES + 1), mime: 'image/jpeg' }), /trop volumineux/)
})

await test('s7 : fichier vide ou absent refusé', () => {
  assert.throws(() => validateMedia({ blob: jpeg(0), mime: 'image/jpeg' }), /Fichier vide/)
  assert.throws(() => validateMedia({ blob: null, mime: 'image/jpeg' }), /Fichier illisible/)
})

await test('s8 : média scellé refusé explicitement (pas de corruption silencieuse)', () => {
  assert.throws(() => validateMedia({ blob: jpeg(), mime: 'image/jpeg', encrypted: true }), /Média scellé par le coffre/)
})

/* ---------- 3. aller-retour ---------- */
await test('s9 : téléversement puis URL signée courte', async () => {
  const sb = fakeSupabase()
  const { path } = await uploadMedia(sb, { ...base, objectId: 'p1', blob: jpeg() })
  assert.equal(path, 'lot_A1/veh-001/photo/p1.jpg')
  const url = await signedMediaUrl(sb, path)
  assert.match(url, /^https:\/\/exemple\.test\/vehicle-media\/lot_A1\/veh-001\/photo\/p1\.jpg\?token=t&exp=3600$/)
  assert.equal(sb._objects.get(path).opts.contentType, 'image/jpeg')
  assert.equal(sb._objects.get(path).opts.upsert, true)
})

await test('s10 : expiration bornée entre 60 s et 24 h', async () => {
  const sb = fakeSupabase()
  const { path } = await uploadMedia(sb, { ...base, objectId: 'p2', blob: jpeg() })
  assert.match(await signedMediaUrl(sb, path, 1), /exp=60$/)
  assert.match(await signedMediaUrl(sb, path, 10_000_000), /exp=86400$/)
})

await test('s11 : refus RLS du serveur remonté avec le chemin et la cause', async () => {
  const sb = fakeSupabase({ failUpload: true })
  await assert.rejects(
    () => uploadMedia(sb, { ...base, objectId: 'p3', blob: jpeg() }),
    (e) => e instanceof MediaError && e.code === 'UPLOAD_FAILED' && /row-level security/.test(e.message) && /lot_A1\/veh-001\/photo\/p3\.jpg/.test(e.message)
  )
})

await test('s12 : URL signée sur un objet absent échoue, pas d’URL vide silencieuse', async () => {
  const sb = fakeSupabase()
  await assert.rejects(() => signedMediaUrl(sb, 'lot_A1/veh-001/photo/absent.jpg'), /URL signée refusée/)
})

await test('s13 : liste et comptage par véhicule / par parking', async () => {
  const sb = fakeSupabase()
  await uploadMedia(sb, { ...base, objectId: 'a', blob: jpeg(100) })
  await uploadMedia(sb, { ...base, kind: 'spin', objectId: 'b', blob: jpeg(200) })
  const list = await listVehicleMedia(sb, base)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((r) => r.size).sort((x, y) => x - y), [100, 200])
  assert.equal(list[0].mime, 'image/jpeg')
  assert.equal(await countLotMedia(sb, 'lot_A1'), 2)
})

await test('s14 : suppression effective, puis URL indisponible', async () => {
  const sb = fakeSupabase()
  const { path } = await uploadMedia(sb, { ...base, objectId: 'd1', blob: jpeg() })
  assert.equal(await removeMedia(sb, path), true)
  await assert.rejects(() => signedMediaUrl(sb, path), /URL signée refusée/)
})

await test('s15 : client absent ou bucket manquant → MediaError, pas TypeError', async () => {
  await assert.rejects(() => uploadMedia(null, { ...base, objectId: 'z', blob: jpeg() }), (e) => e.code === 'NO_CLIENT')
  await assert.rejects(() => uploadMedia({ storage: {} }, { ...base, objectId: 'z', blob: jpeg() }), (e) => e.code === 'NO_CLIENT')
  await assert.rejects(() => uploadMedia({ storage: { from: () => ({}) } }, { ...base, objectId: 'z', blob: jpeg() }), (e) => e.code === 'NO_BUCKET')
})

await test('s16 : aucun secret ni clé écrit en dur dans le module', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./src/lib/storageMedia.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}/, 'jeton JWT en dur')
  assert.doesNotMatch(src, /service_role/i, 'clé service_role en dur')
})

console.log(`\nSTORAGE MEDIA : ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
