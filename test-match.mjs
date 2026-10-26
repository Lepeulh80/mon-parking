/** Vérifie le moteur de rapprochement de plaques (hors navigateur). */
import { plateScore, rankPlates, decide, canonical, levenshtein } from './src/lib/match.js'

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`OK   ${name}${detail ? ' · ' + detail : ''}`) }
  else { fail += 1; console.log(`KO   ${name}${detail ? ' · ' + detail : ''}`) }
}

console.log('--- normalisation ---')
check('canonical fusionne 1/I et 8/B', canonical('CI 7841 KB') === canonical('CI 784I K8'), canonical('CI 7841 KB'))
check('levenshtein AB/AB = 0', levenshtein('AB', 'AB') === 0)
check('levenshtein ABC/ABD = 1', levenshtein('ABC', 'ABD') === 1)
check('levenshtein bornée renvoie max+1', levenshtein('ABCDEF', 'ZZZZZZ', 2) === 3)

console.log('\n--- scores ---')
const exact = plateScore('CI 4471 AB', 'CI4471AB')
check('identique', exact.score === 1 && exact.exact, `score=${exact.score}`)
const c8 = plateScore('CI 8842 KB', 'CI 8842 K8')
check('confusion 8/B → quasi certain', c8.score >= 0.96 && c8.distance === 0.25, `score=${c8.score} dist=${c8.distance}`)
const cL = plateScore('CI 4471 AB', 'Cl 4471 AB')
check('confusion l/I', cL.score >= 0.95, `score=${cL.score}`)
const d1 = plateScore('CI 4471 AB', 'CI 4471 AC')
check('1 caractère d’écart → candidat fort (≥ STRONG)', d1.score >= 0.87, `score=${d1.score} dist=${d1.distance}`)
const d2 = plateScore('CI 4471 AB', 'CI 4472 AC')
check('2 caractères d’écart → candidat plausible (≥ WEAK, < STRONG)', d2.score >= 0.7 && d2.score < 0.87, `score=${d2.score} dist=${d2.distance}`)
const d3 = plateScore('CI 4471 AB', 'CI 4517 AC')
check('3 caractères d’écart → rejeté', d3.score < 0.78, `score=${d3.score} dist=${d3.distance}`)
const far = plateScore('CI 4471 AB', 'ZZ 9999 ZZ')
check('plaque étrangère rejetée', far.score === 0, `score=${far.score}`)

console.log('\n--- classement ---')
const entries = [
  { plate: 'CI 4517 AC', kind: 'ticket', id: 't1' },
  { plate: 'CI 8842 K8', kind: 'ticket', id: 't2' },
  { plate: 'CI 8842 KB', kind: 'reservation', id: 'r1' },
  { plate: 'AB 1234 CI', kind: 'vehicule', id: 'v1' },
]
const rankNoExact = rankPlates('CI 8842 KB', entries.filter((e) => e.id !== 'r1'), { minScore: 0.6 })
const ranked = rankPlates('CI 8842 KB', entries, { minScore: 0.6 })
check('la plaque confondue arrive en tête (sans concurrent exact)', rankNoExact[0]?.entry.id === 't2', `${rankNoExact[0]?.entry.plate} @ ${rankNoExact[0]?.score}`)
check('une plaque exacte primes toujours sur une confusion', ranked[0]?.entry.id === 'r1', `${ranked[0]?.entry.plate} @ ${ranked[0]?.score}`)
check('les plaques lointaines sont écartées', !ranked.some((m) => m.entry.id === 'v1'), ranked.map((m) => m.entry.plate).join(' | '))

console.log('\n--- décisions ---')
const T = (id, plate) => ({ plate, kind: 'ticket', id, ticket: { id } })
const decideWith = (plate, list) => decide(plate, rankPlates(plate, list, { minScore: 0.6 }))

check('plaque identique unique → ouverture directe',
  decideWith('CI 4471 AB', [T('a', 'CI 4471 AB')]).status === 'found')
check('confusion OCR unique → ouverture directe',
  decideWith('CI 8842 KB', [T('b', 'CI 8842 K8')]).status === 'found')
check('1 caractère d’écart → ouverture directe',
  decideWith('CI 4471 AB', [T('c', 'CI 4471 AC')]).status === 'found')
check('2 caractères d’écart → liste de confirmation',
  decideWith('CI 4471 AB', [T('d', 'CI 4472 AC')]).status === 'ambiguous')
check('deux candidats forts non exacts → liste de choix',
  decideWith('CI 8842 KB', [T('e', 'CI 8842 K8'), T('f', 'CI 8848 KB')]).status === 'ambiguous')
check('un exact + un confondu → l’exact gagne',
  decideWith('CI 8842 KB', [T('g', 'CI 8842 KB'), T('h', 'CI 8842 K8')]).status === 'found')
check('réservation seule → statut reservation',
  decideWith('CI 4471 AB', [{ plate: 'CI 4471 AB', kind: 'reservation', id: 'r', reservation: {} }]).status === 'reservation')
check('ticket déjà encaissé → statut history',
  decideWith('CI 4471 AB', [{ plate: 'CI 4471 AB', kind: 'historique', id: 'h' }]).status === 'history')
check('aucune correspondance → statut none',
  decideWith('CI 4471 AB', [{ plate: 'AB 1234 CI', kind: 'vehicule', id: 'v' }]).status === 'none')

console.log(`\nRÉSULTAT : ${pass} OK / ${fail} KO`)
process.exit(fail ? 1 : 0)
