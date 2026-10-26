/**
 * MON PARKING — Persistance de l'apprentissage OCR.
 *
 * Les confirmations d'opérateur sont stockées dans IndexedDB (table
 * `ocrFeedback`, Dexie v4), donc locales à l'appareil et disponibles hors
 * ligne. L'agrégation en coûts est recalculée à la volée par `learning.js`.
 */
import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, nowIso } from './db.js'
import { compact } from './plate.js'
import { aggregate, alignPairs, serializeLearning } from './learning.js'
import { newUuid, getPosteId, flushOutbox, muteRemote, startOcrSync, withFeedbackLock, uuidOf } from './ocrSync.js'

/**
 * Enregistre une confirmation / correction d'opérateur.
 *
 * @param {object} p
 * @param {string} p.lotId    parking concerné (l'apprentissage est par parking)
 * @param {string} p.raw      texte réellement lu par l'OCR
 * @param {string} p.chosen   plaque finalement retenue
 * @param {string[]} p.rejected autres plaques proposées, écartées
 * @param {'suggestion'|'correction'} p.source
 */
export async function recordFeedback({ lotId, userId, userName, raw, chosen, rejected = [], source = 'suggestion' }) {
  if (!lotId || !chosen) return null
  const rawText = String(raw || '')
  const rawCompact = compact(rawText)
  const chosenCompact = compact(chosen)

  // Lecture correcte et aucune suggestion retenue : rien à apprendre.
  if (source !== 'suggestion' && rawCompact === chosenCompact) return null
  if (!chosenCompact) return null

  // UUID généré ici : c'est la clé primaire distante, donc l'idempotence de
  // l'envoi. Un rejeu après coupure réseau ne peut pas créer de doublon.
  const uuid = newUuid()
  const event = {
    id: uuid,
    uuid,
    lotId,
    at: nowIso(),
    userId: userId || null,
    userName: userName || '',
    raw: rawText.slice(0, 120),
    rawCompact,
    chosen: String(chosen),
    chosenCompact,
    rejected: (rejected || []).filter(Boolean).map(String).slice(0, 6),
    source,
    pairs: alignPairs(rawText, chosen).map((p) => `${p.from}>${p.to}`),
    posteId: getPosteId(),
    synced: 0, // en file d'attente tant que Supabase ne l'a pas reçu
    createdAt: nowIso(),
  }

  await db.ocrFeedback.add(event)

  // Envoi opportuniste : ne bloque jamais la saisie, et échoue en silence
  // (le mode local reste pleinement fonctionnel).
  flushOutbox(lotId).catch((e) => console.warn('ocr sync', e.message))

  // No automatic event deletion: all stations must converge on the same
  // shared history. In particular, never discard unsent offline events.
  return event
}

/** Hook : événements + coûts appris pour un parking. */
export function useOcrLearning(lotId) {
  useEffect(() => startOcrSync(lotId), [lotId])
  const events = useLiveQuery(
    () => (lotId ? db.ocrFeedback.where('lotId').equals(lotId).toArray() : Promise.resolve([])),
    [lotId],
    [],
  )
  return useMemo(() => ({ events, ...aggregate(events) }), [events])
}

/** Supprime tout l'apprentissage d'un parking. */
export async function resetLearning(lotId) {
  if (!lotId) return 0
  return withFeedbackLock(lotId, async () => {
    const rows = await db.ocrFeedback.where('lotId').equals(lotId).toArray()
    if (rows.length) await muteRemote(lotId, rows.map(uuidOf))
    await db.ocrFeedback.where('lotId').equals(lotId).delete()
    return rows.length
  })
}

/** Export JSON des événements (sauvegarde ou analyse externe). */
export function exportLearning(events, meta = {}) {
  return serializeLearning(events, meta)
}

/** Télécharge l'export dans le navigateur. */
export function downloadLearning(events, meta = {}) {
  const json = exportLearning(events, meta)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `apprentissage-ocr-${meta.lotName ? meta.lotName.replace(/\s+/g, '-').toLowerCase() : 'parking'}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  return json
}
