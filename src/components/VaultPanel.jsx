import { useEffect, useMemo, useState } from 'react'
import {
  Lock, Unlock, ShieldCheck, ShieldAlert, KeyRound, Timer, Loader2, RefreshCw, Info,
} from 'lucide-react'
import { Card, CardHead, Badge, Field, Input, useToast, Select } from './UI'
import {
  vaultStatus, createVault, unlockVault, lockVault, checkAutoLock, setAutoLockMinutes,
  isUnlocked, assertPassphrase, AUTO_LOCK_MINUTES,
} from '../lib/photoCrypto'
import { sealExistingMedia } from '../lib/photos'
import { useApp } from '../App'

// Panneau du coffre de chiffrement des photos d'un parking.
// Le message le plus important est celui des limites : un chiffrement présenté
// comme absolu est un mensonge qui coûte cher le jour de l'incident.
export default function VaultPanel() {
  const { lot } = useApp()
  const toast = useToast()
  const [status, setStatus] = useState({ exists: false, unlocked: false })
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [minutes, setMinutes] = useState(AUTO_LOCK_MINUTES)
  const [sealing, setSealing] = useState(null)

  const refresh = () => vaultStatus(lot?.id).then(setStatus)
  useEffect(() => { refresh() }, [lot?.id])

  // Verrouillage automatique : un timer plutôt qu'un écouteur d'événements
  // uniquement, sinon un poste laissé ouvert sans interaction reste déverrouillé.
  useEffect(() => {
    setAutoLockMinutes(minutes)
    if (!status.unlocked || !minutes) return undefined
    // `touch()` est appelé par photos.js à chaque lecture de média : le compteur
    // d'inactivité suit donc l'usage réel, pas seulement les clics du panneau.
    const id = setInterval(() => {
      if (checkAutoLock()) {
        setStatus((prev) => ({ ...prev, unlocked: false }))
        toast.info('Coffre verrouillé automatiquement après inactivité.')
        refresh()
      }
    }, 15000)
    return () => clearInterval(id)
  }, [minutes, status.unlocked, toast])

  const strength = useMemo(() => {
    const value = passphrase
    let score = 0
    if (value.length >= 12) score++
    if (value.length >= 16) score++
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++
    if (/\d/.test(value) && /[^\w\s]/.test(value)) score++
    return score
  }, [passphrase])

  const create = async (event) => {
    event.preventDefault()
    setError('')
    if (passphrase !== confirm) { setError('Les deux phrases ne correspondent pas.'); return }
    setBusy(true)
    try {
      assertPassphrase(passphrase)
      await createVault(lot.id, passphrase)
      setPassphrase(''); setConfirm('')
      await refresh()
      toast.ok('Coffre créé : les nouvelles photos seront chiffrées.')
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  const unlock = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await unlockVault(lot.id, passphrase)
      setPassphrase('')
      await refresh()
      toast.ok('Coffre déverrouillé.')
    } catch (err) { setError(err.message) }
    setBusy(false)
  }

  const seal = async () => {
    setSealing({ running: true })
    try {
      const result = await sealExistingMedia(lot.id)
      setSealing(result)
      toast.ok(`${result.sealed} média(s) chiffré(s)${result.skipped ? `, ${result.skipped} ignoré(s)` : ''}.`)
    } catch (err) { setSealing({ error: err.message }); toast.err(err.message) }
  }

  if (!lot) return null

  return (
    <Card>
      <CardHead
        title="Coffre des photos de véhicules"
        icon={status.unlocked ? Unlock : Lock}
        sub="AES-256-GCM dans le navigateur, clé protégée par une phrase de coffre"
        right={<Badge tone={!status.exists ? 'warn' : status.unlocked ? 'ok' : 'default'} dot>
          {!status.exists ? 'Non configuré' : status.unlocked ? 'Déverrouillé' : 'Verrouillé'}
        </Badge>}
      />

      <div className="alert-inline" style={{ marginBottom: 14 }}>
        <Info style={{ width: 14, height: 14 }} />
        <span>
          <b>Ce que ce chiffrement protège :</b> les photos et leurs vignettes stockées dans la base
          locale (vol d’appareil, copie de la base, sauvegarde). <b>Ce qu’il ne protège pas :</b> un
          appareil déverrouillé avec l’application ouverte — la clé est alors en mémoire. Une phrase
          de coffre perdue rend les photos irrécupérables : il n’existe aucune clé de secours.
        </span>
      </div>

      {!status.exists && (
        <form onSubmit={create} className="stack" style={{ gap: 12, maxWidth: 460 }}>
          <Field label="Phrase de coffre (12 caractères minimum)">
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password" placeholder="une phrase longue et unique" />
          </Field>
          <Field label="Confirmation">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </Field>
          <div className="row" style={{ gap: 6 }}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} style={{ height: 4, flex: 1, borderRadius: 2, background: i < strength ? (strength >= 3 ? 'var(--acc-2)' : 'var(--acc)') : 'rgba(255,255,255,0.1)' }} />
            ))}
            <span className="tiny mut" style={{ minWidth: 90, textAlign: 'right' }}>
              {strength >= 3 ? 'solide' : strength === 2 ? 'correcte' : 'faible'}
            </span>
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</div>}
          <button className="btn btn-primary" disabled={busy || passphrase.length < 12}>
            {busy ? <Loader2 className="spin" style={{ width: 15, height: 15 }} /> : <KeyRound style={{ width: 15, height: 15 }} />}
            Créer le coffre
          </button>
        </form>
      )}

      {status.exists && !status.unlocked && (
        <form onSubmit={unlock} className="stack" style={{ gap: 12, maxWidth: 420 }}>
          <Field label="Phrase de coffre">
            <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus autoComplete="current-password" />
          </Field>
          {error && <div style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</div>}
          <button className="btn btn-primary" disabled={busy || !passphrase}>
            {busy ? <Loader2 className="spin" style={{ width: 15, height: 15 }} /> : <Unlock style={{ width: 15, height: 15 }} />}
            Déverrouiller
          </button>
          <p className="tiny mut" style={{ margin: 0 }}>
            Les photos restent visibles sous forme de vignette « coffre verrouillé » tant que la clé
            n’est pas fournie. Les ajouts de photos sont chiffrés automatiquement quand le coffre est ouvert.
          </p>
        </form>
      )}

      {status.exists && status.unlocked && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={() => { lockVault(lot.id); refresh(); }}>
              <Lock style={{ width: 15, height: 15 }} /> Verrouiller maintenant
            </button>
            <button className="btn btn-ghost" onClick={seal} disabled={sealing?.running}>
              {sealing?.running ? <Loader2 className="spin" style={{ width: 15, height: 15 }} /> : <RefreshCw style={{ width: 15, height: 15 }} />}
              Chiffrer les photos existantes
            </button>
            <span className="spacer" />
            <span className="tiny mut" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Timer style={{ width: 13, height: 13 }} /> Verrouillage auto
            </span>
            <Select value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} style={{ maxWidth: 150 }}>
              <option value="1">1 minute</option>
              <option value="5">5 minutes</option>
              <option value="10">10 minutes</option>
              <option value="30">30 minutes</option>
              <option value="0">Jamais</option>
            </Select>
          </div>
          {sealing && !sealing.running && !sealing.error && (
            <p className="tiny mut" style={{ margin: 0 }}>
              {sealing.sealed} média(s) chiffré(s), {sealing.skipped} déjà chiffré(s) ou ignoré(s).
            </p>
          )}
          {isUnlocked(lot.id) && (
            <p className="tiny mut" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck style={{ width: 13, height: 13, color: 'var(--acc-2)' }} />
              Clé en mémoire pour cet onglet uniquement — jamais écrite sur disque.
            </p>
          )}
        </div>
      )}

      {status.exists && !status.unlocked && (
        <p className="tiny mut" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          <ShieldAlert style={{ width: 13, height: 13, color: 'var(--warn)' }} />
          Coffre fermé : les images chiffrées ne peuvent pas être affichées ni exportées.
        </p>
      )}
    </Card>
  )
}
