/**
 * MON PARKING — Apprentissage local des confusions OCR.
 *
 * Ce module est PUR (aucun accès base, aucun React) : il transforme des
 * confirmations d'opérateur en coûts d'édition, et c'est `match.js` qui les
 * consomme. Il est donc testable directement sous Node.
 *
 * Principe : quand un opérateur retient une plaque suggérée alors que l'OCR
 * avait lu autre chose, on aligne les deux chaînes caractère par caractère.
 * Chaque substitution observée (ex. « 8 » lu à la place de « B ») est comptée.
 * Au-delà de MIN_COUNT occurrences, la paire devient active : le coût de cette
 * substitution baisse, et la correspondance exacte lecture → plaque mémorisée
 * reçoit une remise supplémentaire.
 *
 * Garde-fous : seuil minimum d'occurrences (un clic isolé n'apprend rien),
 * coût plancher MIN_COST, et remise plafonnée BOOST_MAX — une erreur de
 * manipulation ne peut donc pas détourner durablement le rapprochement.
 */
import { compact } from './plate.js'

export const MIN_COUNT = 2 // occurrences avant qu'une paire soit active
export const COST_START = 0.45 // coût d'une paire active à MIN_COUNT
export const COST_STEP = 0.07 // gain par occurrence supplémentaire
export const MIN_COST = 0.12 // plancher : jamais « gratuit »
export const BOOST_PER = 0.12 // remise (en caractères) par confirmation
export const BOOST_MAX = 0.5 // remise maximale, en caractères
export const MAX_EVENTS_KEPT = 2000

/**
 * Aligne la lecture OCR et la plaque retenue, et renvoie les substitutions.
 * Les insertions/suppressions pures sont ignorées : elles traduisent un
 * caractère manqué, pas une confusion de glyphe, et fausseraient les coûts.
 *
 * @param {string} raw texte lu par le moteur
 * @param {string} truth plaque finalement retenue
 * @returns {Array<{from:string,to:string}>}
 */
export function alignPairs(raw, truth) {
  const a = compact(raw)
  const b = compact(truth)
  if (!a || !b || a === b) return []
  // Au-delà de deux caractères d'écart, l'alignement n'est plus fiable.
  if (Math.abs(a.length - b.length) > 2) return []

  const la = a.length
  const lb = b.length
  const dp = Array.from({ length: la + 1 }, () => new Float64Array(lb + 1))
  for (let i = 0; i <= la; i += 1) dp[i][0] = i
  for (let j = 0; j <= lb; j += 1) dp[0][j] = j
  for (let i = 1; i <= la; i += 1) {
    for (let j = 1; j <= lb; j += 1) {
      const same = a[i - 1] === b[j - 1]
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (same ? 0 : 1))
    }
  }

  const pairs = []
  let i = la
  let j = lb
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { i -= 1; j -= 1; continue }
    const diag = dp[i - 1][j - 1]
    const up = dp[i - 1][j]
    const left = dp[i][j - 1]
    const best = Math.min(diag, up, left)
    if (best === diag) { pairs.push({ from: a[i - 1], to: b[j - 1] }); i -= 1; j -= 1 }
    else if (best === up) { i -= 1 }
    else { j -= 1 }
  }
  return pairs.reverse()
}

/** Coût effectif d'une paire selon son nombre d'occurrences (null si inactive). */
export function pairCost(count) {
  if (count < MIN_COUNT) return null
  return Math.round(Math.max(MIN_COST, COST_START - (count - MIN_COUNT) * COST_STEP) * 1000) / 1000
}

/** Remise appliquée à une correspondance lecture → plaque mémorisée. */
export function plateBoost(count) {
  if (count < MIN_COUNT) return 0
  return Math.round(Math.min(BOOST_MAX, BOOST_PER * count) * 1000) / 1000
}

/**
 * Agrège les événements en coûts exploitables par le moteur de rapprochement.
 * @param {Array} events enregistrements issus de la base
 */
export function aggregate(events = []) {
  const pairCounts = new Map()
  const plateCounts = new Map()

  for (const e of events) {
    for (const key of new Set(e.pairs || [])) {
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1)
    }
    const rc = e.rawCompact ?? compact(e.raw)
    const cc = e.chosenCompact ?? compact(e.chosen)
    if (rc && cc) {
      const key = `${rc}>${cc}`
      plateCounts.set(key, (plateCounts.get(key) || 0) + 1)
    }
  }

  const costs = {}
  const pairs = []
  for (const [key, count] of [...pairCounts.entries()].sort((x, y) => y[1] - x[1])) {
    const [from, to] = key.split('>')
    const cost = pairCost(count)
    if (cost !== null) costs[key] = cost
    pairs.push({ from, to, count, active: cost !== null, cost })
  }

  const pairBoost = {}
  const plateMemory = []
  for (const [key, count] of [...plateCounts.entries()].sort((x, y) => y[1] - x[1])) {
    const [raw, chosen] = key.split('>')
    if (raw === chosen) continue
    const boost = plateBoost(count)
    if (boost > 0) pairBoost[key] = boost
    plateMemory.push({ raw, chosen, count, boost })
  }

  return {
    costs,
    pairBoost,
    pairs,
    plateMemory,
    counts: {
      events: events.length,
      pairsTotal: pairs.length,
      pairsActive: Object.keys(costs).length,
      platesKnown: plateMemory.length,
      platesActive: plateMemory.filter((p) => p.boost > 0).length,
      confirmations: events.filter((e) => e.source === 'suggestion').length,
      corrections: events.filter((e) => e.source === 'correction').length,
    },
  }
}

/** Coût par défaut d'une substitution non apprise (aligné sur match.js). */

/** Sérialisation destinée à l'export / la sauvegarde. */
export function serializeLearning(events = [], meta = {}) {
  return JSON.stringify({
    app: 'MON PARKING',
    kind: 'ocr-learning',
    version: 1,
    exportedAt: new Date().toISOString(),
    ...meta,
    summary: aggregate(events).counts,
    events,
  }, null, 2)
}
