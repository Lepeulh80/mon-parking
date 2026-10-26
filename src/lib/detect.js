/**
 * MON PARKING — Détection automatique du rectangle de plaque.
 *
 * Aucun modèle de machine learning : on reste sur de la vision classique,
 * exécutable sur un téléphone d'entrée de gamme à chaque image.
 *
 *   1. réduction de l'image à ~320 px de large (coût constant) ;
 *   2. niveaux de gris + seuil d'Otsu : la plaque est la zone claire ;
 *   3. étiquetage des composantes connexes (4-voisinage, pile explicite) ;
 *   4. filtrage géométrique : rapport largeur/hauteur de plaque, aire,
 *      taux de remplissage, position ;
 *   5. renvoi de la meilleure boîte normalisée (0 → 1).
 */

/** Étiquette les composantes connexes d'un masque binaire. */
function components(mask, w, h) {
  const labels = new Int32Array(w * h)
  const boxes = []
  const stack = new Int32Array(w * h)
  let next = 0

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue
    next += 1
    let sp = 0
    stack[sp++] = start
    labels[start] = next
    let minX = w
    let minY = h
    let maxX = 0
    let maxY = 0
    let count = 0

    while (sp > 0) {
      const p = stack[--sp]
      const x = p % w
      const y = (p - x) / w
      count += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = next; stack[sp++] = p - 1 }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = next; stack[sp++] = p + 1 }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = next; stack[sp++] = p - w }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = next; stack[sp++] = p + w }
    }

    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, count })
  }
  return boxes
}

/** Seuil d'Otsu sur un histogramme 256 classes. */
function otsu(gray, hist) {
  const n = gray.length
  let sum = 0
  for (let v = 0; v < 256; v += 1) sum += v * hist[v]
  let sumB = 0
  let wB = 0
  let best = -1
  let threshold = 128
  for (let t = 0; t < 256; t += 1) {
    wB += hist[t]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; threshold = t }
  }
  return threshold
}

/**
 * Cherche le rectangle de plaque le plus plausible dans une image.
 * @returns {{x:number,y:number,w:number,h:number,score:number}|null} boîte normalisée
 */
export function detectPlateBox(source, opts = {}) {
  const maxWidth = opts.maxWidth || 320
  const sw = source?.width || source?.videoWidth || 0
  const sh = source?.height || source?.videoHeight || 0
  if (!sw || !sh) return null

  const scale = Math.min(1, maxWidth / sw)
  const w = Math.max(80, Math.round(sw * scale))
  const h = Math.max(56, Math.round(sh * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(source, 0, 0, w, h)

  const { data } = ctx.getImageData(0, 0, w, h)
  const n = w * h
  const gray = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i += 1) {
    const o = i * 4
    const g = (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114) | 0
    gray[i] = g
    hist[g] += 1
  }

  const threshold = otsu(gray, hist)
  const mask = new Uint8Array(n)
  let bright = 0
  for (let i = 0; i < n; i += 1) {
    if (gray[i] > threshold) { mask[i] = 1; bright += 1 }
  }
  // Scène trop sombre ou saturée : la détection n'apporterait rien.
  const ratio = bright / n
  if (ratio < 0.01 || ratio > 0.85) return null

  const boxes = components(mask, w, h)
  let best = null
  for (const b of boxes) {
    const aspect = b.w / b.h
    const fill = b.count / (b.width2 || b.w * b.h)
    const areaRatio = (b.w * b.h) / n
    if (b.w < w * 0.18 || b.h < h * 0.045) continue
    if (aspect < 1.6 || aspect > 7.5) continue
    if (areaRatio < 0.004 || areaRatio > 0.85) continue
    const density = b.count / (b.w * b.h)
    if (density < 0.35) continue
    // Favorise : grande surface, ratio typique de plaque (≈ 3,5), centrage.
    const centerBias = 1 - Math.abs((b.x + b.w / 2) / w - 0.5) * 0.6
    const score = areaRatio * 100 * (1 - Math.abs(aspect - 3.4) / 6) + density * 6 + centerBias * 4
    if (!best || score > best.score) {
      best = {
        x: b.x / w, y: b.y / h, w: b.w / w, h: b.h / h, score, aspect, density, fill,
      }
    }
  }
  if (!best || best.score <= 0) return null

  // Marge de sécurité : l'OCR a besoin d'un peu d'air autour du texte.
  const padX = best.w * 0.03
  const padY = best.h * 0.16
  return {
    x: Math.max(0, best.x - padX),
    y: Math.max(0, best.y - padY),
    w: Math.min(1, best.w + padX * 2),
    h: Math.min(1, best.h + padY * 2),
    score: Math.round(best.score * 10) / 10,
    aspect: Math.round(best.aspect * 100) / 100,
  }
}

/** Découpe une boîte normalisée dans un canvas prêt pour l'OCR. */
export function cropBox(source, box, { minWidth = 640 } = {}) {
  const sw = source.width || source.videoWidth
  const sh = source.height || source.videoHeight
  if (!sw || !sh) return null
  const sx = Math.max(0, Math.round(box.x * sw))
  const sy = Math.max(0, Math.round(box.y * sh))
  const cw = Math.max(8, Math.min(sw - sx, Math.round(box.w * sw)))
  const ch = Math.max(8, Math.min(sh - sy, Math.round(box.h * sh)))
  const up = cw < minWidth ? Math.min(4, minWidth / cw) : 1
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(cw * up)
  canvas.height = Math.round(ch * up)
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height)
  return canvas
}
