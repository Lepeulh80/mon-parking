// Helpers purs (aucun accès IndexedDB) : testables en Node, réutilisés par
// src/lib/photos.js et par le lecteur 360°. Aucun DOM ici.

export const PHOTO = 'photo'
export const FRAME = 'frame'
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
export const MAX_SOURCE_BYTES = 15 * 1024 * 1024
export const MAX_IMAGE_EDGE = 1600
export const THUMB_EDGE = 320
export const QUALITY = 0.82
export const MIN_FRAMES = 3
export const RECOMMENDED_FRAMES = 24

export function isAcceptedMime(type) {
  return ACCEPTED_TYPES.includes(String(type || '').toLowerCase())
}

export function isTooLarge(bytes) {
  return Number(bytes) > MAX_SOURCE_BYTES
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

// Angle (0–359) affiché pour la prise n° index d'une séquence de total images.
export function frameAngle(index, total) {
  if (!total || total < 1) return 0
  const a = Math.round((index * 360) / total)
  return ((a % 360) + 360) % 360
}

// Inverse : un angle saisi/déduit d'un glissement -> index de prise.
export function angleToIndex(angle, total) {
  if (!total || total < 1) return 0
  const raw = Math.round((((angle % 360) + 360) % 360) / 360 * total)
  return ((raw % total) + total) % total
}

export function stepIndex(current, delta, total) {
  if (!total || total < 1) return 0
  return (((current + delta) % total) + total) % total
}

// Glissement horizontal -> nouvel index. pxPerFrame : sensibilité du drag.
export function dragToIndex(startIndex, dx, total, pxPerFrame = 18) {
  if (!total || total < 1) return 0
  const step = Math.round(-Number(dx || 0) / Math.max(4, pxPerFrame))
  return stepIndex(startIndex, step, total)
}

// Tri « naturel » : cadre-2.jpg avant cadre-10.jpg (les tris lexicaux échouent).
export function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

export function orderFilesByName(files) {
  return [...files].sort((x, y) => naturalCompare(x.name, y.name))
}

export function nextSort(rows) {
  return rows.reduce((max, row) => Math.max(max, Number(row.sort) || 0), 0) + 1
}

// Message d'aide : une seule photo ne peut pas tourner.
export function spinHint(total) {
  if (total < 2) return 'Une seule image ne peut pas tourner. Ajoutez une séquence de prises autour du véhicule.'
  if (total < MIN_FRAMES) return `Séquence incomplète (${total} prises) : ${MIN_FRAMES} minimum pour un rendu crédible.`
  if (total < RECOMMENDED_FRAMES) return `${total} prises : la rotation fonctionne, ${RECOMMENDED_FRAMES} donnent un rendu fluide.`
  return `${total} prises : rotation fluide.`
}

// Budget de stockage : alerte avant de saturer le quota du navigateur.
export function storageLevel(usedBytes, quotaBytes) {
  if (!quotaBytes) return { ratio: 0, level: 'ok' }
  const ratio = usedBytes / quotaBytes
  return { ratio, level: ratio > 0.9 ? 'critique' : ratio > 0.75 ? 'élevé' : 'ok' }
}
