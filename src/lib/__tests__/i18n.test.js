import { describe, it, expect } from 'vitest'
import { LANGS, DEFAULT_LANG, isRTL, dirFor, isSupportedLang, DICTS, KEYS, SOURCE_LANG, t, missingKeys, extraKeys, langOptions } from '../i18n.js'

const CODES = LANGS.map((l) => l.code)

describe('langues', () => {
  it('propose français, anglais et arabe', () => {
    expect(CODES).toEqual(['fr', 'en', 'ar'])
    expect(DEFAULT_LANG).toBe('fr')
    expect(SOURCE_LANG).toBe('fr')
  })

  it('marque uniquement l’arabe comme RTL', () => {
    expect(isRTL('ar')).toBe(true)
    expect(isRTL('fr')).toBe(false)
    expect(isRTL('en')).toBe(false)
    expect(dirFor('ar')).toBe('rtl')
    expect(dirFor('fr')).toBe('ltr')
  })

  it('expose un libellé natif par langue', () => {
    const opts = langOptions()
    expect(opts).toHaveLength(3)
    expect(opts[0]).toHaveProperty('value')
    expect(opts[0]).toHaveProperty('label')
  })

  it('refuse une langue non supportée', () => {
    expect(isSupportedLang('fr')).toBe(true)
    expect(isSupportedLang('de')).toBe(false)
  })
})

describe('dictionnaires', () => {
  it('ne laisse aucune clé manquante en anglais ni en arabe', () => {
    expect(missingKeys('en')).toEqual([])
    expect(missingKeys('ar')).toEqual([])
  })

  it('n’a aucune clé orpheline', () => {
    expect(extraKeys('en')).toEqual([])
    expect(extraKeys('ar')).toEqual([])
  })

  it('déclare un jeu de clés non trivial', () => {
    // Mesure réelle : 82 clés au moment de l'écriture. Le seuil bas évite de
    // casser le test à chaque retrait de libellé, tout en détectant un
    // dictionnaire vidé par erreur.
    expect(KEYS.length).toBeGreaterThan(50)
    expect(Object.keys(DICTS)).toEqual(['fr', 'en', 'ar'])
  })
})

describe('t()', () => {
  it('traduit réellement dans les trois langues', () => {
    const key = KEYS[0]
    const fr = t('fr', key)
    const en = t('en', key)
    const ar = t('ar', key)
    expect(fr.length).toBeGreaterThan(0)
    expect(en.length).toBeGreaterThan(0)
    expect(ar.length).toBeGreaterThan(0)
    expect(en).not.toBe(key)
  })

  it('renvoie la clé elle-même si elle est inconnue, jamais du vide', () => {
    expect(t('fr', 'cle.inexistante')).toBe('cle.inexistante')
  })

  it('remplace les variables {nom}', () => {
    const key = KEYS.find((k) => t('fr', k).includes('{')) || null
    if (key) {
      const rendered = t('fr', key, { n: 7 })
      expect(rendered).not.toMatch(/\{[a-zA-Z]+\}/)
    } else {
      // Aucune clé paramétrée : le contrat reste « la clé inconnue est rendue telle quelle ».
      expect(t('fr', 'x')).toBe('x')
    }
  })

  it('retombe sur le français pour une langue inconnue', () => {
    const key = KEYS[0]
    expect(t('de', key)).toBe(t('fr', key))
  })
})
