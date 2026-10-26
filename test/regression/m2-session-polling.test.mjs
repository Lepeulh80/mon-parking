// m2 — fréquence de revalidation de session.
// Défaut v12 : setInterval(check, 2000) = 30 requêtes SQLite/minute par onglet,
// sur un poste de caisse laissé ouvert toute la journée.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8')
let passed = 0, failed = 0
const check = (name, fn) => { try { fn(); passed++; console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e.message) } }

check('Le sondage périodique est au moins à 10 s', () => {
  const matches = [...source.matchAll(/setInterval\(check,\s*(\d+)\)/g)]
  assert(matches.length > 0, 'aucun setInterval(check, …) trouvé')
  for (const match of matches) {
    const ms = Number(match[1])
    assert(ms >= 10000, `intervalle trop court : ${ms} ms`)
  }
})

check('Le sondage de 2 s a disparu', () => {
  assert(!/setInterval\(check,\s*2000\)/.test(source), 'setInterval(check, 2000) toujours présent')
})

check('La réactivité est couverte par les évènements, pas par le sondage', () => {
  for (const event of ['focus', 'online', 'offline', 'mp-auth-check']) {
    assert(source.includes(`addEventListener('${event}'`), `écouteur manquant : ${event}`)
  }
  assert(source.includes("addEventListener('visibilitychange'"), 'retour d’onglet non revalidé')
  assert(/visibilityState==='visible'/.test(source), 'la visibilité doit déclencher une revalidation')
  assert(source.includes('clearInterval(timer)'), 'intervalle non nettoyé au démontage')
})

check('Le nettoyage retire aussi l’écouteur de visibilité', () => {
  assert(source.includes("removeEventListener('visibilitychange'"), 'fuite d’écouteur au démontage')
})

console.log(`M2 SESSION POLLING: ${passed} passed / ${failed} failed`)
process.exitCode = failed ? 1 : 0
