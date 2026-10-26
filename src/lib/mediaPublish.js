/**
 * Publication des photos locales (IndexedDB) vers Supabase Storage.
 *
 * `photos.js` conserve chaque image en data URL (chiffrée ou non). Storage, lui,
 * attend des octets. Ce module fait la seule conversion autorisée et refuse
 * explicitement ce qui ne peut pas être publié sans casser une garantie :
 *   - un média scellé par le coffre ne doit PAS partir en clair ni en flux GCM
 *     dans un bucket image (l'affichage et le chiffrement seraient tous deux faux) ;
 *   - un type MIME hors bucket est refusé avant le réseau.
 */

import { uploadMedia, MediaError, ALLOWED_MIME } from './storageMedia.js'

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i

/** Décode une data URL en octets. Toute autre forme est refusée. */
export function dataUrlToBytes(value) {
  if (typeof value !== 'string') throw new MediaError('Média illisible : data URL attendue.', 'NO_DATA')
  const match = DATA_URL.exec(value.trim())
  if (!match) throw new MediaError('Média illisible : data URL base64 attendue.', 'NO_DATA')
  const mime = match[1].toLowerCase()
  if (!ALLOWED_MIME.includes(mime)) throw new MediaError(`Type MIME refusé par le bucket : ${mime}`, 'BAD_MIME')
  const binary = atob(match[2].replace(/\s+/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  if (!bytes.length) throw new MediaError('Média vide.', 'EMPTY')
  return { bytes, mime }
}

function toBlob({ bytes, mime }) {
  if (typeof Blob === 'function') return new Blob([bytes], { type: mime })
  // Repli minimal pour les environnements sans Blob (le contrat uploadMedia ne
  // demande que `size` et un corps sérialisable).
  return { size: bytes.length, type: mime, bytes }
}

/**
 * Publie les photos d'un véhicule. Ne lève pas sur un média invalide : renvoie
 * un rapport, pour qu'une seule image corrompue n'empêche pas les 23 autres.
 *
 * @returns {{published: number, skipped: number, failed: number, objects: string[], errors: {id: string, reason: string}[]}}
 */
export async function publishVehicleMedia(sb, { lotId, vehicleId, photos = [], onProgress } = {}) {
  const report = { published: 0, skipped: 0, failed: 0, objects: [], errors: [] }
  const candidates = photos.filter((photo) => photo && photo.kind !== 'frame-raw')
  for (let index = 0; index < candidates.length; index++) {
    const photo = candidates[index]
    try {
      if (photo.enc) {
        report.skipped++
        report.errors.push({ id: String(photo.id), reason: 'Média scellé par le coffre : non publié.' })
        continue
      }
      const decoded = dataUrlToBytes(photo.data)
      const { path } = await uploadMedia(sb, {
        lotId,
        vehicleId,
        kind: photo.kind === 'spin' || photo.kind === 'frame' ? 'spin' : 'photo',
        objectId: String(photo.id),
        blob: toBlob(decoded),
        mime: decoded.mime,
        encrypted: false,
      })
      report.published++
      report.objects.push(path)
      onProgress?.({ index: index + 1, total: candidates.length, path })
    } catch (error) {
      report.failed++
      report.errors.push({ id: String(photo?.id), reason: error.message })
    }
  }
  return report
}

/** Résumé lisible pour l'écran (aucun chiffre inventé si le rapport est vide). */
export function summarizePublish(report) {
  if (!report) return 'Aucune publication effectuée.'
  const parts = [`${report.published} publiée(s)`]
  if (report.skipped) parts.push(`${report.skipped} ignorée(s) (chiffrées)`)
  if (report.failed) parts.push(`${report.failed} en échec`)
  return parts.join(', ') + '.'
}
