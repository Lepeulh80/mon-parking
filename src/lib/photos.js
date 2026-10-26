// Galerie photos + séquence 360° d'un véhicule, stockées dans IndexedDB.
//
// Pourquoi pas S3/Cloudinary ni multer : cette application est une PWA
// hors-ligne dont les données vivent dans Dexie (IndexedDB) et dont le serveur
// Node ne sert QUE l'authentification (server/http.mjs). Il n'existe aucune
// route d'upload, et le scan de plaques, les ventes et les tickets doivent
// fonctionner sans réseau. Envoyer les photos sur un CDN casserait l'usage
// hors-ligne et supposerait un backend de fichiers qui n'existe pas.
// Les images sont donc compressées côté navigateur (canvas) puis stockées en
// IndexedDB, avec un budget de stockage surveillé (voir storageReport).
// Depuis la v19, si le coffre du parking est déverrouillé, chaque image et sa
// vignette sont chiffrées en AES-256-GCM (voir photoCrypto.js) : le champ
// `enc` de la ligne indique que `data`/`thumb` sont des charges `enc1:…`.
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uid, nowIso } from './db.js'
import { encryptText, isEncryptedValue, isUnlocked, openMedia, touch } from './photoCrypto.js'
import {
  FRAME, PHOTO, MAX_IMAGE_EDGE, THUMB_EDGE, QUALITY,
  isAcceptedMime, isTooLarge, formatBytes, nextSort, orderFilesByName,
} from './photoMath.js'

export const MEDIA_TABLE = 'vehiclePhotos'
export { FRAME, PHOTO }

// ---------- compression ----------
async function toJpeg(file, maxEdge, quality) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas indisponible dans ce navigateur.')
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const data = canvas.toDataURL('image/jpeg', quality)
  return { data, width, height, bytes: Math.round((data.length * 3) / 4) }
}

// Une source -> {full, thumb}. Refus explicites plutôt que silencieux.
export async function prepareImage(file) {
  if (!file) throw new Error('Aucun fichier reçu.')
  if (!isAcceptedMime(file.type)) throw new Error(`${file.name} : format non pris en charge (JPEG, PNG, WebP, AVIF).`)
  if (isTooLarge(file.size)) throw new Error(`${file.name} : ${formatBytes(file.size)} dépasse la limite de 15 Mo.`)
  const full = await toJpeg(file, MAX_IMAGE_EDGE, QUALITY)
  const thumb = await toJpeg(file, THUMB_EDGE, 0.7)
  return { data: full.data, thumb: thumb.data, width: full.width, height: full.height, bytes: full.bytes + thumb.bytes, name: file.name }
}

// ---------- écriture ----------
// files : FileList ou tableau. kind : 'photo' (galerie) ou 'frame' (séquence 360°).
// Retourne le détail des refus pour que l'interface puisse les afficher.
export async function addVehiclePhotos(lotId, vehicleId, files, { kind = PHOTO } = {}) {
  const list = orderFilesByName([...(files || [])])
  if (!list.length) return { added: [], rejected: [] }
  const vehicle = await db.vehicles.get(vehicleId)
  if (!vehicle) throw new Error('Véhicule introuvable.')
  const existing = await db.vehiclePhotos.where('vehicleId').equals(vehicleId).toArray()
  let sort = nextSort(existing.filter((row) => row.kind === kind))
  const added = []
  const rejected = []
  for (const file of list) {
    try {
      const prepared = await prepareImage(file)
      // v19 : si le coffre du parking est déverrouillé, les DEUX images
      // (pleine et vignette) sont chiffrées séparément — une vignette en clair
      // divulguerait déjà le véhicule et la plaque.
      const sealed = isUnlocked(lotId)
      const data = sealed ? await encryptText(lotId, prepared.data) : prepared.data
      const thumb = sealed ? await encryptText(lotId, prepared.thumb) : prepared.thumb
      const row = {
        id: uid('pho'), lotId, vehicleId, kind, sort: sort++,
        data, thumb, enc: sealed, bytes: prepared.bytes,
        width: prepared.width, height: prepared.height, name: prepared.name,
        cover: false, createdAt: nowIso(),
      }
      await db.vehiclePhotos.add(row)
      added.push(row)
    } catch (error) {
      rejected.push({ name: file?.name || 'fichier', reason: error.message })
    }
  }
  // La première image de la galerie devient la couverture, et vehicles.photo
  // reste synchronisé pour les vignettes existantes (aucune régression).
  const gallery = await db.vehiclePhotos.where('[vehicleId+kind]').equals([vehicleId, PHOTO]).sortBy('sort')
  const frames = await db.vehiclePhotos.where('[vehicleId+kind]').equals([vehicleId, FRAME]).count()
  const cover = gallery.find((row) => row.cover) || gallery[0] || null
  await db.transaction('rw', db.vehicles, db.vehiclePhotos, async () => {
    if (cover && !cover.cover) await db.vehiclePhotos.update(cover.id, { cover: true })
    await db.vehicles.update(vehicleId, {
      // `cover.thumb` peut être chiffré : l'affichage passe par resolveThumb().
      photo: cover ? cover.thumb : null,
      photoCount: gallery.length,
      frameCount: frames,
      mediaUpdatedAt: nowIso(),
    })
  })
  return { added, rejected }
}

