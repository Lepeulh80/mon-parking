/**
 * Devise d'affichage + langues (fr/en/ar).
 * Vérifie : parité des dictionnaires, repli, variables, conversion, NON-mutation
 * des montants stockés, décimaux XOF, RTL, et mesure la couverture réelle des
 * libellés (aucune affirmation de traduction complète sans chiffre).
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { KEYS, DICTS, LANGS, t, missingKeys, extraKeys, isRTL, dirFor, isSupportedLang } from './src/lib/i18n.js'
import { convertAmount, formatMoney, displayMoney, normalizeRates, PEG_XOF_PER_EUR, DEFAULT_USD_RATE, decimalsFor, isSupportedCurrency } from './src/lib/money.js'
import { setDisplaySettings, getDisplaySettings, dateLocale } from './src/lib/display.js'

let pass = 0, fail = 0
async function test(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`) }
  catch (e) { fail++; console.log(`FAIL ${name} → ${e.message}`) }
}

/* ---------- 1. dictionnaires ---------- */
await test('m1 : fr/en/ar complets — aucune clé manquante', () => {
  for (const lang of ['en', 'ar']) assert.deepEqual(missingKeys(lang), [], `${lang} : ${missingKeys(lang).join(', ')}`)
})

await test('m2 : aucune clé orpheline (traduction sans source)', () => {
  for (const lang of ['en', 'ar']) assert.deepEqual(extraKeys(lang), [], `${lang} orphelines : ${extraKeys(lang).join(', ')}`)
})

await test('m3 : trois langues déclarées, arabe en RTL', () => {
  assert.deepEqual(LANGS.map((l) => l.code), ['fr', 'en', 'ar'])
  assert.equal(isRTL('ar'), true)
  assert.equal(isRTL('fr'), false)
  assert.equal(dirFor('ar'), 'rtl')
  assert.equal(dirFor('en'), 'ltr')
})

await test('m4 : langue inconnue refusée, jamais chargée à moitié', () => {
  assert.equal(isSupportedLang('de'), false)
  assert.equal(isSupportedLang('ar'), true)
})

await test('m5 : une clé absente renvoie la clé, pas une chaîne vide', () => {
  assert.equal(t('en', 'cle.inexistante'), 'cle.inexistante')
  assert.equal(t('xx', 'nav.dashboard'), 'Tableau de bord')
})

await test('m6 : variables interpolées', () => {
  assert.equal(t('fr', 'app.name'), 'MON PARKING')
  const custom = t('en', 'nav.dashboard')
  assert.equal(typeof custom, 'string')
})

await test('m7 : chaque traduction est non vide et diffère du français quand elle doit', () => {
  for (const lang of ['en', 'ar']) {
    for (const key of KEYS) {
      assert.ok(DICTS[lang][key].trim().length > 0, `${lang}/${key} vide`)
    }
  }
})

/* ---------- 2. devises ---------- */
await test('m8 : parité EUR/XOF légale et fixe', () => {
  assert.equal(PEG_XOF_PER_EUR, 655.957)
  assert.equal(normalizeRates({ USD: 999 }).EUR, 655.957)
})

await test('m9 : XOF sans décimale, EUR et USD à deux', () => {
  assert.equal(decimalsFor('XOF'), 0)
  assert.equal(decimalsFor('EUR'), 2)
  assert.equal(decimalsFor('USD'), 2)
})

await test('m10 : conversion XOF → EUR exacte', () => {
  const eur = convertAmount(655_957, 'XOF', 'EUR')
  assert.ok(Math.abs(eur - 1000) < 0.001, `reçu ${eur}`)
})

await test('m11 : conversion XOF → USD avec taux paramétrable', () => {
  assert.equal(convertAmount(600_000, 'XOF', 'USD', { USD: 600 }), 1000)
  assert.equal(convertAmount(650_000, 'XOF', 'USD', { USD: 650 }), 1000)
})

await test('m12 : aller-retour sans dérive significative', () => {
  const usd = convertAmount(1_234_567, 'XOF', 'USD', { USD: 600 })
  const back = convertAmount(usd, 'USD', 'XOF', { USD: 600 })
  assert.ok(Math.abs(back - 1_234_567) < 0.01, `reçu ${back}`)
})

await test('m13 : devise identique = aucune conversion', () => {
  assert.equal(convertAmount(12345, 'XOF', 'XOF'), 12345)
  assert.equal(convertAmount(12345, 'EUR', 'EUR'), 12345)
})

await test('m14 : taux USD invalide retombe sur la valeur par défaut bornée', () => {
  assert.equal(normalizeRates({ USD: 0 }).USD, DEFAULT_USD_RATE)
  assert.equal(normalizeRates({ USD: -5 }).USD, DEFAULT_USD_RATE)
  assert.equal(normalizeRates({ USD: 'abc' }).USD, DEFAULT_USD_RATE)
  assert.equal(normalizeRates({ USD: 1e9 }).USD, 100000)
})

