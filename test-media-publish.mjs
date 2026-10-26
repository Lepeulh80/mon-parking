/**
 * Publication IndexedDB → Storage (src/lib/mediaPublish.js).
 * Vérifie le décodage des data URL, le refus des médias scellés et
 * l'isolation des erreurs : une photo corrompue ne bloque pas les autres.
 */
import assert from 'node:assert/strict'
import { dataUrlToBytes, publishVehicleMedia, summarizePublish } from './src/lib/mediaPublish.js'
import { MediaError, BUCKET } from './src/lib/storageMedia.js'

let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`) }
  catch (e) { fail++; console.log(`FAIL ${name} → ${e.message}`) }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7Y0AAAAASUVORK5CYII='
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA=='

function fakeSb({ failOn = [] } = {}) {
  const put = new Map()
  return {
    _put: put,
    storage: {
      from: (name) => {
        assert.equal(name, BUCKET)
        return {
          async upload(path, blob, opts) {
            if (failOn.some((f) => path.includes(f))) return { data: null, error: { message: 'row-level security' } }
            put.set(path, { size: blob.size, type: blob.type, opts })
            return { data: { path }, error: null }
          },
        }
      },
    },
  }
}

await test('p1 : data URL PNG décodée en octets et MIME exact', () => {
  const { bytes, mime } = dataUrlToBytes(PNG)
  assert.equal(mime, 'image/png')
  assert.ok(bytes.length > 50)
  assert.equal(bytes[0], 0x89, 'signature PNG non conservée')
})

await test('p2 : data URL non base64 ou absente refusée', () => {
  assert.throws(() => dataUrlToBytes('blob:http://x/y'), MediaError)
  assert.throws(() => dataUrlToBytes(null), /data URL attendue/)
  assert.throws(() => dataUrlToBytes('data:image/png,raw'), /base64/)
})

await test('p3 : MIME hors bucket refusé au décodage (gif)', () => {
  assert.throws(() => dataUrlToBytes('data:image/gif;base64,R0lGODlhAQABAAAAACw='), /Type MIME refusé/)
})

await test('p4 : photos publiées, chemin <lot>/<veh>/photo/<id>.<ext>', async () => {
  const sb = fakeSb()
  const report = await publishVehicleMedia(sb, {
    lotId: 'lot_A1', vehicleId: 'v1En cours',
    photos: [{ id: 'p1', data: PNG, kind: 'photo' }],
  })
  assert.equal(report.published, 0, 'identifiant véhicule non conforme accepté')
  assert.equal(report.failed, 1)
})

await test('p5 : lot et véhicule valides → publication et rapport', async () => {
  const sb = fakeSb()
  const report = await publishVehicleMedia(sb, {
    lotId: 'lot_A1', vehicleId: 'veh-001',
    photos: [
      { id: 'p1', data: PNG, kind: 'photo' },
      { id: 'f2', data: JPG, kind: 'spin' },
    ],
  })
  assert.equal(report.published, 2)
  assert.deepEqual(report.objects, ['lot_A1/veh-001/photo/p1.png', 'lot_A1/veh-001/spin/f2.jpg'])
  assert.equal(sb._put.get('lot_A1/veh-001/photo/p1.png').type, 'image/png')
})

await test('p6 : média scellé ignoré, jamais envoyé en clair', async () => {
  const sb = fakeSb()
  const report = await publishVehicleMedia(sb, {
    lotId: 'lot_A1', vehicleId: 'veh-001',
    photos: [{ id: 'e1', data: PNG, kind: 'photo', enc: true }],
  })
  assert.equal(report.published, 0)
  assert.equal(report.skipped, 1)
  assert.equal(sb._put.size, 0, 'un média scellé a été téléversé')
  assert.match(report.errors[0].reason, /scellé par le coffre/)
})

await test('p7 : une image corrompue n’empêche pas les autres', async () => {
  const sb = fakeSb()
  const report = await publishVehicleMedia(sb, {
    lotId: 'lot_A1', vehicleId: 'veh-001',
    photos: [
      { id: 'ok1', data: PNG, kind: 'photo' },
      { id: 'bad', data: 'pas-une-data-url', kind: 'photo' },
      { id: 'ok2', data: JPG, kind: 'photo' },
    ],
  })
  assert.equal(report.published, 2)
  assert.equal(report.failed, 1)
  assert.equal(report.errors[0].id, 'bad')
})

await test('p8 : refus RLS d’un objet compté en échec, les autres passent', async () => {
  const sb = fakeSb({ failOn: ['refuse'] })
  const report = await publishVehicleMedia(sb, {
    lotId: 'lot_A1', vehicleId: 'veh-001',
    photos: [{ id: 'refuse', data: PNG }, { id: 'accepte', data: PNG }],
  })
  assert.equal(report.published, 1)
  assert.equal(report.failed, 1)
  assert.match(report.errors[0].reason, /row-level security/)
})

await test('p9 : rapport vide → message honnête, pas de faux succès', () => {
  assert.equal(summarizePublish(null), 'Aucune publication effectuée.')
  assert.equal(summarizePublish({ published: 0, skipped: 0, failed: 0 }), '0 publiée(s).')
})

await test('p10 : résumé détaille ignorées et échecs', () => {
  assert.equal(
    summarizePublish({ published: 3, skipped: 1, failed: 2 }),
    '3 publiée(s), 1 ignorée(s) (chiffrées), 2 en échec.'
  )
})

console.log(`\nPUBLICATION MÉDIAS : ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