export async function removeVehiclePhoto(vehicleId, photoId) {
  await db.transaction('rw', db.vehiclePhotos, db.vehicles, async () => {
    const row = await db.vehiclePhotos.get(photoId)
    await db.vehiclePhotos.delete(photoId)
    const rest = await db.vehiclePhotos.where('vehicleId').equals(vehicleId).sortBy('sort')
    const gallery = rest.filter((p) => p.kind === PHOTO)
    const cover = gallery.find((p) => p.cover) || gallery[0] || null
    if (row?.cover && cover) await db.vehiclePhotos.update(cover.id, { cover: true })
    await db.vehicles.update(vehicleId, {
      // `cover.thumb` peut être chiffré : l'affichage passe par resolveThumb().
      photo: cover ? cover.thumb : null,
      photoCount: gallery.length,
      frameCount: rest.filter((p) => p.kind === FRAME).length,
      mediaUpdatedAt: nowIso(),
    })
  })
}

export async function setCoverPhoto(vehicleId, photoId) {
  const rows = await db.vehiclePhotos.where('[vehicleId+kind]').equals([vehicleId, PHOTO]).toArray()
  const target = rows.find((row) => row.id === photoId)
  if (!target) throw new Error('Photo introuvable dans la galerie.')
  await db.transaction('rw', db.vehiclePhotos, db.vehicles, async () => {
    for (const row of rows) if (!!row.cover !== (row.id === photoId)) await db.vehiclePhotos.update(row.id, { cover: row.id === photoId })
    await db.vehicles.update(vehicleId, { photo: target.thumb, mediaUpdatedAt: nowIso() })
  })
}

export async function moveFrame(vehicleId, photoId, delta) {
  const rows = await db.vehiclePhotos.where('[vehicleId+kind]').equals([vehicleId, FRAME]).sortBy('sort')
  const index = rows.findIndex((row) => row.id === photoId)
  const target = index + delta
  if (index < 0 || target < 0 || target >= rows.length) return false
  const [moved] = rows.splice(index, 1)
  rows.splice(target, 0, moved)
  await db.transaction('rw', db.vehiclePhotos, async () => {
    await Promise.all(rows.map((row, i) => db.vehiclePhotos.update(row.id, { sort: i + 1 })))
  })
  return true
}

export async function clearVehicleFrames(vehicleId) {
  await db.transaction('rw', db.vehiclePhotos, db.vehicles, async () => {
    const ids = (await db.vehiclePhotos.where('[vehicleId+kind]').equals([vehicleId, FRAME]).toArray()).map((row) => row.id)
    if (ids.length) await db.vehiclePhotos.bulkDelete(ids)
    await db.vehicles.update(vehicleId, { frameCount: 0, mediaUpdatedAt: nowIso() })
  })
}

