/**
 * MON PARKING — Moteur de lecture de plaques (100 % local, hors ligne).
 *
 * Tesseract.js est servi depuis /ocr/ (worker + cœur WASM + modèle « eng »),
 * donc aucune requête CDN : le scanner fonctionne sans réseau une fois les
 * fichiers mis en cache par le service worker.
 *
 * La reconnaissance balaye plusieurs variantes de prétraitement (binarisée /
 * niveaux de gris) et plusieurs modes de segmentation, puis retient la lecture
 * la plus fiable — une plaque mal éclairée passe rarement toutes les variantes.
 */
import { createWorker } from 'tesseract.js'
import { extractCandidates } from './plate'

const assetUrl = (p) => new URL(p, document.baseURI).href

let workerPromise = null
let progressHook = null

const STATUS_FR = {
  'loading tesseract core': 'Chargement du moteur…',
  'initializing tesseract': 'Initialisation…',
  'loading language traineddata': 'Chargement du modèle de lecture…',
  'initializing api': 'Préparation de l’analyse…',
  'recognizing text': 'Lecture de la plaque…',
}

function emit(status, progress) {
  if (typeof progressHook === 'function') {
    progressHook({ status, label: STATUS_FR[status] || status, progress: Math.round((progress || 0) * 100) })
  }
}

/** Instancie (une seule fois) le worker et le garde chaud entre deux scans. */
export function getOcrWorker(onProgress) {
  if (onProgress) progressHook = onProgress
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('eng', 1, {
        workerPath: assetUrl('ocr/worker.min.js'),
        corePath: assetUrl('ocr/'),
        langPath: assetUrl('ocr/tessdata'),
        logger: (m) => emit(m.status, m.progress),
        errorHandler: (e) => console.warn('[ocr]', e),
      })
      // Pas de tessedit_char_whitelist : la liste blanche en majuscules fait
      // disparaître le « l » minuscule que Tesseract lit souvent à la place du
      // « I » de « CI 4471 AB ». La normalisation est faite côté plate.js.
      await worker.setParameters({
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      })
      return worker
    })().catch((e) => {
      workerPromise = null
      throw e
    })
  }
  return workerPromise
}

/** Pré-chauffe le moteur à l'ouverture de la modale. */
export async function warmUpOcr() {
  try {
    await getOcrWorker()
    return true
  } catch (e) {
    console.warn('[ocr] warmup failed', e)
    return false
  }
}

/* ------------------------------------------------------------------ */
/* Prétraitement                                                       */
/* ------------------------------------------------------------------ */

/**
 * Prépare une image pour Tesseract.
 * - marge blanche : le moteur a besoin d'un « quiet zone » autour du texte ;
 * - agrandissement jusqu'à ~1100 px de large ;
 * - mode « binary » : Otsu + inversion logique (plaque claire / texte sombre) ;
 * - mode « gray »   : niveaux de gris avec étirement de contraste.
 */
export function prepareImage(source, { mode = 'binary', targetWidth = 1100, pad = 26 } = {}) {
  const sw = source.width || source.videoWidth
  const sh = source.height || source.videoHeight
  if (!sw || !sh) throw new Error('Image vide')

  const scale = Math.min(4, Math.max(1, targetWidth / sw))
  const w = Math.round(sw * scale)
  const h = Math.round(sh * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w + pad * 2
  canvas.height = h + pad * 2
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, pad, pad, w, h)

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = img.data
  const n = canvas.width * canvas.height
  const gray = new Uint8ClampedArray(n)
  const hist = new Uint32Array(256)

  for (let i = 0; i < n; i += 1) {
    const o = i * 4
    const g = (d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114) | 0
    gray[i] = g
    hist[g] += 1
  }

  // Étirement de contraste (percentiles 2 % / 98 %).
  let lo = 0
  let hi = 255
  let acc = 0
  for (let v = 0; v < 256; v += 1) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break } }
  acc = 0
  for (let v = 255; v >= 0; v -= 1) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break } }
  const span = Math.max(1, hi - lo)

  // Un cadrage « plein cadre » sur une plaque est déjà très contrasté : étirer
  // les niveaux y amplifie le bruit et fait perdre des caractères. On n'étire
  // donc que si la dynamique est réellement faible.
  if (span >= 40) {
    for (let i = 0; i < n; i += 1) {
      const v = ((gray[i] - lo) * 255) / span
      gray[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }

  if (mode === 'gray') {
    for (let i = 0; i < n; i += 1) {
      const o = i * 4
      const v = gray[i]
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
    }
    ctx.putImageData(img, 0, 0)
    return canvas
  }

  // Seuil d'Otsu sur l'image étirée.
  const hist2 = new Uint32Array(256)
  let sum = 0
  for (let i = 0; i < n; i += 1) { hist2[gray[i] | 0] += 1; sum += gray[i] }
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t += 1) {
    wB += hist2[t]
    if (!wB) continue
    const wF = n - wB
    if (!wF) break
    sumB += t * hist2[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; threshold = t }
  }

  let white = 0
  for (let i = 0; i < n; i += 1) if (gray[i] > threshold) white += 1
  const invert = white / n < 0.5 // plaque claire = majorité de pixels clairs

  for (let i = 0; i < n; i += 1) {
    const isWhite = gray[i] > threshold
    const v = isWhite !== invert ? 255 : 0
    const o = i * 4
    d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

/** Compatibilité : renvoie le canvas binarisé. */
export function preprocessForOcr(source, opts) {
  return { canvas: prepareImage(source, { mode: 'binary', ...opts }) }
}

/* ------------------------------------------------------------------ */
/* Reconnaissance                                                      */
/* ------------------------------------------------------------------ */

const VARIANTS = [
  { mode: 'gray', psm: '7' },
  { mode: 'gray', psm: '6' },
  { mode: 'binary', psm: '7' },
]

/**
 * Lit une image et renvoie les candidats triés + la meilleure lecture.
 * @returns {{text:string, confidence:number, candidates:Array, best:object|null, preview:string|null, variant:string}}
 */
export async function recognizePlate(source, opts = {}) {
  const { onProgress, variants = VARIANTS } = opts
  const worker = await getOcrWorker(onProgress)

  let winner = null
  for (let i = 0; i < variants.length; i += 1) {
    const v = variants[i]
    let canvas
    try {
      canvas = prepareImage(source, v)
    } catch {
      continue
    }
    await worker.setParameters({ tessedit_pageseg_mode: v.psm })
    const { data } = await worker.recognize(canvas)
    const confidence = Math.round(data.confidence || 0)
    const candidates = extractCandidates(data.text, { confidence })
    const top = candidates[0] || null
    const score =
      confidence + (top ? Math.min(24, top.score / 5) : -60) + (top?.ok ? 10 : 0)
    if (!winner || score > winner.score) {
      winner = {
        score,
        text: (data.text || '').trim(),
        confidence,
        candidates,
        best: top,
        preview: canvas.toDataURL('image/jpeg', 0.7),
        variant: `${v.mode}/psm${v.psm}`,
      }
    }
    if (confidence >= 85 && top?.ok) break // lecture franche : inutile d'insister
  }

  if (!winner) {
    return { text: '', confidence: 0, candidates: [], best: null, preview: null, variant: null, reliable: false }
  }
  const reliable = winner.confidence >= 40 && !!winner.best && winner.best.ok
  return { ...winner, reliable }
}

/** Libère le worker. */
export async function terminateOcr() {
  if (!workerPromise) return
  try {
    const w = await workerPromise
    await w.terminate()
  } catch { /* ignore */ }
  workerPromise = null
}