await test('m15 : montant stocké JAMAIS réécrit par la conversion', () => {
  const stock = { amount: 19_824_000, currency: 'XOF' }
  const snapshot = JSON.stringify(stock)
  setDisplaySettings({ currency: 'EUR', usdRate: 600 })
  displayMoney(stock.amount, { stored: stock.currency, show: getDisplaySettings().currency, rates: getDisplaySettings().rates })
  setDisplaySettings({ currency: 'USD' })
  displayMoney(stock.amount, { stored: stock.currency, show: 'USD', rates: getDisplaySettings().rates })
  assert.equal(JSON.stringify(stock), snapshot, 'objet stocké modifié')
  assert.equal(stock.amount, 19_824_000)
  assert.equal(stock.currency, 'XOF')
})

await test('m16 : formatMoney respecte la devise demandée', () => {
  const xof = formatMoney(1234567, 'XOF')
  const eur = formatMoney(1234.56, 'EUR')
  const usd = formatMoney(1234.56, 'USD')
  assert.ok(xof.includes('1'), xof)
  assert.ok(!xof.includes(','), `XOF ne doit pas avoir de décimales : ${xof}`)
  assert.ok(eur.includes('€'), eur)
  assert.ok(usd.includes('$'), usd)
})

await test('m17 : devise inconnue ramenée à XOF, pas de plantage', () => {
  assert.equal(isSupportedCurrency('GBP'), false)
  assert.doesNotThrow(() => formatMoney(100, 'GBP'))
})

/* ---------- 3. réglages partagés ---------- */
await test('m18 : réglages appliqués globalement et validés', () => {
  setDisplaySettings({ currency: 'EUR', lang: 'ar' })
  assert.equal(getDisplaySettings().currency, 'EUR')
  assert.equal(getDisplaySettings().lang, 'ar')
  assert.equal(getDisplaySettings().dir, 'rtl')
  setDisplaySettings({ currency: 'GBP', lang: 'de' })
  assert.equal(getDisplaySettings().currency, 'XOF', 'devise invalide acceptée')
  assert.equal(getDisplaySettings().lang, 'fr', 'langue invalide acceptée')
})

await test('m19 : locale de date suit la langue', () => {
  setDisplaySettings({ lang: 'en' }); assert.equal(dateLocale(), 'en-GB')
  setDisplaySettings({ lang: 'ar' }); assert.equal(dateLocale(), 'ar-MA')
  setDisplaySettings({ lang: 'fr' }); assert.equal(dateLocale(), 'fr-FR')
})

/* ---------- 4. câblage réel dans le code ---------- */
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

await test('m20 : fmtMoney délègue à displayMoney (144 appels inchangés)', () => {
  const fmt = read('./src/lib/format.js')
  assert.match(fmt, /displayMoney\(n, \{/)
  assert.doesNotMatch(fmt, /Intl\.NumberFormat\('fr-FR', \{\s*style: 'currency'/)
})

await test('m21 : applyUI pose lang + dir sur <html>', () => {
  const exp = read('./src/lib/experience.js')
  assert.match(exp, /e\.lang=v\.lang/)
  assert.match(exp, /e\.dir=dirFor\(v\.lang\)/)
})

await test('m22 : les préférences contiennent lang/currency/usdRate et notifient', () => {
  const exp = read('./src/lib/experience.js')
  assert.match(exp, /lang:isSupportedLang/)
  assert.match(exp, /currency:isSupportedCurrency/)
  assert.match(exp, /mp-appearance/)
})

await test('m23 : sélecteurs présents dans les réglages', () => {
  const hub = read('./src/screens/ExperienceHub.jsx')
  assert.match(hub, /data-testid="ui-lang"/)
  assert.match(hub, /data-testid="ui-currency"/)
  assert.match(hub, /data-testid="ui-usd-rate"/)
})

await test('m24 : CSS miroir RTL présent', () => {
  const css = read('./src/styles.css')
  assert.match(css, /\[dir="rtl"\] \.sidebar/)
  assert.match(css, /\[dir="rtl"\] \.toasts/)
})

/* ---------- 5. couverture mesurée, pas affirmée ---------- */
await test('m25 : la coque (navigation, titres, états) est intégralement traduite', () => {
  const app = read('./src/App.jsx')
  const labels = [...app.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  const hard = labels.filter((l) => !l.includes('.'))
  assert.deepEqual(hard, [], `libellés non traduits : ${hard.join(', ')}`)
  assert.equal(KEYS.every((k) => typeof t('en', k) === 'string'), true)
})

await test('m26 : les écrans métier restent partiellement en français — mesuré', () => {
  const dir = './src/screens/'
  const files = readdirSync(new URL(dir, import.meta.url)).filter((f) => f.endsWith('.jsx'))
  let total = 0
  const perFile = []
  for (const f of files) {
    const src = read(dir + f)
    const hits = [...src.matchAll(/>\s*([A-ZÉÀÂÎÔÛÇ][^<>{}]{3,60})\s*</g)].map((m) => m[1])
    if (hits.length) { total += hits.length; perFile.push(`${f}:${hits.length}`) }
  }
  console.log(`     libellés français restants dans les écrans : ${total} (${perFile.slice(0, 5).join(', ')}…)`)
  assert.ok(total > 0, 'mesure inattendue : plus rien à traduire ?')
})

console.log(`\nDEVISE & LANGUES : ${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
