// Tests des primitives média (pures) et de la migration Dexie v8.
// Aucun DOM : photoMath.js est volontairement sans dépendance navigateur.
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  frameAngle, angleToIndex, stepIndex, dragToIndex, naturalCompare, orderFilesByName,
  nextSort, spinHint, storageLevel, formatBytes, isAcceptedMime, isTooLarge,
  MAX_SOURCE_BYTES, MIN_FRAMES, RECOMMENDED_FRAMES,
} from './src/lib/photoMath.js'
import { db } from './src/lib/db.js'

let passed = 0, failed = 0
async function check(name, fn) {
  try { await fn(); passed++; console.log('OK', name) }
  catch (error) { failed++; console.log('FAIL', name, '-', error.message) }
}

const eq = (actual, expected, label) =>
  assert.deepEqual(actual, expected, `${label} : attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`)

/* ---------- 1. Géométrie de la rotation ---------- */
await check('m15 : frameAngle répartit 24 prises sur 360°', () => {
  eq(frameAngle(0, 24), 0, 'prise 0')
  eq(frameAngle(1, 24), 15, 'prise 1')
  eq(frameAngle(12, 24), 180, 'prise 12')
  eq(frameAngle(23, 24), 345, 'dernière prise')
})

await check('m15 : frameAngle ne dépasse jamais 359°', () => {
  for (const total of [3, 7, 12, 36]) {
    for (let i = 0; i < total; i++) {
      const angle = frameAngle(i, total)
      assert.ok(angle >= 0 && angle < 360, `${i}/${total} -> ${angle}`)
    }
  }
})

await check('m15 : angleToIndex inverse frameAngle sur un tour complet', () => {
  for (const total of [8, 24, 36]) {
    for (let i = 0; i < total; i++) eq(angleToIndex(frameAngle(i, total), total), i, `${i}/${total}`)
  }
})

await check('m15 : stepIndex boucle dans les deux sens', () => {
  eq(stepIndex(0, -1, 24), 23, 'recul depuis la première')
  eq(stepIndex(23, 1, 24), 0, 'avance depuis la dernière')
  eq(stepIndex(5, 30, 24), 11, 'grand saut modulo')
})

await check('m15 : total nul ou absent ne provoque pas de division par zéro', () => {
  eq(frameAngle(3, 0), 0, 'frameAngle')
  eq(stepIndex(3, 1, 0), 0, 'stepIndex')
  eq(dragToIndex(0, 100, 0), 0, 'dragToIndex')
})

/* ---------- 2. Glissement (drag) ---------- */
await check('m15 : glisser vers la gauche avance dans la rotation', () => {
  eq(dragToIndex(0, -180, 24, 18), 10, 'gauche de 180 px')
  eq(dragToIndex(0, 180, 24, 18), 14, 'droite de 180 px (modulo)')
})

await check('m15 : un micro-glissement ne change pas de prise', () => {
  eq(dragToIndex(7, 3, 24, 18), 7, '3 px ne doivent pas sauter une image')
})

await check('m15 : le glissement reste borné sur l’ensemble des prises', () => {
  for (const dx of [-5000, -400, -1, 0, 1, 400, 5000]) {
    const index = dragToIndex(0, dx, 24, 18)
    assert.ok(Number.isInteger(index) && index >= 0 && index < 24, `dx=${dx} -> ${index}`)
  }
})

/* ---------- 3. Ordre d’import ---------- */
await check('m15 : tri naturel des fichiers (cadre-2 avant cadre-10)', () => {
  eq(naturalCompare('cadre-2.jpg', 'cadre-10.jpg') < 0, true, 'numérique')
  const files = [{ name: '10.jpg' }, { name: '2.jpg' }, { name: '1.jpg' }]
  eq(orderFilesByName(files).map((f) => f.name), ['1.jpg', '2.jpg', '10.jpg'], 'ordre')
})

await check('m15 : les fichiers déjà importés sont immuables', () => {
  const files = [{ name: 'b.jpg' }, { name: 'a.jpg' }]
  orderFilesByName(files)
  eq(files.map((f) => f.name), ['b.jpg', 'a.jpg'], 'tableau source modifié')
})

await check('m15 : nextSort repart après le plus grand sort existant', () => {
  eq(nextSort([{ sort: 1 }, { sort: 7 }, { sort: 3 }]), 8, 'après 7')
  eq(nextSort([]), 1, 'table vide')
})

/* ---------- 4. Messages et budgets ---------- */
await check('m15 : une seule photo ne peut pas tourner', () => {
  assert.match(spinHint(1), /ne peut pas tourner/i)
  assert.match(spinHint(0), /ne peut pas tourner/i)
})

