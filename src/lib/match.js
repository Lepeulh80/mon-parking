/**
 * MON PARKING — Rapprochement d'une plaque lue avec les plaques déjà enregistrées.
 *
 * L'OCR se trompe rarement sur tout : il se trompe sur UN caractère, et souvent
 * sur un caractère visuellement voisin (0/O, 1/I, 8/B, 5/S, 2/Z…).
 *
 * Le score combine trois sources, dans cet ordre de confiance :
 *   1. égalité exacte après compactage → 1 ;
 *   2. distance d'édition pondérée : une substitution coûte 1 par défaut,
 *      0,25 si les deux caractères appartiennent à la même classe visuelle,
 *      et le coût appris si l'opérateur a déjà confirmé cette confusion ;
 *   3. remise issue de la mémoire locale (lecture → plaque déjà retenue).
 *
 * `learning` est fourni par `learning.js` : { costs, pairBoost }.
 */
import { compact } from './plate.js'

/** Classes de confusion visuelle : la clé et sa valeur sont interchangeables. */
const CLASS = {
  0: 'O', O: 'O', Q: 'O', D: 'O',
  1: 'I', I: 'I', L: 'I',
  2: 'Z', Z: 'Z',
  5: 'S', S: 'S',
  6: 'G', G: 'G',
  8: 'B', B: 'B',
}

export const DEFAULT_SUB_COST = 1
export const CLASS_SUB_COST = 0.25

const canonChar = (ch) => CLASS[ch] || ch

/** Forme canonique : même classe pour les caractères ambigus. */
export function canonical(value) {
  const c = compact(value)
  let out = ''
  for (const ch of c) out += canonChar(ch)
  return out
}

/**
 * Distance de Levenshtein bornée (coût 1 partout) — conservée pour les
 * diagnostics et les tests.
 */
export function levenshtein(a, b, max = 4) {
  if (a === b) return 0
  const la = a.length
  const lb = b.length
  if (!la) return lb
  if (!lb) return la
  if (Math.abs(la - lb) > max) return max + 1

  let prev = new Array(lb + 1)
  let cur = new Array(lb + 1)
  for (let j = 0; j <= lb; j += 1) prev[j] = j

  for (let i = 1; i <= la; i += 1) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[lb] > max ? max + 1 : prev[lb]
}

/** Levenshtein à coûts flottants (substitution paramétrable). */
function weightedDistance(a, b, subCost, max = 5.5) {
  const la = a.length
  const lb = b.length
  if (!la) return lb
  if (!lb) return la
  if (Math.abs(la - lb) > max) return max + 1

  let prev = new Float64Array(lb + 1)
  let cur = new Float64Array(lb + 1)
  for (let j = 0; j <= lb; j += 1) prev[j] = j

  for (let i = 1; i <= la; i += 1) {
    cur[0] = i
    let rowMin = cur[0]
    for (let j = 1; j <= lb; j += 1) {
      const c = subCost(a[i - 1], b[j - 1])
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > max) return max + 1
    const t = prev
    prev = cur
    cur = t
  }
  return prev[lb]
}

/** Coût de substitution : appris > classe visuelle > défaut. */
function makeCostFn(learning) {
  const costs = learning?.costs || null
  return (x, y) => {
    if (x === y) return 0
    if (costs) {
      // Strictement directionnel : on a appris que l'OCR écrit « 4 » là où la
      // plaque porte « A ». Appliquer le coût à l'envers avantagerait la plaque
      // concurrente qui contient le caractère mal lu — exactement l'inverse du
      // but recherché.
      const direct = costs[`${x}>${y}`]
      if (Number.isFinite(direct)) return Math.min(direct, canonChar(x) === canonChar(y) ? CLASS_SUB_COST : DEFAULT_SUB_COST)
    }
    return canonChar(x) === canonChar(y) ? CLASS_SUB_COST : DEFAULT_SUB_COST
  }
}

/**
 * Score de ressemblance entre une plaque lue et une plaque enregistrée.
 * @param {string} input      lecture OCR / saisie
 * @param {string} stored     plaque enregistrée
 * @param {object} [learning] { costs, pairBoost }
 * @returns {{score:number, exact:boolean, distance:number, boosted:boolean}}
 */
