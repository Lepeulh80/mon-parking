import { describe, it, expect } from 'vitest'
import { allowedType, mediaKey, r2Config, newKeyId } from '../../../server/r2.mjs'

describe('formats acceptés', () => {
  it('accepte les quatre formats annoncés', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'IMAGE/JPEG', 'image/jpeg; charset=binary'])
      expect(allowedType(t)).toBe(true)
  })
  it('refuse ce qui n’est pas une image bitmap autorisée', () => {
    for (const t of ['image/svg+xml', 'image/gif', 'application/pdf', '', null, undefined])
      expect(allowedType(t)).toBe(false)
  })
})

describe('clé d’objet', () => {
  it('préfixe par parking et véhicule, extension selon le type', () => {
    expect(mediaKey('L1', 'V1', 'image/png', 'abc')).toBe('lots/L1/vehicles/V1/abc.png')
    expect(mediaKey('L1', 'V1', 'image/webp', 'abc')).toBe('lots/L1/vehicles/V1/abc.webp')
  })
  it('neutralise les séparateurs et les traversées de chemin', () => {
    const key = mediaKey('../../etc', 'V1/../..', 'image/jpeg', 'a/b')
    expect(key.startsWith('lots/etc/vehicles/V1')).toBe(true)
    expect(key.includes('..')).toBe(false)
    // lots / <parking> / vehicles / <vehicule> / <objet> : cinq segments
    expect(key.split('/').length).toBe(5)
  })
  it('ajoute une empreinte stable et non devinable quand fournie', () => {
    const a = mediaKey('L', 'V', 'image/jpeg', 'id', 'photo-1.jpg')
    const b = mediaKey('L', 'V', 'image/jpeg', 'id', 'photo-1.jpg')
    const c = mediaKey('L', 'V', 'image/jpeg', 'id', 'photo-2.jpg')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^lots\/L\/vehicles\/V\/id-[0-9a-f]{12}\.jpg$/)
  })
})

describe('configuration', () => {
  it('reste désactivée si un des quatre secrets manque', () => {
    expect(r2Config({})).toBeNull()
    expect(r2Config({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' })).toBeNull()
    expect(r2Config({ R2_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c', R2_BUCKET: '  ' })).toBeNull()
  })
  it('active le stockage avec les quatre valeurs et normalise l’URL publique', () => {
    const cfg = r2Config({ R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'sec', R2_BUCKET: 'mon-parking', R2_PUBLIC_URL: 'https://cdn.example.test//' })
    expect(cfg).toMatchObject({ account: 'acc', bucket: 'mon-parking', publicUrl: 'https://cdn.example.test' })
  })
  it('génère des identifiants d’objet distincts', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newKeyId()))
    expect(ids.size).toBe(50)
  })
})
