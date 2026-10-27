import { describe, it, expect } from 'vitest'
import { canonical, plateScore, rankPlates, decide, STRONG, WEAK, AMBIGUOUS_GAP, DEFAULT_SUB_COST, CLASS_SUB_COST } from '../match.js'

describe('canonical', () => {
  it('regroupe les caractères ambigus dans une forme unique', () => {
    // 0/O/Q/D -> O ; 1/I/L -> I ; 2/Z -> Z ; 5/S -> S ; 6/G -> G ; 8/B -> B
    expect(canonical('0OQD')).toBe('OOOO')
    expect(canonical('1IL')).toBe('III')
    expect(canonical('25S')).toBe('ZSS')
    expect(canonical('68B')).toBe('GBB')
  })

  it('ignore espaces et tirets d’une plaque', () => {
    expect(canonical('CI 8842 KB')).toBe(canonical('CI-8842-KB'))
  })
})

describe('plateScore', () => {
  it('donne 1 pour une plaque identique', () => {
    const r = plateScore('CI 8842 KB', 'CI 8842 KB')
    expect(r.exact).toBe(true)
    expect(r.score).toBe(1)
    expect(r.distance).toBe(0)
  })

  it('pénalise une substitution franche selon la longueur', () => {
    // 8 caractères compacts, une substitution de coût plein : 1 - 1/8
    const r = plateScore('CI 8842 KB', 'CI 8843 KB')
    expect(r.exact).toBe(false)
    expect(r.score).toBeCloseTo(0.875, 3)
    expect(r.distance).toBe(DEFAULT_SUB_COST)
  })

  it('refuse une plaque vide', () => {
    expect(plateScore('', 'CI 8842 KB').score).toBe(0)
    expect(plateScore('CI 8842 KB', '').score).toBe(0)
  })

  it('applique la remise apprise quand la paire est connue', () => {
    const learning = { pairBoost: { 'CI4A71AB>CIAA71AB': 0.4 } }
    const sans = plateScore('CI 4A71 AB', 'CI AA71 AB')
    const avec = plateScore('CI 4A71 AB', 'CI AA71 AB', learning)
    expect(avec.score).toBeGreaterThan(sans.score)
    expect(avec.boosted).toBe(true)
    expect(sans.boosted).toBe(false)
  })
})

describe('rankPlates', () => {
  it('classe par score décroissant et respecte la limite', () => {
    const entries = [
      { plate: 'CI 8843 KB', kind: 'ticket' },
      { plate: 'CI 8842 KB', kind: 'ticket' },
      { plate: 'ZZ 0000 ZZ', kind: 'ticket' },
    ]
    const r = rankPlates('CI 8842 KB', entries)
    expect(r[0].entry.plate).toBe('CI 8842 KB')
    expect(r[0].score).toBe(1)
    expect(r.length).toBeLessThanOrEqual(6)
  })

  it('renvoie un tableau vide pour une lecture vide', () => {
    expect(rankPlates('', [{ plate: 'CI 8842 KB', kind: 'ticket' }])).toEqual([])
  })

  it('privilégie un ticket à un véhicule à score égal', () => {
    const r = rankPlates('CI 8842 KB', [
      { plate: 'CI 8842 KB', kind: 'vehicule' },
      { plate: 'CI 8842 KB', kind: 'ticket' },
    ])
    expect(r[0].entry.kind).toBe('ticket')
  })
})

describe('decide', () => {
  const tickets = (n) => Array.from({ length: n }, (_, i) => ({ entry: { plate: `T${i}`, kind: 'ticket' }, score: 0.95, exact: false }))

  it('ouvre directement sur une seule correspondance exacte', () => {
    const d = decide('CI 8842 KB', rankPlates('CI 8842 KB', [{ plate: 'CI 8842 KB', kind: 'ticket' }]))
    expect(d.status).toBe('found')
    expect(d.ticket.plate).toBe('CI 8842 KB')
  })

  it('signale l’ambiguïté quand deux plaques sont identiques', () => {
    const d = decide('CI 8842 KB', rankPlates('CI 8842 KB', [
      { plate: 'CI 8842 KB', kind: 'ticket' },
      { plate: 'CI8842KB', kind: 'ticket' },
    ]))
    expect(d.status).toBe('ambiguous')
    expect(d.ticket).toBeNull()
  })

  it('signale l’ambiguïté entre deux scores très proches', () => {
    const d = decide('CI 8842 KB', tickets(2))
    expect(d.status).toBe('ambiguous')
  })

  it('ne trouve rien en dessous du seuil faible', () => {
    const d = decide('ZZ 9999 ZZ', rankPlates('ZZ 9999 ZZ', [{ plate: 'AA 1111 AA', kind: 'ticket' }]))
    expect(d.status).toBe('none')
  })

  it('expose des seuils cohérents', () => {
    expect(WEAK).toBeLessThan(STRONG)
    expect(AMBIGUOUS_GAP).toBeGreaterThan(0)
    expect(CLASS_SUB_COST).toBeLessThan(DEFAULT_SUB_COST)
  })
})
