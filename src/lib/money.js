/**
 * Devises et conversion d'affichage.
 *
 * Décision explicite : le changement de devise ne modifie AUCUN montant stocké.
 * `convertAmount` sert uniquement au rendu ; la base garde la devise de référence
 * du parking (XOF par défaut) et le code appelant ne doit jamais réécrire un
 * montant avec le résultat d'une conversion.
 */

export const PEG_XOF_PER_EUR = 655.957

export const CURRENCIES = Object.freeze({
  XOF: { code: 'XOF', decimals: 0, symbol: 'F CFA', label: 'F CFA', locale: 'fr-FR' },
  EUR: { code: 'EUR', decimals: 2, symbol: '€', label: 'Euro', locale: 'fr-FR' },
  USD: { code: 'USD', decimals: 2, symbol: '$', label: 'Dollar US', locale: 'en-US' },
})

export const CURRENCY_CODES = Object.freeze(Object.keys(CURRENCIES))
export const DEFAULT_CURRENCY = 'XOF'
export const DEFAULT_USD_RATE = 600 // XOF pour 1 USD, modifiable par l'administrateur

export const isSupportedCurrency = (code) => CURRENCY_CODES.includes(code)

/** Nombre de décimales réellement affichées (XOF : aucune). */
export const decimalsFor = (code) => CURRENCIES[code]?.decimals ?? 2

export function normalizeRates(rates = {}) {
  const usd = Number(rates?.USD)
  return {
    EUR: PEG_XOF_PER_EUR,
    USD: Number.isFinite(usd) && usd > 0 ? Math.min(Math.max(usd, 1), 100000) : DEFAULT_USD_RATE,
  }
}

/**
 * Convertit un montant de la devise de référence vers la devise d'affichage.
 * @param {number} amount montant dans `from`
 * @param {string} from devise de référence (celle du parking)
 * @param {string} to devise d'affichage
 * @param {{USD?: number}} rates taux XOF→USD
 */
export function convertAmount(amount, from, to, rates) {
  const value = Number(amount) || 0
  if (!from || !to || from === to) return value
  const safe = normalizeRates(rates)
  const toXof = (v, code) => {
    if (code === 'XOF') return v
    if (code === 'EUR') return v * PEG_XOF_PER_EUR
    if (code === 'USD') return v * safe.USD
    return v
  }
  const fromXof = (v, code) => {
    if (code === 'XOF') return v
    if (code === 'EUR') return v / PEG_XOF_PER_EUR
    if (code === 'USD') return v / safe.USD
    return v
  }
  return fromXof(toXof(value, from), to)
}

/** Formate un montant dans une devise donnée, sans conversion implicite. */
export function formatMoney(amount, currency = DEFAULT_CURRENCY, { locale } = {}) {
  const code = isSupportedCurrency(currency) ? currency : DEFAULT_CURRENCY
  const meta = CURRENCIES[code]
  const value = Number(amount) || 0
  const digits = meta.decimals
  try {
    return new Intl.NumberFormat(locale || meta.locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  } catch {
    return `${value.toFixed(digits)} ${meta.symbol}`
  }
}

/**
 * Formatage complet : conversion d'affichage puis rendu.
 * `stored` reste intact — le retour est une chaîne, jamais un nombre réinjecté.
 */
export function displayMoney(amount, { stored = DEFAULT_CURRENCY, show = DEFAULT_CURRENCY, rates, locale } = {}) {
  const converted = convertAmount(amount, stored, show, rates)
  return formatMoney(converted, show, { locale })
}