export function plateScore(input, stored, learning = null) {
  const a = compact(input)
  const b = compact(stored)
  if (!a || !b) return { score: 0, exact: false, distance: 99, boosted: false }
  if (a === b) return { score: 1, exact: true, distance: 0, boosted: false }

  const subCost = makeCostFn(learning)
  const raw = weightedDistance(a, b, subCost)
  if (raw > 5) return { score: 0, exact: false, distance: 99, boosted: false }

  // Remise apprise : la paire exacte lecture → plaque a déjà été confirmée.
  const boost = learning?.pairBoost?.[`${a}>${b}`] || 0
  const effective = Math.max(0, raw - boost)
  const len = Math.max(a.length, b.length, 1)

  const score = Math.min(0.9995, Math.max(0, 1 - effective / len))
  return {
    score: Math.round(score * 10000) / 10000,
    exact: false,
    distance: Math.round(raw * 100) / 100,
    boosted: boost > 0,
  }
}

/** Priorité d'affichage par nature d'enregistrement. */
const KIND_RANK = { ticket: 0, reservation: 1, vehicule: 2, historique: 3 }

/**
 * Classe les plaques enregistrées par ressemblance avec la lecture.
 * @param {string} input
 * @param {Array} entries [{ plate, kind, ... }]
 * @param {object} opts { minScore, limit, learning }
 */
export function rankPlates(input, entries = [], { minScore = 0.68, limit = 6, learning = null } = {}) {
  if (!compact(input)) return []
  const out = []
  for (const entry of entries) {
    const s = plateScore(input, entry.plate, learning)
    if (s.score < minScore) continue
    out.push({ entry, score: s.score, exact: s.exact, distance: s.distance, boosted: s.boosted })
  }
  out.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score
    const kx = KIND_RANK[x.entry.kind] ?? 9
    const ky = KIND_RANK[y.entry.kind] ?? 9
    if (kx !== ky) return kx - ky
    return String(x.entry.plate).localeCompare(String(y.entry.plate))
  })
  return out.slice(0, limit)
}

/** Seuils de décision, partagés par l'interface. */
export const STRONG = 0.87 // un seul candidat à ce niveau → ouverture directe
export const WEAK = 0.7 // candidat plausible → proposer la liste
export const AMBIGUOUS_GAP = 0.02 // deux candidats à moins de 2 % → liste de choix

/**
 * Décide de l'action à partir des correspondances.
 * @returns {{status:'found'|'ambiguous'|'reservation'|'history'|'none', ...}}
 */
export function decide(input, matches) {
  const tickets = matches.filter((m) => m.entry.kind === 'ticket')
  const exact = tickets.filter((m) => m.exact)
  // Une plaque identique caractère pour caractère ne souffre aucune ambiguïté.
  if (exact.length === 1) return { status: 'found', ticket: exact[0].entry, matches }
  if (exact.length > 1) return { status: 'ambiguous', ticket: null, matches: exact }

  const strong = tickets.filter((m) => m.score >= STRONG)
  if (strong.length === 1) {
    const close = tickets.filter((m) => m.score >= strong[0].score - AMBIGUOUS_GAP)
    if (close.length === 1) return { status: 'found', ticket: strong[0].entry, matches }
    return { status: 'ambiguous', ticket: null, matches: close }
  }
  if (strong.length > 1) {
    // Une mémoire de plaque confirmée à plusieurs reprises tranche l'égalité :
    // si la tête est issue de l'apprentissage et se détache nettement, on ouvre.
    const [top, second] = strong
    if (top.boosted && second && top.score - second.score >= AMBIGUOUS_GAP) {
      return { status: 'found', ticket: top.entry, matches: strong }
    }
    return { status: 'ambiguous', ticket: null, matches: strong }
  }

  // Un seul candidat plausible mais imparfait : l'opérateur confirme la plaque.
  const plausible = tickets.filter((m) => m.score >= WEAK)
  if (plausible.length) return { status: 'ambiguous', ticket: null, matches: plausible }

  const resa = matches.find((m) => m.entry.kind === 'reservation' && m.score >= STRONG)
  if (resa) return { status: 'reservation', ticket: null, reservation: resa.entry, matches }

  const hist = matches.find((m) => m.entry.kind === 'historique')
  if (hist) return { status: 'history', ticket: null, history: hist.entry, matches }

  return { status: 'none', ticket: null, matches }
}