await check('m15 : les seuils de séquence sont annoncés', () => {
  assert.match(spinHint(MIN_FRAMES - 1), /minimum pour un rendu crédible/i)
  assert.match(spinHint(RECOMMENDED_FRAMES), /fluide/i)
})

await check('m15 : le niveau de stockage alerte avant saturation', () => {
  eq(storageLevel(10, 100).level, 'ok', '10 %')
  eq(storageLevel(80, 100).level, 'élevé', '80 %')
  eq(storageLevel(95, 100).level, 'critique', '95 %')
  eq(storageLevel(10, 0).level, 'ok', 'quota inconnu')
})

await check('m15 : formatBytes reste lisible', () => {
  eq(formatBytes(900), '900 o', 'octets')
  eq(formatBytes(2048), '2 Ko', 'kilo-octets')
  eq(formatBytes(5 * 1024 * 1024), '5.0 Mo', 'méga-octets')
})

await check('m15 : types et taille de fichier sont filtrés', () => {
  eq(isAcceptedMime('image/jpeg'), true, 'jpeg')
  eq(isAcceptedMime('image/heic'), false, 'heic non pris en charge')
  eq(isAcceptedMime('application/pdf'), false, 'pdf')
  eq(isTooLarge(MAX_SOURCE_BYTES), false, 'exactement à la limite')
  eq(isTooLarge(MAX_SOURCE_BYTES + 1), true, 'un octet de trop')
})

/* ---------- 5. Migration Dexie v8 (additive) ---------- */
await check('m15 : la base ouvre la version 9 avec les tables vehiclePhotos et vaults', async () => {
  await db.open()
  // v19 : la version est passée à 9 (coffre de chiffrement). Le test vérifie
  // la version COURANTE et les tables attendues, pas un numéro historique figé.
  eq(db.verno, 9, 'version Dexie')
  assert(db.tables.some((t) => t.name === 'vaults'), 'table vaults absente')
  assert.ok(db.vehiclePhotos, 'table vehiclePhotos absente')
})

await check('m15 : un véhicule antérieur (photo unique) reste lisible', async () => {
  await db.vehicles.put({
    id: 'veh_legacy', lotId: 'lot_t', plate: 'CI 1111 AA', brand: 'Toyota', model: 'Corolla',
    status: 'stock', price: 1000, photo: 'data:image/jpeg;base64,AAAA', createdAt: new Date().toISOString(),
  })
  const row = await db.vehicles.get('veh_legacy')
  assert.equal(row.photo, 'data:image/jpeg;base64,AAAA', 'photo héritée perdue')
})

await check('m15 : photoCount et frameCount sont dérivés sans casser l’existant', async () => {
  await db.vehiclePhotos.bulkAdd([
    { id: 'pho_1', lotId: 'lot_t', vehicleId: 'veh_legacy', kind: 'photo', sort: 1, thumb: 't1', data: 'd1', bytes: 10, cover: true, createdAt: new Date().toISOString() },
    { id: 'pho_2', lotId: 'lot_t', vehicleId: 'veh_legacy', kind: 'photo', sort: 2, thumb: 't2', data: 'd2', bytes: 10, cover: false, createdAt: new Date().toISOString() },
    { id: 'frm_1', lotId: 'lot_t', vehicleId: 'veh_legacy', kind: 'frame', sort: 1, thumb: 't3', data: 'd3', bytes: 10, createdAt: new Date().toISOString() },
    { id: 'frm_2', lotId: 'lot_t', vehicleId: 'veh_legacy', kind: 'frame', sort: 2, thumb: 't4', data: 'd4', bytes: 10, createdAt: new Date().toISOString() },
  ])
  const photos = await db.vehiclePhotos.where('[vehicleId+kind]').equals(['veh_legacy', 'photo']).toArray()
  const frames = await db.vehiclePhotos.where('[vehicleId+kind]').equals(['veh_legacy', 'frame']).toArray()
  eq(photos.length, 2, 'photos')
  eq(frames.length, 2, 'prises')
  eq(frames.sort((a, b) => a.sort - b.sort).map((f) => f.id), ['frm_1', 'frm_2'], 'ordre des prises')
  assert.ok(photos.some((p) => p.cover), 'aucune couverture')
})

await check('m15 : supprimer un véhicule n’efface pas ses ventes (aucune régression)', async () => {
  // deleteVehicle (admin.js) supprime véhicule + mouvements, pas les ventes.
  const before = await db.sales.count().catch(() => 0)
  await db.vehicles.delete('veh_legacy')
  eq(await db.vehicles.get('veh_legacy'), undefined, 'véhicule encore présent')
  eq(await db.sales.count().catch(() => 0), before, 'ventes modifiées')
})

console.log(`MEDIA: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
