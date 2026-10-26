/**
 * Apprentissage local des confusions OCR : preuve que les coûts appris
 * modifient réellement le classement des suggestions.
 */
import {
  alignPairs, aggregate, pairCost, plateBoost, MIN_COUNT, MIN_COST, BOOST_MAX, COST_START,
} from './src/lib/learning.js'
import { rankPlates, plateScore, decide, STRONG, WEAK } from './src/lib/match.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`OK   ${name}${detail ? ' · ' + detail : ''}`) }
  else { fail += 1; console.log(`KO   ${name}${detail ? ' · ' + detail : ''}`) }
}

/** Construit un événement comme le ferait learningStore.recordFeedback. */
const ev = (raw, chosen, source = 'suggestion') => ({
  id: `e${Math.random().toString(36).slice(2, 7)}`,
  raw, rawCompact: raw.toUpperCase().replace(/[^A-Z0-9]/g, ''),
  chosen, chosenCompact: chosen.toUpperCase().replace(/[^A-Z0-9]/g, ''),
  source,
  pairs: alignPairs(raw, chosen).map((p) => `${p.from}>${p.to}`),
})

console.log('=== 1. Alignement des chaînes ===')
const p1 = alignPairs('CI 4A71 AB', 'CI AA71 AB')
check('substitution 4→A détectée', p1.length === 1 && p1[0].from === '4' && p1[0].to === 'A', JSON.stringify(p1))
const p2 = alignPairs('. Cl 4471 AB', 'CI 4471 AB')
check('l→I détecté sur la lecture brute', p2.some((p) => p.to === 'I'), JSON.stringify(p2))
const p3 = alignPairs('CI 4471 AB', 'CI 4471 AB')
check('lecture correcte → aucune paire', p3.length === 0)
const p4 = alignPairs('CI 4471 AB', 'CI 4471 ABCDEFGH')
check('écart de longueur absurde → aucune paire', p4.length === 0)

console.log('\n=== 2. Seuils et plafonds ===')
check(`1 occurrence → paire inactive`, pairCost(1) === null, `coût=${pairCost(1)}`)
check(`${MIN_COUNT} occurrences → coût ${COST_START}`, pairCost(MIN_COUNT) === COST_START, `coût=${pairCost(MIN_COUNT)}`)
check('5 occurrences → coût plus bas', pairCost(5) < pairCost(MIN_COUNT), `${pairCost(5)} < ${pairCost(MIN_COUNT)}`)
check('coût plancher respecté à 50 occurrences', pairCost(50) === MIN_COST, `coût=${pairCost(50)}`)
check('remise nulle sous le seuil', plateBoost(1) === 0)
check('remise plafonnée', plateBoost(50) === BOOST_MAX, `remise=${plateBoost(50)}`)

console.log('\n=== 3. Le classement change réellement ===')
const stored = [
  { plate: 'CI AA71 AB', kind: 'ticket', id: 't_AA71' },
  { plate: 'CI 4471 AB', kind: 'ticket', id: 't_4471' },
]
const read = 'CI 4A71 AB' // le moteur lit « 4 » là où la plaque porte « A »

// --- avant apprentissage ---
const before = rankPlates(read, stored, { minScore: 0.5, limit: 5 })
const scoreBefore = Object.fromEntries(before.map((m) => [m.entry.id, m.score]))
console.log('   avant :', before.map((m) => `${m.entry.plate} ${(m.score * 100).toFixed(1)}%`).join(' | '))
const tie = Math.abs((scoreBefore.t_AA71 ?? 0) - (scoreBefore.t_4471 ?? 0)) < 0.01
check('sans apprentissage, les deux plaques sont à égalité', tie,
  `AA71=${(scoreBefore.t_AA71 ?? 0).toFixed(3)} / 4471=${(scoreBefore.t_4471 ?? 0).toFixed(3)}`)
const decisionBefore = decide(read, before)
check('sans apprentissage, décision ambiguë (liste de choix)', decisionBefore.status === 'ambiguous', decisionBefore.status)

// --- une seule confirmation : rien ne doit changer ---
const oneEvent = [ev('CI 4A71 AB', 'CI AA71 AB')]
const l1 = aggregate(oneEvent)
const afterOne = rankPlates(read, stored, { minScore: 0.5, limit: 5, learning: l1 })
const oneScore = Object.fromEntries(afterOne.map((m) => [m.entry.id, m.score]))
check('1 confirmation ne modifie pas les coûts (garde-fou)',
  Math.abs((oneScore.t_AA71 ?? 0) - (scoreBefore.t_AA71 ?? 0)) < 0.001,
  `AA71 ${(oneScore.t_AA71 ?? 0).toFixed(3)} vs ${(scoreBefore.t_AA71 ?? 0).toFixed(3)}`)
check('la paire reste inactive dans l’agrégat', l1.counts.pairsActive === 0, `actives=${l1.counts.pairsActive}`)

