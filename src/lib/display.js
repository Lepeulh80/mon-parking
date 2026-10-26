/**
 * Réglages d'affichage partagés (devise + langue).
 *
 * Un seul état module, alimenté par les préférences utilisateur sauvegardées
 * (`experience.js`). Les fonctions de formatage le lisent sans recevoir de
 * paramètre : les 144 appels `fmtMoney(...)` existants n'ont pas eu à changer,
 * et aucun d'eux ne peut réécrire un montant stocké.
 */

import { DEFAULT_CURRENCY, DEFAULT_USD_RATE, normalizeRates, isSupportedCurrency } from './money.js'
import { DEFAULT_LANG, isSupportedLang, dirFor } from './i18n.js'

const DATE_LOCALES = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-MA' }

const state = {
  currency: DEFAULT_CURRENCY,
  lang: DEFAULT_LANG,
  rates: normalizeRates({ USD: DEFAULT_USD_RATE }),
}

export function setDisplaySettings(patch = {}) {
  if (patch.currency !== undefined) {
    state.currency = isSupportedCurrency(patch.currency) ? patch.currency : DEFAULT_CURRENCY
  }
  if (patch.lang !== undefined) {
    state.lang = isSupportedLang(patch.lang) ? patch.lang : DEFAULT_LANG
  }
  if (patch.rates !== undefined) state.rates = normalizeRates(patch.rates)
  else if (patch.usdRate !== undefined) state.rates = normalizeRates({ USD: patch.usdRate })
  return { ...state, dir: dirFor(state.lang) }
}

export const getDisplaySettings = () => ({ ...state, dir: dirFor(state.lang) })
export const dateLocale = () => DATE_LOCALES[state.lang] || 'fr-FR'
export const currentLang = () => state.lang
export const currentCurrency = () => state.currency
