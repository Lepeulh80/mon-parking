/**
 * Passerelle médias véhicules ↔ Supabase Storage (bucket `vehicle-media`).
 *
 * Les policies SQL correspondantes vivent dans
 * supabase/migrations/20261022090500_storage_policies.sql et ont été prouvées
 * contre PostgreSQL 16.15 (section « storage » de la suite RLS). Ce module est
 * la pièce qui manquait côté client : jusqu'à la v19.4, aucune photo ne quittait
 * IndexedDB.
 *
 * Chemin conventionnel exigé par les policies :
 *   <lot_id>/<vehicle_id>/<kind>/<object_id>.<ext>
 * Les policies lisent (storage.foldername(name))[1] comme lot_id : un chemin
 * mal formé serait refusé côté serveur, mais on le refuse ici d'abord, avec un
 * message exploitable plutôt qu'un 403 opaque.
 */

export const BUCKET = 'vehicle-media'
export const MAX_BYTES = 8 * 1024 * 1024
export const ALLOWED_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
export const DEFAULT_EXPIRES = 3600

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_KIND = /^(photo|spin|cover|thumb)$/
const EXT_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
})

export class MediaError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'MediaError'
    this.code = code
  }
}

function requireId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new MediaError(`${label} invalide : seuls A-Z a-z 0-9 _ - sont acceptés (64 max).`, 'BAD_ID')
  }
  return value
}

/**
 * Construit le chemin de stockage. Toute tentative de traversée (`../`, `/`
 * initial, identifiant contenant un point) est rejetée avant le réseau.
 */
export function mediaPath({ lotId, vehicleId, kind = 'photo', objectId, mime }) {
  requireId(lotId, 'lotId')
  requireId(vehicleId, 'vehicleId')
  requireId(objectId, 'objectId')
  if (!SAFE_KIND.test(kind)) throw new MediaError(`Type de média inconnu : ${kind}`, 'BAD_KIND')
  const ext = EXT_BY_MIME[mime]
  if (!ext) throw new MediaError(`Type MIME refusé par le bucket : ${mime}`, 'BAD_MIME')
  return `${lotId}/${vehicleId}/${kind}/${objectId}.${ext}`
}

/** Contrôles locaux alignés sur la limite du bucket (8 Mio, 4 types). */
export function validateMedia({ blob, mime, encrypted }) {
  if (encrypted) {
    // Un média scellé est un flux AES-GCM, pas une image : le déposer dans un
    // bucket image casserait à la fois l'affichage et la promesse de chiffrement.
    throw new MediaError(
      'Média scellé par le coffre : déverrouillez le coffre pour publier la version chiffrée côté serveur.',
      'ENCRYPTED'
    )
  }
  if (!blob || typeof blob.size !== 'number') throw new MediaError('Fichier illisible.', 'NO_BLOB')
  if (blob.size <= 0) throw new MediaError('Fichier vide.', 'EMPTY')
  if (blob.size > MAX_BYTES) {
    throw new MediaError(`Fichier trop volumineux (${Math.round(blob.size / 1024)} Ko, 8 Mio max).`, 'TOO_LARGE')
  }
  if (!ALLOWED_MIME.includes(mime)) throw new MediaError(`Type MIME refusé : ${mime}`, 'BAD_MIME')
  return true
}

function bucket(sb) {
  if (!sb?.storage?.from) throw new MediaError('Client Supabase indisponible.', 'NO_CLIENT')
  const from = sb.storage.from(BUCKET)
  if (!from || typeof from.upload !== 'function') {
    throw new MediaError('Bucket vehicle-media inaccessible depuis ce client.', 'NO_BUCKET')
  }
  return from
}

/** Téléverse une photo ; `upsert` couvre la correction d'une photo existante. */
export async function uploadMedia(sb, { lotId, vehicleId, kind, objectId, blob, mime, encrypted }) {
  validateMedia({ blob, mime, encrypted })
  const path = mediaPath({ lotId, vehicleId, kind, objectId, mime })
  const { data, error } = await bucket(sb).upload(path, blob, { contentType: mime, upsert: true })
  if (error) throw new MediaError(`Téléversement refusé (${path}) : ${error.message}`, 'UPLOAD_FAILED')
  return { path, data }
}

/** URL signée courte : le bucket est privé, aucune URL publique n'existe. */
export async function signedMediaUrl(sb, path, expiresIn = DEFAULT_EXPIRES) {
  const seconds = Math.min(Math.max(Number(expiresIn) || DEFAULT_EXPIRES, 60), 86400)
  const { data, error } = await bucket(sb).createSignedUrl(path, seconds)
  if (error) throw new MediaError(`URL signée refusée pour ${path} : ${error.message}`, 'SIGN_FAILED')
  return data?.signedUrl || ''
}

export async function removeMedia(sb, path) {
  const { error } = await bucket(sb)?.remove ? await bucket(sb).remove([path]) : { error: { message: 'remove indisponible' } }
  if (error) throw new MediaError(`Suppression refusée pour ${path} : ${error.message}`, 'REMOVE_FAILED')
  return true
}

/** Liste les objets d'un véhicule (préfixe = chemin du dossier). */
export async function listVehicleMedia(sb, { lotId, vehicleId }) {
  requireId(lotId, 'lotId')
  requireId(vehicleId, 'vehicleId')
  const { data, error } = await bucket(sb).list(`${lotId}/${vehicleId}`, { limit: 200 })
  if (error) throw new MediaError(`Liste refusée : ${error.message}`, 'LIST_FAILED')
  return (data || []).map((entry) => ({
    name: entry.name,
    path: `${lotId}/${vehicleId}/${entry.name}`.replace(/\/+/g, '/'),
    size: entry.metadata?.size ?? null,
    mime: entry.metadata?.mimetype ?? null,
  }))
}

/** Nombre de médias publiés pour un parking (contrôle de complétude). */
export async function countLotMedia(sb, lotId) {
  requireId(lotId, 'lotId')
  const { data, error } = await bucket(sb).list(lotId, { limit: 1000 })
  if (error) throw new MediaError(`Liste refusée : ${error.message}`, 'LIST_FAILED')
  return (data || []).length
}