// ---------- lecture ----------
export function useVehicleMedia(vehicleId) {
  return useLiveQuery(async () => {
    if (!vehicleId) return { photos: [], frames: [] }
    const rows = await db.vehiclePhotos.where('vehicleId').equals(vehicleId).toArray()
    if (rows.some((row) => row.enc || isEncryptedValue(row.data))) touch()
    const opened = await Promise.all(rows.map((row) => openMedia(row.lotId, row)))
    return {
      photos: opened.filter((row) => row.kind === PHOTO).sort((a, b) => a.sort - b.sort),
      frames: opened.filter((row) => row.kind === FRAME).sort((a, b) => a.sort - b.sort),
    }
  }, [vehicleId], { photos: [], frames: [] })
}

export function useMediaBudget(lotId) {
  return useLiveQuery(async () => {
    if (!lotId) return { vehicles: 0, photos: 0, frames: 0, bytes: 0, quota: 0, usage: 0 }
    const rows = await db.vehiclePhotos.where('lotId').equals(lotId).toArray()
    const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : {}
    return {
      vehicles: new Set(rows.map((row) => row.vehicleId)).size,
      photos: rows.filter((row) => row.kind === PHOTO).length,
      frames: rows.filter((row) => row.kind === FRAME).length,
      bytes: rows.reduce((total, row) => total + (Number(row.bytes) || 0), 0),
      encrypted: rows.filter((row) => row.enc).length,
      quota: Number(estimate.quota) || 0,
      usage: Number(estimate.usage) || 0,
    }
  }, [lotId], { vehicles: 0, photos: 0, frames: 0, bytes: 0, quota: 0, usage: 0 })
}

// Chiffre les médias créés AVANT l'ouverture du coffre. Idempotent : les lignes
// déjà scellées sont ignorées, donc relancer l'opération ne double rien.
// Les vignettes de couverture (vehicles.photo) sont scellées en même temps,
// sinon la liste de stock continuerait d'afficher une image en clair.
export async function sealExistingMedia(lotId) {
  if (!isUnlocked(lotId)) throw new Error('Coffre verrouillé : déverrouillez-le avant de chiffrer les photos existantes.')
  const rows = await db.vehiclePhotos.where('lotId').equals(lotId).toArray()
  let sealed = 0, skipped = 0
  for (const row of rows) {
    if (row.enc && isEncryptedValue(row.data) && isEncryptedValue(row.thumb)) { skipped++; continue }
    const data = isEncryptedValue(row.data) ? row.data : await encryptText(lotId, row.data)
    const thumb = isEncryptedValue(row.thumb) ? row.thumb : await encryptText(lotId, row.thumb)
    await db.vehiclePhotos.update(row.id, { data, thumb, enc: true })
    sealed++
  }
  // Couvertures : on remplace la valeur en clair par son chiffré équivalent.
  const vehicles = await db.vehicles.where('lotId').equals(lotId).toArray()
  for (const vehicle of vehicles) {
    if (!vehicle.photo || isEncryptedValue(vehicle.photo)) continue
    const cover = await db.vehiclePhotos.where('[vehicleId+kind]').equals([vehicle.id, PHOTO]).sortBy('sort')
    const source = cover.find((c) => c.cover) || cover[0]
    await db.vehicles.update(vehicle.id, { photo: source ? source.thumb : null, mediaUpdatedAt: nowIso() })
  }
  return { sealed, skipped, total: rows.length }
}

export async function purgeVehicleMedia(vehicleId) {
  await db.transaction('rw', db.vehiclePhotos, db.vehicles, async () => {
    const ids = (await db.vehiclePhotos.where('vehicleId').equals(vehicleId).toArray()).map((row) => row.id)
    if (ids.length) await db.vehiclePhotos.bulkDelete(ids)
    await db.vehicles.update(vehicleId, { photo: null, photoCount: 0, frameCount: 0, mediaUpdatedAt: nowIso() })
  })
}
