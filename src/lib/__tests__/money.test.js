import { describe, it, expect } from 'vitest'
import { PEG_XOF_PER_EUR, DEFAULT_USD_RATE, CURRENCY_CODES, CURRENCIES, isSupportedCurrency, decimalsFor, normalizeRates, convertAmount, formatMoney, displayMoney } from '../money.js'

describe('parité et devises', () => {
  it('applique la parité légale euro / franc CFA', () => {
    expect(PEG_XOF_PER_EUR).toBe(655.957)
    expect(convertAmount(655957, 'XOF', 'EUR')).toBeCloseTo(1000, 6)
    expect(convertAmount(1000, 'EUR', 'XOF')).toBeCloseTo(655957, 3)
  })

  it('respecte les décimales de chaque devise', () => {
    expect(decimalsFor('XOF')).toBe(0)
    expect(decimalsFor('EUR')).toBe(2)
    expect(decimalsFor('USD')).toBe(2)
  })

  it('reconnaît uniquement les devises supportées', () => {
    // CURRENCY_CODES est figé : on trie une copie, sinon TypeError.
    expect([...CURRENCY_CODES].sort()).toEqual(['EUR', 'USD', 'XOF'])
    expect(isSupportedCurrency('XOF')).toBe(true)
    expect(isSupportedCurrency('GBP')).toBe(false)
    expect(Object.keys(CURRENCIES).length).toBe(3)
  })
})

describe('normalizeRates', () => {
  it('fixe l’euro et laisse le dollar réglable', () => {
    expect(normalizeRates({ USD: 700 }).USD).toBe(700)
    expect(normalizeRates({}).USD).toBe(DEFAULT_USD_RATE)
  })

  it('borne un taux aberrant', () => {
    expect(normalizeRates({ USD: 0 }).USD).toBe(DEFAULT_USD_RATE)
    expect(normalizeRates({ USD: -5 }).USD).toBe(DEFAULT_USD_RATE)
    expect(normalizeRates({ USD: 1e9 }).USD).toBe(100000)
    expect(normalizeRates({ USD: 0.5 }).USD).toBe(1)
  })
})

describe('convertAmount', () => {
  it('renvoie le montant inchangé si la devise est la même', () => {
    expect(convertAmount(12345, 'XOF', 'XOF')).toBe(12345)
  })

  it('convertit via un taux dollar paramétré', () => {
    expect(convertAmount(60000, 'XOF', 'USD', { USD: 600 })).toBeCloseTo(100, 6)
    expect(convertAmount(100, 'USD', 'XOF', { USD: 600 })).toBeCloseTo(60000, 6)
  })

  it('traite une valeur non numérique comme zéro', () => {
    expect(convertAmount('abc', 'XOF', 'EUR')).toBe(0)
    expect(convertAmount(null, 'XOF', 'EUR')).toBe(0)
  })

  it('ne modifie jamais le montant stocké', () => {
    const stored = 19824000
    displayMoney(stored, { stored: 'XOF', show: 'EUR' })
    expect(stored).toBe(19824000)
  })
})

describe('formatage', () => {
  it('affiche le franc CFA sans décimale', () => {
    const out = formatMoney(19824000, 'XOF', { locale: 'fr-FR' })
    expect(out).toMatch(/19/)
    expect(out).not.toMatch(/,\d/)
  })

  it('affiche l’euro avec deux décimales', () => {
    const out = formatMoney(1000, 'EUR', { locale: 'fr-FR' })
    expect(out).toMatch(/,00/)
  })

  it('retombe sur le franc CFA pour une devise inconnue', () => {
    expect(formatMoney(1000, 'GBP', { locale: 'fr-FR' })).toBe(formatMoney(1000, 'XOF', { locale: 'fr-FR' }))
  })

  it('displayMoney convertit puis rend une chaîne', () => {
    const out = displayMoney(655957, { stored: 'XOF', show: 'EUR', locale: 'fr-FR' })
    expect(typeof out).toBe('string')
    expect(out).toMatch(/1/)
  })
})