// --- deux confirmations : la paire s'active ---
const twoEvents = [ev('CI 4A71 AB', 'CI AA71 AB'), ev('CI 4A71 AB', 'CI AA71 AB')]
const l2 = aggregate(twoEvents)
check('2 confirmations → 1 paire active', l2.counts.pairsActive === 1, JSON.stringify(l2.costs))
const after = rankPlates(read, stored, { minScore: 0.5, limit: 5, learning: l2 })
const scoreAfter = Object.fromEntries(after.map((m) => [m.entry.id, m.score]))
console.log('   après :', after.map((m) => `${m.entry.plate} ${(m.score * 100).toFixed(1)}%`).join(' | '))

check('la plaque confirmée passe devant', after[0]?.entry.id === 't_AA71',
  `tête = ${after[0]?.entry.plate} (${(after[0]?.score * 100).toFixed(1)}%)`)
check('son score progresse', (scoreAfter.t_AA71 ?? 0) > (scoreBefore.t_AA71 ?? 0) + 0.05,
  `${(scoreBefore.t_AA71 ?? 0).toFixed(3)} → ${(scoreAfter.t_AA71 ?? 0).toFixed(3)}`)
check('l’autre plaque reste inchangée', Math.abs((scoreAfter.t_4471 ?? 0) - (scoreBefore.t_4471 ?? 0)) < 0.001,
  `${(scoreAfter.t_4471 ?? 0).toFixed(3)}`)
const decisionAfter = decide(read, after)
check('la décision devient une ouverture directe', decisionAfter.status === 'found',
  `${decisionAfter.status}${decisionAfter.ticket ? ' → ' + decisionAfter.ticket.plate : ''}`)

console.log('\n=== 4. Convergence et mémoire des plaques ===')
const many = Array.from({ length: 6 }, () => ev('CI 4A71 AB', 'CI AA71 AB'))
const l6 = aggregate(many)
const after6 = rankPlates(read, stored, { minScore: 0.5, limit: 5, learning: l6 })
console.log('   6 confirmations :', after6.map((m) => `${m.entry.plate} ${(m.score * 100).toFixed(1)}%`).join(' | '))
check('le coût converge vers le plancher', l6.costs['4>A'] === MIN_COST || l6.costs['4>A'] < pairCost(MIN_COUNT),
  `coût=${l6.costs['4>A']}`)
check('la mémoire de plaque est active', (l6.pairBoost['CI4A71AB>CIAA71AB'] ?? 0) > 0,
  `remise=${l6.pairBoost['CI4A71AB>CIAA71AB']}`)
check('le score monte encore avec les confirmations', (after6[0]?.score ?? 0) > (after[0]?.score ?? 0) - 0.001,
  `${(after[0]?.score * 100).toFixed(1)}% → ${(after6[0]?.score * 100).toFixed(1)}%`)
check('plafond atteint : au moins 98 %', (after6[0]?.score ?? 0) >= 0.98, `${((after6[0]?.score ?? 0) * 100).toFixed(1)}%`)

console.log('\n=== 5. Garde-fous ===')
// Une confusion apprise ne doit pas rapprocher des plaques sans rapport.
const unrelated = rankPlates('ZZ 9999 ZZ', stored, { minScore: 0.5, learning: l6 })
check('aucune contamination des plaques sans rapport', unrelated.length === 0, `${unrelated.length} résultat(s)`)
// Une seule erreur de clic (paire vue 1 fois) ne peut pas faire basculer un classement.
const wrongOnce = aggregate([ev('CI 4A71 AB', 'CI 4471 AB')])
const afterWrong = rankPlates(read, stored, { minScore: 0.5, learning: wrongOnce })
check('un clic erroné isolé ne renverse pas le classement',
  Math.abs((afterWrong[0]?.score ?? 0) - (afterWrong[1]?.score ?? 0)) < 0.01,
  afterWrong.map((m) => `${m.entry.plate} ${(m.score * 100).toFixed(1)}%`).join(' | '))
// Remise plafonnée : jamais de score parfait sans égalité réelle.
const boosted = plateScore('CI 4A71 AB', 'CI AA71 AB', l6)
check('jamais 100 % sans égalité exacte', boosted.score <= 0.9995 && !boosted.exact, `score=${boosted.score}`)

console.log('\n=== 6. Indicateurs affichés dans l’administration ===')
const full = aggregate([...twoEvents, ev('CI 1234 AB', 'CI 1234 A8', 'correction')])
check('compte les confirmations par origine',
  full.counts.confirmations === 2 && full.counts.corrections === 1,
  `suggestions=${full.counts.confirmations} corrections=${full.counts.corrections}`)
check('compte les paires observées', full.counts.pairsTotal >= 2, `${full.counts.pairsTotal} paire(s)`)
check('compte les plaques mémorisées', full.counts.platesKnown === 2, `${full.counts.platesKnown}`)

console.log(`\nSeuils en vigueur : STRONG=${STRONG} · WEAK=${WEAK} · MIN_COUNT=${MIN_COUNT} · MIN_COST=${MIN_COST} · BOOST_MAX=${BOOST_MAX}`)
console.log(`RÉSULTAT : ${pass} OK / ${fail} KO`)
process.exit(fail ? 1 : 0)
