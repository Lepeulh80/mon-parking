import { describe, it, expect } from 'vitest'
import { ACCEPTED_TYPES, MAX_SOURCE_BYTES, MIN_FRAMES, RECOMMENDED_FRAMES, isAcceptedMime, isTooLarge, formatBytes, frameAngle, angleToIndex, stepIndex, dragToIndex, naturalCompare } from '../photoMath.js'

describe('rotation 360°', () => {
  it('répartit les prises sur 360°', () => {
    expect(frameAngle(0, 24)).toBe(0)
    expect(frameAngle(1, 24)).toBe(15)
    expect(frameAngle(12, 24)).toBe(180)
    expect(frameAngle(24, 24)).toBe(0)
  })

  it('fait l’aller-retour angle / index', () => {
    expect(angleToIndex(15, 24)).toBe(1)
    expect(angleToIndex(180, 24)).toBe(12)
    expect(angleToIndex(359, 24)).toBe(0)
  })

  it('boucle dans les deux sens', () => {
    expect(stepIndex(0, -1, 24)).toBe(23)
    expect(stepIndex(23, 1, 24)).toBe(0)
    expect(stepIndex(5, 0, 24)).toBe(5)
  })

  it('convertit un glissement en index, dans le bon sens', () => {
    expect(dragToIndex(0, -36, 24, 18)).toBe(2)
    expect(dragToIndex(0, 36, 24, 18)).toBe(22)
  })

  it('tolère un total nul sans lever d’erreur', () => {
    expect(frameAngle(3, 0)).toBe(0)
    expect(stepIndex(3, 1, 0)).toBe(0)
    expect(dragToIndex(3, 20, 0)).toBe(0)
  })

  it('recommande 24 prises et en exige au moins 3', () => {
    expect(RECOMMENDED_FRAMES).toBe(24)
    expect(MIN_FRAMES).toBe(3)
  })
})

describe('fichiers média', () => {
  it('accepte les formats annoncés et refuse les autres', () => {
    for (const type of ACCEPTED_TYPES) expect(isAcceptedMime(type)).toBe(true)
    expect(isAcceptedMime('image/gif')).toBe(false)
    expect(isAcceptedMime('application/pdf')).toBe(false)
  })

  it('refuse un fichier trop lourd', () => {
    expect(isTooLarge(MAX_SOURCE_BYTES)).toBe(false)
    expect(isTooLarge(MAX_SOURCE_BYTES + 1)).toBe(true)
  })

  it('formate une taille lisible', () => {
    expect(formatBytes(0)).toMatch(/0/)
    expect(formatBytes(1024 * 1024)).toMatch(/Mo|MB/)
  })

  it('trie naturellement les prises (cadre-2 avant cadre-10)', () => {
    expect(naturalCompare('cadre-2.jpg', 'cadre-10.jpg')).toBeLessThan(0)
    expect(naturalCompare('cadre-10.jpg', 'cadre-2.jpg')).toBeGreaterThan(0)
    expect(naturalCompare('a.jpg', 'a.jpg')).toBe(0)
  })
})
