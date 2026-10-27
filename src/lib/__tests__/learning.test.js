import { describe, it, expect } from 'vitest'
import { alignPairs, pairCost, plateBoost, aggregate, MIN_COUNT, COST_START, COST_STEP, MIN_COST, BOOST_PER, BOOST_MAX, MAX_EVENTS_KEPT } from '../learning.js'

describe('alignPairs', () => {
  it('extrait la substitution réelle après alignement', () => {
    // « 4 » lu à la place de « A » : la seule paire à retenir.
    expect(alignPairs('CI 4A71 AB', 'CI AA71 AB')).toEqual([{ from: '4', to: 'A' }])
  })

  it('ignore deux plaques identiques', () => {
    expect(alignPairs('CI 8842 KB', 'CI-8842-KB')).toEqual([])
  })

  it('renonce au-delà de deux caractères d’écart', () => {
    expect(alignPairs('ABC', 'ABCDEFG')).toEqual([])
  })

  it('ignore une entrée vide', () => {
    expect(alignPairs('', 'CI AA71 AB')).toEqual([])
  })
})

describe('pairCost', () => {
  it('reste inactive sous le seuil d’occurrences', () => {
    expect(pairCost(0)).toBeNull()
    expect(pairCost(MIN_COUNT - 1)).toBeNull()
  })

  it('démarre au coût initial puis décroît', () => {
    expect(pairCost(MIN_COUNT)).toBe(COST_START)
    expect(pairCost(MIN_COUNT + 1)).toBeCloseTo(COST_START - COST_STEP, 3)
  })

  it('ne descend jamais sous le plancher', () => {
    expect(pairCost(100)).toBe(MIN_COST)
  })
})

describe('plateBoost', () => {
  it('n’accorde rien sous le seuil', () => {
    expect(plateBoost(1)).toBe(0)
  })

  it('croît avec les confirmations puis plafonne', () => {
    expect(plateBoost(2)).toBeCloseTo(BOOST_PER * 2, 3)
    expect(plateBoost(1000)).toBe(BOOST_MAX)
  })
})

describe('aggregate', () => {
  it('compte les paires et produit des coûts exploitables', () => {
    const events = [
      { raw: 'CI 4A71 AB', chosen: 'CI AA71 AB', pairs: ['4>A'] },
      { raw: 'CI 4A71 AB', chosen: 'CI AA71 AB', pairs: ['4>A'] },
      { raw: 'CI 4A71 AB', chosen: 'CI AA71 AB', pairs: ['4>A'] },
    ]
    const l = aggregate(events)
    // aggregate() renvoie { from, to, count, active, cost } et l'objet `costs`.
    expect(l.pairs[0].from).toBe('4')
    expect(l.pairs[0].to).toBe('A')
    expect(l.pairs[0].count).toBe(3)
    expect(l.pairs[0].active).toBe(true)
    expect(l.costs['4>A']).toBeLessThan(COST_START)
    expect(l.pairBoost['CI4A71AB>CIAA71AB']).toBeGreaterThan(0)
  })

  it('reste vide sans événement', () => {
    const l = aggregate([])
    expect(l.pairs).toEqual([])
    expect(l.costs).toEqual({})
    expect(l.counts.events).toBe(0)
  })

  it('ne compte qu’une fois une paire répétée dans un même événement', () => {
    const l = aggregate([{ raw: 'CI 4A71 AB', chosen: 'CI AA71 AB', pairs: ['4>A', '4>A'] }])
    expect(l.pairs[0].count).toBe(1)
  })

  it('borne la mémoire des événements', () => {
    expect(MAX_EVENTS_KEPT).toBeGreaterThan(0)
    expect(MAX_EVENTS_KEPT).toBeLessThanOrEqual(5000)
  })
})
